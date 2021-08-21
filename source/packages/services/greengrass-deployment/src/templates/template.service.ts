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
import ow from 'ow';
import {inject, injectable} from 'inversify';

import { logger } from '../utils/logger';
import { TYPES } from '../di/types';

import { DeploymentTemplateModel, DeploymentTemplatesList } from './template.model';
import { DeploymentTemplatesDao } from './template.dao';

@injectable()
export class DeploymentTemplatesService {
    constructor(
        @inject(TYPES.DeploymentTemplateDao) private deploymentTemplatesDao: DeploymentTemplatesDao
    ) {}

    public async save(template: DeploymentTemplateModel): Promise<void> {
        logger.debug(`templates.service save: in: item: ${JSON.stringify(template)}`);

        ow(template, 'Template Information', ow.object.nonEmpty);
        ow(template.name, ow.string.nonEmpty);
        ow(template.type, ow.string.nonEmpty);
        ow(template.source.type, ow.string.nonEmpty);
        ow(template.source.bucket, ow.string.nonEmpty);
        ow(template.source.prefix, ow.string.nonEmpty);

        const existingTemplate = await this.deploymentTemplatesDao.get(template.name);

        // set remanining data
        const now = new Date();
        template.updatedAt = now;
        if (existingTemplate) {
            template.versionNo = existingTemplate.versionNo+1;
            template.createdAt = existingTemplate.createdAt;
            template.enabled = existingTemplate.enabled ?? existingTemplate.enabled;

        } else {
            template.versionNo = 1;
            template.createdAt = now;
            template.updatedAt = template.createdAt;
            template.enabled = template.enabled ?? true;
        }

        return this.deploymentTemplatesDao.save(template);
    }

    public async get(name: string): Promise<DeploymentTemplateModel> {
        logger.debug(`templates.service get: in name: ${name}`);

        ow(name, ow.string.nonEmpty);

        const template = await this.deploymentTemplatesDao.get(name);

        if(!template) {
            throw new Error('NOT_FOUND');
        }

        logger.debug(`templates.service get: exit: item: ${JSON.stringify(template)}`);
        return template;
    }

    public async list(): Promise<DeploymentTemplatesList> {
          logger.debug(`templates.service list: in:`);

        // retrieve
        const templates = await this.deploymentTemplatesDao.list();

        logger.debug(`templates.service get: exit: items: ${JSON.stringify(templates)}`);
        return templates;

    }

    public async delete(name:string) : Promise<void> {
        logger.debug(`templates.service delete: in: name:${name}`);

        ow(name, ow.string.nonEmpty);

        await this.deploymentTemplatesDao.delete(name);

        logger.debug(`templates.service get: delete:`);
    }
}