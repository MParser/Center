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

// 定义请求体接口
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

// 定义内存阈值常量
const REDIS_HIGH_MEMORY_THRESHOLD = 90;  // 高内存阈值
const REDIS_LOW_MEMORY_THRESHOLD = 50;   // 低内存阈值
const BATCH_SIZE = 10000;                // 批处理大小

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

export class NDSFileController {
    /**
     * 生成文件哈希值
     * @param ndsId NDS ID
     * @param file_path 文件路径
     * @param sub_file_name 子文件名
     * @returns 哈希值
     */
    private static generateFileHash(ndsId: number, file_path: string, sub_file_name: string): string {
        const data = `${ndsId}${file_path}${sub_file_name}`;
        return crypto.createHash('md5').update(data).digest('hex');
    }

    /**
     * 获取指定NDS的文件路径列表（去重）
     */
    static async getFilePaths(req: Request, res: Response): Promise<void> {
        try {
            const ndsId = parseInt(req.params.ndsId);
            if (isNaN(ndsId)) {
                res.badRequest('无效的NDS ID');
                return;
            }

            const filePaths = await mysql.ndsFileList.findMany({
                where: { ndsId },
                select: { file_path: true },
                distinct: ['file_path']
            });

            res.success(
                filePaths.map(item => item.file_path),
                '获取文件路径列表成功'
            );
        } catch (error: any) {
            logger.error('获取文件路径列表失败:', error);
            res.internalError('获取文件路径列表失败');
        }
    }

    /**
     * 过滤文件
     */
    static async filterFiles(req: Request, res: Response): Promise<void> {
        try {
            const {ndsId, file_paths } = req.body;
            if (!Array.isArray(file_paths) || file_paths.length === 0) {
                res.badRequest('请提供有效的文件路径列表');
                return;
            }
            if (isNaN(ndsId)) {
                res.badRequest('无效的NDS ID');
                return;
            }

            // 读取未完成任务的时间范围
            const time_maps = await mysql.enbTaskList.findMany({
                where: { status: 0 },
                select: { start_time: true, end_time: true },
                distinct: ['start_time', 'end_time']
            });

            if (time_maps.length === 0) {
                res.success({ missing: [] }, '没有未完成的任务');
                return;
            }

            // 提取时间并过滤不在任务时间范围内的文件
            const timeRegex = /\d{14}/;
            const filteredPaths = file_paths.reduce<string[]>((acc, path) => {
                const match = path.match(timeRegex);
                if (!match) return acc;

                const timeStr = match[0];
                const fileTime = new Date(
                    parseInt(timeStr.substring(0, 4)),
                    parseInt(timeStr.substring(4, 6)) - 1,
                    parseInt(timeStr.substring(6, 8)),
                    parseInt(timeStr.substring(8, 10)),
                    parseInt(timeStr.substring(10, 12)),
                    parseInt(timeStr.substring(12, 14))
                );
                
                // 检查是否在任务时间范围内
                if (time_maps.some(item => fileTime >= item.start_time && fileTime <= item.end_time)) {
                    acc.push(path);
                }
                return acc;
            }, []);

            if (filteredPaths.length === 0) {
                res.success({ missing: [] }, '没有在任务时间范围内的文件');
                return;
            }

            // 查询数据库中的文件记录,parsed != -1
            const files_map = await mysql.ndsFileList.findMany({
                where: { ndsId, parsed: { not: -1 } },
                select: { file_path: true },
                distinct: ['file_path']
            });

            // 处理已删除和新增的文件
            const existingPathsSet = new Set(files_map.map(f => f.file_path));
            const newFilePathsSet = new Set(file_paths);
            
            // 更新已删除的文件状态
            const deletedPaths = files_map
                .map(f => f.file_path)
                .filter(path => !newFilePathsSet.has(path));

            if (deletedPaths.length > 0) {
                // 分批处理，每批500条
                const batchSize = 500;
                for (let i = 0; i < deletedPaths.length; i += batchSize) {
                    const batch = deletedPaths.slice(i, i + batchSize);
                    await mysql.ndsFileList.updateMany({
                        where: { ndsId, file_path: { in: batch } },
                        data: { parsed: -1 }
                    });
                }
            }

            // 返回在时间范围内且不存在于数据库的文件
            const results = {
                missing: filteredPaths.filter(path => !existingPathsSet.has(path))
            };

            res.success(results, '文件路径检查完成');
        } catch (error: any) {
            logger.error('检查文件路径失败:', error);
            res.internalError('检查文件路径失败');
        }
    }

