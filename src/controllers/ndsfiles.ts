/**
 * NDS文件控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';
import crypto from 'crypto';
import redis from '../database/redis'; // 添加redis导入


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

// 定义Celldata状态接口
interface CellDataState {
    enbids: { eNodeBID: number }[];  // 存储Celldata中的eNodeBID
    lastRefreshTime: Date;           // 上次刷新时间
}

const cellDataState: CellDataState = {
    enbids: [],
    lastRefreshTime: new Date()
};

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
                if (tasks.some(item => fileTime.getTime() >= item.start_time.getTime() && fileTime.getTime() <= item.end_time.getTime())) {
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

    public static async batchAddTasks(req: Request, res: Response): Promise<void> {
        /**
         * 批量添加NDS文件任务
         * @returns 添加结果
         */
        try {
            const items: NDSFileItem[] = req.body;
            if (!Array.isArray(items) || items.length === 0) {
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
            // 转换数据类型并处理无效日期
            const itemsWithTypes = items.map(item => {
                // 处理日期：尝试从file_path中提取日期，如果无法提取则使用当前日期
                let file_time = new Date(item.file_time);
                
                // 检查日期是否有效
                if (isNaN(file_time.getTime())) {
                    // 尝试从文件路径中提取日期 (格式如 /MR/MRO/2025-04-07/FDD-LTE_MRO_ZTE_OMC1_20250407084500.zip)
                    const timeRegex = /\d{14}/;
                    const match = item.file_path.match(timeRegex);
                    
                    if (match) {
                        const timeStr = match[0];
                        file_time = new Date(
                            parseInt(timeStr.substring(0, 4)),    // 年份
                            parseInt(timeStr.substring(4, 6)) - 1, // 月份（JavaScript中的月份从0开始）
                            parseInt(timeStr.substring(6, 8)),    // 日期
                            parseInt(timeStr.substring(8, 10)),   // 小时
                            parseInt(timeStr.substring(10, 12)),  // 分钟
                            parseInt(timeStr.substring(12, 14))   // 秒数
                        );
                    } else {
                        // 如果无法从文件名提取，则使用当前日期
                        file_time = new Date();
                        logger.warn(`无法解析文件时间，使用当前时间作为替代: ${item.file_path}`);
                    }
                }
                
                return {
                    ...item,
                    ndsId: Number(item.ndsId),
                    header_offset: Number(item.header_offset),
                    compress_size: Number(item.compress_size),
                    file_size: Number(item.file_size),
                    flag_bits: Number(item.flag_bits),
                    file_time: file_time
                };
            });

            // 获取有效的任务列表
            const validTasks = await mysql.enbTaskList.findMany({
                where: {
                    parsed: 0,
                    status: 0
                }
            });

            // 生成文件哈希并预先确定parsed值
            const itemsWithHash = itemsWithTypes.map(item => {
                // 检查是否符合任务条件
                const isValidForTask = validTasks.some(task => 
                    item.enodebid === task.enodebid &&
                    item.data_type === task.data_type &&
                    item.file_time >= task.start_time &&
                    item.file_time <= task.end_time
                );
                
                return {
                    ...item,
                    file_hash: NDSFileController.generateFileHash(item.ndsId, item.file_path, item.sub_file_name),
                    parsed: isValidForTask ? 1 : 0  // 符合任务条件的直接设置为1，否则为0
                };
            });
            // 先调用batchScanEnqueue记录所有file_path, 形成扫描记录
            await redis.batchScanEnqueue(itemsWithHash.map(item => ({
                NDSID: item.ndsId,
                data: {
                    file_path: item.file_path
                }
            })));

            // 匹配CellData表，过滤掉不存在的eNodeBID记录

            // 判断是否需要刷新CellData表（超过10分钟则进行刷新）
            if (cellDataState.enbids.length === 0 || cellDataState.lastRefreshTime.getTime() + 600000 < Date.now()) {
                cellDataState.enbids = await mysql.cellData.findMany({select: { eNodeBID: true},distinct: ['eNodeBID']});
                cellDataState.lastRefreshTime = new Date();
            }
            

            // 创建CellData中的eNodeBID集合
            const validEnodebIdSet = new Set(cellDataState.enbids.map(item => item.eNodeBID.toString()));
            
            // 过滤掉不存在于CellData表中的记录
            const filteredItems = itemsWithHash.filter(item => validEnodebIdSet.has(item.enodebid));
            
            if (filteredItems.length === 0) {
                res.success('没有有效的记录，所有eNodeBID在CellData表中不存在');
                return;
            }

            // 使用事务确保数据一致性
            await mysql.$transaction(async (tx) => {
                // 过滤掉非数据库模型字段，只保留与ndsFileList模型匹配的字段
                const dbModelItems = filteredItems.map(item => ({
                    file_hash: item.file_hash,
                    ndsId: item.ndsId,
                    file_path: item.file_path,
                    file_time: item.file_time,
                    data_type: item.data_type,
                    sub_file_name: item.sub_file_name,
                    header_offset: item.header_offset,
                    compress_size: item.compress_size,
                    file_size: item.file_size,
                    flag_bits: item.flag_bits,
                    enodebid: item.enodebid,
                    parsed: item.parsed
                }));
                
                // 批量插入所有数据到MySQL（已存在的会被跳过）
                const result = await tx.ndsFileList.createMany({
                    data: dbModelItems,
                    skipDuplicates: true  // 跳过已存在的记录
                });

                // 过滤出符合任务条件的记录（parsed=1的记录）
                const validItems = filteredItems.filter(item => item.parsed === 1);

                // 如果有符合条件的记录，则添加到Redis
                if (validItems.length > 0) {
                    try {
                        // 添加到Redis队列
                        await redis.batchTaskEnqueue(validItems.map(item => ({
                            NDSID: item.ndsId,
                            data: {
                                ndsId: item.ndsId,
                                file_path: item.file_path,
                                file_time: item.file_time.toISOString(),
                                data_type: item.data_type,
                                sub_file_name: item.sub_file_name,
                                header_offset: item.header_offset,
                                compress_size: item.compress_size,
                                file_size: item.file_size,
                                flag_bits: item.flag_bits,
                                enodebid: item.enodebid,
                                file_hash: item.file_hash
                            }
                        })));
                    } catch (error) {
                        logger.error('Redis入队失败，回滚MySQL状态:', error);
                        // 删除redis中的数据
                        await redis.batchScanDequeue(validItems.map(item => ({
                            NDSID: item.ndsId,
                            data: {
                                file_path: item.file_path
                            }
                        })));
                        throw error;  // 触发事务回滚
                    }
                }

                return {
                    total: result.count,
                    filtered: filteredItems.length,
                    original: itemsWithHash.length,
                    valid: validItems.length,
                    queued: validItems.length
                };
            }).then(result => res.success(result));


        }catch (error: any) {
            logger.error('批量添加NDS文件任务出错:', error);
            res.internalError(`批量添加NDS文件任务出错 ${error}`);
        }
    }

    public static async updateCellDataState(_req: Request, res: Response): Promise<void> {
        /**
         * 更新CellData状态
         * @returns 更新结果
         */ 
        try {
            cellDataState.enbids = await mysql.cellData.findMany({
                select: {
                    eNodeBID: true
                },
                distinct: ['eNodeBID']
            });
            cellDataState.lastRefreshTime = new Date();
        }catch (error: any) {
            logger.error('缓存eNodeBID出错:', error);
            res.internalError('缓存eNodeBID出错');
        }
    }
    

}