/**
 * Swagger 配置
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';

/**
 * 加载指定目录下的所有YAML文件
 * @param docsDir YAML文件目录
 * @returns 合并后的API文档对象
 */
function loadYamlDocs(docsDir: string): Record<string, any> {
    const apiDoc = {
        openapi: '3.0.0',
        info: {
            title: 'MParser Center',
            version: '1.0.0',
            description: 'MParser Center API 文档',
        },
        components: {
            schemas: {}
        },
        paths: {}
    };

    // 读取docs目录下的所有yaml文件
    const files = fs.readdirSync(docsDir);
    for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const filePath = path.join(docsDir, file);
            try {
                const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
                
                // 合并组件
                if (doc.components?.schemas) {
                    apiDoc.components.schemas = {
                        ...apiDoc.components.schemas,
                        ...doc.components.schemas
                    };
                }
                
                // 合并路径
                if (doc.paths) {
                    apiDoc.paths = {
                        ...apiDoc.paths,
                        ...doc.paths
                    };
                }
                
                logger.info(`成功加载API文档: ${file}`);
            } catch (error) {
                logger.error(`加载API文档失败 ${file}:`, error);
            }
        }
    }

    return apiDoc;
}

// 加载所有API文档
const docsDir = path.join(__dirname, '../docs');
const apiDoc = loadYamlDocs(docsDir);

// 导出 OpenAPI 规范
export const swaggerSpec = apiDoc;

// 保存为 JSON 文件
fs.writeFileSync(
    path.join(__dirname, '../../openapi.json'),
    JSON.stringify(apiDoc, null, 2)
);