    /**
     * 批量设置文件为已移除状态
     */
    static async remove(req: Request, res: Response): Promise<void> {
        try {
            const {ndsId, file_paths } = req.body;
            if (!Array.isArray(file_paths) || file_paths.length === 0) {
                res.badRequest('请提供有效的文件路径列表');
                return;
            }

            // 使用事务批量更新
            const result = await mysql.$transaction(async (tx) => {
                const updateResult = await tx.ndsFileList.updateMany({
                    where: {
                        ndsId,
                        file_path: {
                            in: file_paths
                        }
                    },
                    data: {
                        parsed: -1
                    }
                });

                return updateResult;
            });

            res.success({
                updated: result.count
            }, '批量设置文件状态完成');
        } catch (error: any) {
            logger.error('批量设置文件状态失败:', error);
            res.internalError('批量设置文件状态失败');
        }
    }

    /**
     * 批量添加NDS文件记录
     */
    static async batchAdd(req: Request, res: Response): Promise<void> {
        try {
            const items: NDSFileItem[] = req.body;
            
            // 检查Redis内存使用情况
            const memoryInfo = await redis.getMemoryInfo();
            const isMemoryHigh = memoryInfo.ratio >= REDIS_HIGH_MEMORY_THRESHOLD;
            
            if (isMemoryHigh) {
                redisFlag.setFlag(true);
                logger.info('Redis内存使用率过高，设置全局标记为1');
            }

            // 获取有效的任务列表
            const validTasks = await mysql.enbTaskList.findMany({
                where: {
                    parsed: 0,
                    status: 0
                }
            });

            // 转换数据类型
            const itemsWithTypes = items.map(item => ({
                ...item,
                ndsId: Number(item.ndsId),
                header_offset: Number(item.header_offset),
                compress_size: Number(item.compress_size),
                file_size: Number(item.file_size),
                flag_bits: Number(item.flag_bits),
                file_time: new Date(item.file_time)
            }));

            // 生成文件哈希
            const itemsWithHash = itemsWithTypes.map(item => ({
                ...item,
                file_hash: this.generateFileHash(item.ndsId, item.file_path, item.sub_file_name),
                parsed: 0  // 默认设置为未处理
            }));

            // 使用事务确保数据一致性
            await mysql.$transaction(async (tx) => {
                // 批量插入所有数据到MySQL（已存在的会被跳过）
                const result = await tx.ndsFileList.createMany({
                    data: itemsWithHash,
                    skipDuplicates: true  // 跳过已存在的记录
                });

                // 过滤出符合任务条件的记录
                const validItems = itemsWithHash.filter(item =>
                    validTasks.some(task =>
                        item.enodebid === task.enodebid &&
                        item.data_type === task.data_type &&
                        new Date(item.file_time) >= new Date(task.start_time) &&
                        new Date(item.file_time) <= new Date(task.end_time)
                    )
                );

                // 转换数据类型
                const validItemsWithTypes = validItems.map(item => ({
                    ...item,
                    ndsId: Number(item.ndsId),
                    header_offset: Number(item.header_offset),
                    compress_size: Number(item.compress_size),
                    file_size: Number(item.file_size),
                    flag_bits: Number(item.flag_bits),
                    file_time: new Date(item.file_time)
                }));

                // 如果有符合条件的记录且Redis内存未超限，则更新状态并添加到Redis
                if (validItemsWithTypes.length > 0 && !isMemoryHigh) {
                    try {
                        // 更新符合条件记录的状态为已入队(parsed=1)
                        await tx.ndsFileList.updateMany({
                            where: {
                                file_hash: {
                                    in: validItemsWithTypes.map(item => item.file_hash)
                                }
                            },
                            data: {
                                parsed: 1
                            }
                        });

                        // 添加到Redis队列
                        await redis.batchEnqueue(validItemsWithTypes.map(item => ({
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
                        throw error;  // 触发事务回滚
                    }
                }

                return {
                    total: result.count,
                    valid: validItemsWithTypes.length,
                    queued: !isMemoryHigh ? validItemsWithTypes.length : 0
                };
            }).then(result => {
                res.json({
                    code: 0,
                    data: result,
                    msg: isMemoryHigh ? 
                        '数据已入库，但由于Redis内存占用过高，符合条件的记录暂未加入队列' : 
                        `成功入库${result.total}条记录，其中${result.valid}条符合任务条件，已加入队列${result.queued}条`
                });
            });
        } catch (error) {
            logger.error('批量添加NDS文件记录失败:', error);
            res.internalError('批量添加NDS文件记录失败');
        }
    }

    /**
     * 设置指定file_hash的解析状态
     * 注意：如果记录不存在也返回成功，updated为0
     */
    static async setParsedStatus(req: Request, res: Response): Promise<void> {
        try {
            const { file_hash, parsed } = req.body;
            if (!file_hash || typeof parsed !== 'number') {
                res.badRequest('请提供有效的file_hash和parsed值');
                return;
            }

            const result = await mysql.ndsFileList.updateMany({
                where: { file_hash },
                data: { parsed }
            });

            res.success({
                updated: result.count
            }, '设置解析状态完成');
        } catch (error: any) {
            logger.error('设置解析状态失败:', error);
            res.internalError('设置解析状态失败');
        }
    }

    /**
     * 获取Redis内存使用状态
     */
    static async getRedisMemoryInfo(_req: Request, res: Response): Promise<void> {
        try {
            const memoryInfo = await redis.getMemoryInfo();
            res.json({
                code: 0,
                data: memoryInfo,
                msg: 'success'
            });
        } catch (error) {
            logger.error('获取Redis内存状态失败:', error);
            res.json({
                code: -1,
                msg: '获取Redis内存状态失败'
            });
        }
    }

    /**
     * 检查是否有新增任务需要处理
     */
    private static async checkNewTasks(): Promise<boolean> {
        try {
            // 直接从内存映射中获取需要检查的任务
            const newTasks = enbTaskMap.getTasksNeedCheck();

            if (newTasks.length > 0) {
                // 更新任务的trigger_check状态
                await mysql.enbTaskList.updateMany({
                    where: {
                        enodebid: {
                            in: newTasks.map(t => t.enodebid)
                        }
                    },
                    data: {
                        trigger_check: 1
                    }
                });

                // 更新内存映射
                await enbTaskMap.refresh();

                // 设置redisFlag为true，触发任务处理
                redisFlag.setFlag(true);
                logger.info(`发现${newTasks.length}个新任务，已触发检查`);
                return true;
            }

            return false;
        } catch (error) {
            logger.error('检查新任务时出错:', error);
            return false;
        }
    }

    /**
     * 检查Redis内存并处理待处理任务
     */
    public static async processQueuedTasks(): Promise<void> {
        try {
            // 1. 检查是否有新任务（这个查询很轻量，只查trigger_check=true的记录）
            const hasNewTasks = await this.checkNewTasks();

            // 2. 如果没有新任务且redisFlag=0，直接返回
            if (!hasNewTasks && !redisFlag.getFlag()) {
                return;
            }

            // 3. 获取Redis内存使用情况
            const memoryInfo = await redis.getMemoryInfo();
            
            // 4. 如果内存使用率低于阈值，尝试处理待处理任务
            if (memoryInfo.ratio < REDIS_LOW_MEMORY_THRESHOLD) {
                let hasMoreTasks = true;
                let processedCount = 0;
                
                while (hasMoreTasks && memoryInfo.ratio < REDIS_HIGH_MEMORY_THRESHOLD) {
                    // 使用事务确保数据一致性
                    await mysql.$transaction(async (tx) => {
                        // 使用GROUP BY去重，确保每个文件只处理一次
                        const tasks = await tx.$queryRaw<NDSFileWithTask[]>`
                            WITH valid_tasks AS (
                                SELECT 
                                    n.*
                                FROM nds_file_list n
                                INNER JOIN enb_task_list e 
                                ON n.enodebid = e.enodebid 
                                AND n.data_type = e.data_type
                                WHERE n.parsed = 0 
                                AND e.parsed = 0 
                                AND e.status = 0
                                AND n.file_time BETWEEN e.start_time AND e.end_time
                                GROUP BY n.file_hash  
                                ORDER BY n.file_time ASC
                            )
                            SELECT * FROM valid_tasks
                            LIMIT ${BATCH_SIZE}
                            FOR UPDATE SKIP LOCKED
                        `;

                        if (tasks.length === 0) {
                            hasMoreTasks = false;
                            return;
                        }

                        try {
                            // 添加到Redis
                            await redis.batchEnqueue(tasks.map(task => ({
                                NDSID: task.ndsId,
                                data: {
                                    ndsId: task.ndsId,
                                    file_path: task.file_path,
                                    file_time: task.file_time.toISOString(),
                                    data_type: task.data_type,
                                    sub_file_name: task.sub_file_name,
                                    header_offset: task.header_offset,
                                    compress_size: task.compress_size,
                                    file_size: task.file_size,
                                    flag_bits: task.flag_bits,
                                    enodebid: task.enodebid,
                                    file_hash: task.file_hash
                                }
                            })));

                            // 更新任务状态
                            await tx.ndsFileList.updateMany({
                                where: {
                                    file_hash: {
                                        in: tasks.map(t => t.file_hash)
                                    }
                                },
                                data: {
                                    parsed: 1
                                }
                            });

                            processedCount += tasks.length;
                            logger.info(`成功处理 ${tasks.length} 条任务，累计处理 ${processedCount} 条`);
                        } catch (error) {
                            logger.error('处理任务批次失败:', error);
                            throw error;  // 触发事务回滚
                        }
                    });

                    // 重新检查内存使用情况
                    const newMemoryInfo = await redis.getMemoryInfo();
                    memoryInfo.ratio = newMemoryInfo.ratio;
                }

                // 如果内存使用率低于高阈值，并且没有更多任务，重置标记
                if (memoryInfo.ratio < REDIS_HIGH_MEMORY_THRESHOLD) {
                    // 使用GROUP BY确保不重复计数
                    const remainingTasks = await mysql.$queryRaw<{ count: number }[]>`
                        SELECT COUNT(DISTINCT n.file_hash) as count
                        FROM nds_file_list n
                        INNER JOIN enb_task_list e 
                        ON n.enodebid = e.enodebid 
                        AND n.data_type = e.data_type
                        WHERE n.parsed = 0 
                        AND e.parsed = 0 
                        AND e.status = 0
                        AND n.file_time BETWEEN e.start_time AND e.end_time
                    `;

                    if (remainingTasks[0].count === 0) {
                        redisFlag.setFlag(false);
                        logger.info('所有待处理任务已完成，重置全局标记为0');
                    } else {
                        logger.info(`仍有 ${remainingTasks[0].count} 条任务待处理`);
                    }
                }
            } else {
                logger.warn(`Redis内存使用率(${memoryInfo.ratio}%)仍然较高，暂不处理待处理任务`);
            }
        } catch (error) {
            logger.error('处理待处理任务失败:', error);
        }
    }

    // 启动定时任务
    static async startSchedule(): Promise<void> {
        setInterval(() => {
            NDSFileController.processQueuedTasks().catch(error => {
                logger.error('定时任务执行失败:', error);
            });
        }, 30000);  // 每30秒执行一次
    }
}

NDSFileController.startSchedule();

export default NDSFileController;