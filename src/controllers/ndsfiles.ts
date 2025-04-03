/**
 * NDS文件控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';
import crypto from 'crypto';
import redis from '../database/redis'; // 添加redis导入
import redisFlag from '../utils/redisFlag';
import enbTaskMap from '../utils/enbTaskMap';

// 定义NDSFileTask请求体接口
interface NDSFileItem {
    ndsId: number;          // @db.Int
    file_path: string;      // @db.VarChar(255)
    file_time: Date;        // @db.DateTime
    data_type: string;      // @db.VarChar(64)
    sub_file_name: string;  // @db.VarChar(255)
    header_offset: number;  // @db.Int
    compress_size: number;  // @db.Int
    file_size: number;     // @db.Int
    flag_bits: number;     // @db.Int
    enodebid: string;      // @db.VarChar(16)
}

// 定义NDSFileWithTask接口,用于存储从MySQL中查询出来的结果
interface NDSFileWithTask { 
    file_hash: string;      // @db.VarChar(128)
    ndsId: number;          // @db.Int
    file_path: string;      // @db.VarChar(255)
    file_time: Date;        // @db.DateTime
    data_type: string;      // @db.VarChar(64)
    sub_file_name: string;  // @db.VarChar(255)
    header_offset: number;  // @db.Int
    compress_size: number;  // @db.Int
    file_size: number;      // @db.Int
    flag_bits: number;      // @db.Int
    enodebid: string;      // @db.VarChar(16)
    parsed: number;         // @db.Int
    createdAt: Date;        // @db.DateTime
    updatedAt: Date;        // @db.DateTime
}


export class NDSFileController { // NDSFile任务控制类
    private static generateFileHash(ndsId: number, file_path: string, sub_file_name: string): string {
        /**
         * 生成文件哈希值
         * @param ndsId NDS ID
         * @param file_path 文件路径
         * @param sub_file_name 子文件名                                                                                                                           
         * @returns 哈希值
         */
        const data = `${ndsId}${file_path}${sub_file_name}`;
        return crypto.createHash('md5').update(data).digest('hex');
    }

    public static async getTasksTimeMap(_req: Request, res: Response): Promise<void> {
        /**
         * 获取所有NDS文件的时间映射
         * @param req 请求
         * @param res 响应
        */
        try { 
            // 从mysql.taskList表中查询所有任务时间并去重
            const time_maps = await mysql.taskList.findMany({
                where: { status: 0 },
                select: { start_time: true, end_time: true },
                distinct: ['start_time', 'end_time']
            });
            // 返回结果
            res.success(time_maps);
            
            
        }catch (error: any) {
            logger.error('获取任务时间范围出错:', error);
            res.internalError('获取任务时间范围出错');
        }
    }

    

}