/*********************************************************************************************************************
 *  Copyright Amazon.com Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/
import { injectable, inject } from 'inversify';
import { DeviceTaskSummary, DeviceItem} from './devices.models';
import { TYPES } from '../di/types';
import {logger} from '../utils/logger.util';
import { DevicesDao } from './devices.dao';
import ow from 'ow';
import AWS = require('aws-sdk');
import shortid from 'shortid';
import { GroupsDao } from '../groups/groups.dao';
import { GroupItem } from '../groups/groups.models';
import { GreengrassUtils } from '../utils/greengrass.util';
import {DeviceAssociationModel} from './handlers/models';
import {CreateGroupVersionHandler} from './handlers/createGroupVersion.handler';
import {ExistingAssociationHandler} from './handlers/existingAssociation.handler';
import {GetPrincipalHandler} from './handlers/getPrincipal.handler';
import {GetThingHandler} from './handlers/getThing.handler';
import {ProvisionThingHandler} from './handlers/provisonThing.handler';
import {SaveGroupHandler} from './handlers/saveGroup.handler';
import {CoreConfigHandler} from './handlers/coreConfig.handler';
import { TemplateItem } from '../templates/templates.models';
import { TemplatesDao } from '../templates/templates.dao';

@injectable()
export class DevicesService  {

    private sqs: AWS.SQS;

    constructor(
        @inject('aws.sqs.deviceAssociations') private deviceAssociationQueue:string,
        @inject(TYPES.DevicesDao) private devicesDao: DevicesDao,
        @inject(TYPES.GroupsDao) private groupsDao: GroupsDao,
        @inject(TYPES.TemplatesDao) private templatesDao: TemplatesDao,
        @inject(TYPES.GreengrassUtils) private ggUtils: GreengrassUtils,
        @inject(TYPES.CreateGroupVersionDeviceAssociationHandler) private createGroupVersionHandler: CreateGroupVersionHandler,
        @inject(TYPES.ExistingAssociationDeviceAssociationHandler) private existingAssociationHandler: ExistingAssociationHandler,
        @inject(TYPES.GetPrincipalDeviceAssociationHandler) private getPrincipalHandler: GetPrincipalHandler,
        @inject(TYPES.GetThingDeviceAssociationHandler1) private getThingHandler1: GetThingHandler,
        @inject(TYPES.GetThingDeviceAssociationHandler2) private getThingHandler2: GetThingHandler,
        @inject(TYPES.CoreConfigHandler) private coreConfigHandler: CoreConfigHandler,
        @inject(TYPES.ProvisionThingDeviceAssociationHandler) private provisionThingHandler: ProvisionThingHandler,
        @inject(TYPES.SaveGroupDeviceAssociationHandler) private saveGroupHandler: SaveGroupHandler,
        @inject(TYPES.SQSFactory) sqsFactory: () => AWS.SQS) {
            this.sqs = sqsFactory();

            // define the chain
            // note: this class turned out to be complex, therefore its functionality was
            // broken down into a chain of responsibility to improve testability
            this.getThingHandler1
                .setNext(this.existingAssociationHandler)
                .setNext(this.provisionThingHandler)
                .setNext(this.getThingHandler2)
                .setNext(this.coreConfigHandler)
                .setNext(this.getPrincipalHandler)
                .setNext(this.createGroupVersionHandler)
                .setNext(this.saveGroupHandler);
        }

    public async createDeviceAssociationTask(groupName:string, items: DeviceItem[]) : Promise<DeviceTaskSummary> {
        logger.debug(`devices.service createDeviceAssociationTask: in: groupName:${groupName}, items:${JSON.stringify(items)}`);

        ow(groupName, ow.string.nonEmpty);
        ow(items, 'Devices', ow.array.nonEmpty.minLength(1));

        for(const device of items) {
            ow(device.thingName, ow.string.nonEmpty);
            ow(device.type, ow.string.nonEmpty);
            ow(device.provisioningTemplate, ow.string.nonEmpty);
        }

        // ensure the group exists
        const groupItem = await this.getGroupItem(groupName);
        await this.ggUtils.getGroupInfo(groupItem.id);

        const taskId = shortid.generate();

        const taskInfo:DeviceTaskSummary = {
            taskId,
            groupName,
            status: 'Waiting',
            createdAt: new Date(),
            updatedAt: new Date(),
            devices: items.map(d=> {
                return {...d, status:'Waiting'};
            })
        };

        await this.devicesDao.saveDeviceAssociationTask(taskInfo);

        await this.sqs.sendMessage({
            QueueUrl: this.deviceAssociationQueue,
            MessageBody: JSON.stringify(taskInfo),
            MessageAttributes: {
                messageType: {
                    DataType: 'String',
                    StringValue: DeviceTaskSummary.name
                }
            }
        }).promise();

        logger.debug(`devices.service createDeviceAssociationTask: exit: taskInfo:${JSON.stringify(taskInfo)}`);
        return taskInfo;
    }

    public async associateDevicesWithGroup(taskInfo: DeviceTaskSummary) : Promise<void> {
        logger.debug(`devices.service associateDevicesWithGroup: in: taskInfo:${JSON.stringify(taskInfo)}`);

        ow(taskInfo, ow.object.nonEmpty);
        ow(taskInfo.taskId, ow.string.nonEmpty);
        ow(taskInfo.groupName, ow.string.nonEmpty);
        ow(taskInfo.devices, 'Devices', ow.array.minLength(1));

        // retrieve the greengrass info
        const group = await this.getGroupItem(taskInfo.groupName);
        const ggGroup = await this.ggUtils.getGroupInfo(group.id);
        const ggGroupVersion = await this.ggUtils.getGroupVersionInfo(ggGroup.Id, ggGroup.LatestVersion);
        const [ggCoreVersion, ggDeviceVersion, template] = await Promise.all([
            this.ggUtils.getCoreInfo(ggGroupVersion.CoreDefinitionVersionArn),
            this.ggUtils.getDeviceInfo(ggGroupVersion.DeviceDefinitionVersionArn),
            this.getTemplateItem(group.templateName, group.templateVersionNo)]);

        // mark as in progress
        taskInfo.status = 'InProgress';
        taskInfo.devices.forEach(d=> d.status='InProgress');

        // execute the chain
        const request:DeviceAssociationModel = {
            taskInfo, group, ggGroup, ggCoreVersion, ggDeviceVersion, ggGroupVersion, template
        };

        try {
            await this.getThingHandler1.handle(request);
        } catch (err) {
            // something unexpected went wrong with the pipeline
            if (request.group.taskStatus!=='Failure') {
                request.group.taskStatus='Failure';
                request.group.statusMessage=err.message;
            }
            this.saveGroupHandler.handle(request);
        }


        logger.debug(`devices.service associateDevicesWithGroup: exit:`);

    }

    private async getGroupItem(groupName: string) : Promise<GroupItem> {
        logger.debug(`devices.service getGroupItem: in: groupName:${groupName}`);
        let group: GroupItem;
        try {
            group = await this.groupsDao.get(groupName);
            if (group===undefined) {
                throw new Error('NOT_FOUND');
            }
        } catch (err) {
            logger.error(`devices.service getGroupItem: err:${err}`);
            throw err;
        }
        logger.debug(`devices.service getGroupItem: exit: ${JSON.stringify(group)}`);
        return group;
    }

    private async getTemplateItem(name: string, versionNo:number) : Promise<TemplateItem> {
        logger.debug(`devices.service getTemplateItem: in: name:${name}, versionNo:${versionNo}`);
        let item: TemplateItem;
        try {
            item = await this.templatesDao.get(name, versionNo);
            if (item===undefined) {
                throw new Error('NOT_FOUND');
            }
        } catch (err) {
            logger.error(`devices.service getTemplateItem: err:${err}`);
            throw err;
        }
        logger.debug(`devices.service getTemplateItem: exit: ${JSON.stringify(item)}`);
        return item;
    }

    public async getDeviceAssociationTask(groupId:string, taskId:string) : Promise<DeviceTaskSummary> {
        logger.debug(`devices.service getDeviceAssociationTask: in: groupId:${groupId}, taskId:${taskId}`);

        ow(taskId, ow.string.nonEmpty);

        const taskInfo = await this.devicesDao.getDeviceAssociationTask(groupId, taskId);

        logger.debug(`devices.service getDeviceAssociationTask: exit: taskInfo:${JSON.stringify(taskInfo)}`);
        return taskInfo;
    }

    public async getDevice(deviceId:string) : Promise<DeviceItem> {
        logger.debug(`devices.service getDevice: in: deviceId:${deviceId}`);

        ow(deviceId, 'deviceId', ow.string.nonEmpty);

        const device = await this.devicesDao.getDevice(deviceId);

        logger.debug(`devices.service getDevice: exit: device:${JSON.stringify(device)}`);
        return device;
    }

}