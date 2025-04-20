/**
 * 配置接口内容
 */
import { Request, Response } from 'express';
import logger from '../utils/logger';

interface ConfigItem {
    key: string;
    value: string; 
}

export class ConfigReader {
    /**
     * 获取配置信息
     * @param req 请求对象
     * @param res 响应对象
     * @returns 配置信息
    */

    public async getConfig(req: Request, res: Response): Promise<void> {
        
    }
}