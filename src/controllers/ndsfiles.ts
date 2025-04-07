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

// 定义内存阈值常量
const REDIS_HIGH_MEMORY_THRESHOLD = 90;  // 高内存阈值



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
         * @returns 时间映射
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
    
    public static async filterFiles(req: Request, res: Response): Promise<void> {
        /**
         * 过滤NDS文件
         * @returns 过滤后的NDS文件
         */
        try {
            const { ndsId, data_type, file_paths } = req.body; // 获取请求体参数
            if (!ndsId || !data_type || !Array.isArray(file_paths) || file_paths.length === 0) {
                res.badRequest('参数错误');
                return;    
            }
            // 检查Redis状态,如果负荷过高，取消处理
            const memoryInfo = await redis.getMemoryInfo();
            const isMemoryHigh = memoryInfo.ratio >= REDIS_HIGH_MEMORY_THRESHOLD;
            if (isMemoryHigh) {
                res.customError('Redis内存负荷过高，无法处理请求', 429);
                return;
            }

            // 使用Redis过滤已存在的文件
            const nonExistingPaths = await redis.filterNonExistingPaths(ndsId, file_paths);
            if (nonExistingPaths.length === 0) {
                res.success([]);
                return;
            }
            
            // 过滤非任务时间文件和数据类型
            const tasks = await mysql.taskList.findMany({
                where: { 
                    status: 0,
                    data_type: data_type // 添加data_type过滤条件
                },
                select: { start_time: true, end_time: true },
                distinct: ['start_time', 'end_time']
            });

            if (tasks.length === 0) {
                res.success([]);
                return;
            }

            // 使用正则表达式提取文件路径中的时间信息
            const timeRegex = /\d{14}/;
            const filteredPaths = nonExistingPaths.reduce<string[]>((acc, path) => {
                const match = path.match(timeRegex);
                if (!match) return acc; // 如果没有匹配到时间信息，跳过
                const timeStr = match[0];
                const fileTime = new Date(
                    parseInt(timeStr.substring(0, 4)), // 年份
                    parseInt(timeStr.substring(4, 6)) - 1, // 月份（JavaScript中的月份从0开始）
                    parseInt(timeStr.substring(6, 8)), // 日期
                    parseInt(timeStr.substring(8, 10)), // 小时
                    parseInt(timeStr.substring(10, 12)), // 分钟
                    parseInt(timeStr.substring(12, 14)) // 秒数
                );
                
                // 检查是否在任务时间范围内, 如果在任务时间范围内，加入结果
                if (tasks.some(item => fileTime >= item.start_time && fileTime <= item.end_time)) {
                    acc.push(path);
                }
                return acc;
            }, []);

            // 返回结果
            res.success(filteredPaths);
            return;

        }catch (error: any) {
            logger.error('过滤NDS文件出错:', error);
            res.internalError('过滤NDS文件出错');
        }

    }

    

}