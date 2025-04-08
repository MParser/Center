/**
 * NDS文件控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';
import crypto from 'crypto';
import redis from '../database/redis'; // 添加redis导入
import enbTaskMap from '../utils/enbTaskMap';
import { extractTimeFromPath } from '../utils/timeUtils';


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

// 定义Redis内存检查结果接口
interface RedisMemoryCheckResult {
    isMemoryHigh: boolean;
    ratio: number;
}

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
    // 定义定时器间隔（分钟）
    private static readonly TASK_CHECK_INTERVAL = 20 * 60 * 1000;
    // 定义每批处理的最大数量
    private static readonly BATCH_SIZE = 100000;
    // 定义CellData刷新间隔（分钟）
    private static readonly CELL_DATA_REFRESH_INTERVAL = 10 * 60 * 1000;
    // 定义NDS文件过期天数（天）
    private static readonly NDS_FILE_EXPIRE_DAYS = 45;
    // 定义redis scan_for_nds 数据过期时间(天)
    private static readonly SCAN_FOR_NDS_EXPIRE_DAYS = 30;

    /**
     * 检查Redis内存状态
     * @returns Redis内存检查结果
     */
    private static async checkRedisMemory(): Promise<RedisMemoryCheckResult> {
        const memoryInfo = await redis.getMemoryInfo();
        return {
            isMemoryHigh: memoryInfo.ratio >= REDIS_HIGH_MEMORY_THRESHOLD,
            ratio: memoryInfo.ratio
        };
    }

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
     * 清理过期的扫描记录
     * @param _req 请求对象（可选）
     * @param res 响应对象（可选）
     * @returns 清理结果
     */
    public static async cleanExpiredScanRecords(_req?: Request, res?: Response): Promise<void> {
        try {
            const result = await redis.cleanExpiredScanRecords(NDSFileController.SCAN_FOR_NDS_EXPIRE_DAYS);
            if (res) res.success(result);
        } catch (error: any) {
            logger.error('清理过期扫描记录出错:', error);
            if (res) res.internalError('清理过期扫描记录出错');
        }
    }

    /**
     * 清理过期的NDS文件记录
     * @param _req 请求对象（可选）
     * @param res 响应对象（可选）
     * @returns 清理结果
     */
    public static async cleanExpiredNdsFiles(_req?: Request, res?: Response): Promise<void> {
        try {
            // 查询file_time的最大值作为基准, 使用MAX()函数获取最大值
            const maxTimeResult = await mysql.ndsFileList.aggregate({
                _max: {
                    file_time: true
                }
            })

            // 检查maxTime是否存在且不为null
            if (maxTimeResult._max.file_time === null || maxTimeResult._max.file_time === undefined) {
                logger.info('NDSFiles - 最大文件时间为空，无需清理');
                if (res) res.success('最大文件时间为空，无需清理');
                return;
            }

            // 计算过期时间
            const maxTime = maxTimeResult._max.file_time;
            const expireDate = new Date(maxTime);
            expireDate.setDate(expireDate.getDate() - NDSFileController.NDS_FILE_EXPIRE_DAYS);

            // 删除过期数据
            const deleteResult = await mysql.ndsFileList.deleteMany({
                where: {
                    file_time: {
                        lt: expireDate
                    }
                }
            });

            logger.info(`NDSFiles - 清理过期NDS文件记录完成，共删除${deleteResult.count}条记录`);
            if (res) res.success({
                deleted: deleteResult.count,
                expireDate: expireDate.toISOString(),
                maxTime: maxTime.toISOString()
            });
        } catch (error: any) {
            logger.error('NDSFiles - 清理过期NDS文件记录出错:', error);
            if (res) res.internalError('清理过期NDS文件记录出错');
        }
    }

    /**
     * 过滤NDS文件
     * @param req 请求对象
     * @param res 响应对象
     * @returns 过滤后的NDS文件
     */
    public static async filterFiles(req: Request, res: Response): Promise<void> {
        try {
            const { ndsId, data_type, file_paths } = req.body; // 获取请求体参数
            if (!ndsId || !data_type || !Array.isArray(file_paths) || file_paths.length === 0) {
                res.badRequest('参数错误');
                return;
            }
            
            // 检查Redis状态,如果负荷过高，取消处理
            const { isMemoryHigh } = await NDSFileController.checkRedisMemory();
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

            // 使用timeUtils提取文件路径中的时间信息
            const filteredPaths = nonExistingPaths.reduce<string[]>((acc, path) => {
                const fileTime = extractTimeFromPath(path);
                if (!fileTime) return acc; // 如果无法提取时间信息，跳过

                // 检查是否在任务时间范围内, 如果在任务时间范围内，加入结果
                if (tasks.some(item => {
                    const fileTimeMs = fileTime.getTime();
                    return fileTimeMs >= item.start_time.getTime() && fileTimeMs <= item.end_time.getTime();
                })) {
                    acc.push(path);
                }
                return acc;
            }, []);

            // 返回结果
            res.success(filteredPaths);
        } catch (error: any) {
            logger.error('过滤NDS文件出错:', error);
            res.internalError('过滤NDS文件出错');
        }
    }

    /**
     * 批量添加NDS文件任务
     * @param req 请求对象
     * @param res 响应对象
     * @returns 添加结果
     */
    public static async batchAddTasks(req: Request, res: Response): Promise<void> {
        try {
            const items: NDSFileItem[] = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                res.badRequest('参数错误');
                return;
            }

            // 检查Redis状态,如果负荷过高，取消处理
            const { isMemoryHigh } = await NDSFileController.checkRedisMemory();
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
                    // 尝试从文件路径中提取日期
                    const extractedTime = extractTimeFromPath(item.file_path);
                    if (extractedTime) {
                        file_time = extractedTime;
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

            // 从enbTaskMap获取有效的任务列表
            const validTasks = enbTaskMap.getAllTasks();

            // 生成文件哈希并预先确定parsed值
            const itemsWithHash = itemsWithTypes.map(item => {
                // 检查是否符合任务条件
                const isValidForTask = validTasks.some(task => {
                    const fileTime = item.file_time.getTime();
                    return item.enodebid === task.enodebid &&
                           item.data_type === task.data_type &&
                           fileTime >= task.start_time.getTime() &&
                           fileTime <= task.end_time.getTime();
                });

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

            // 判断是否需要刷新CellData表
            if (cellDataState.enbids.length === 0 || 
                cellDataState.lastRefreshTime.getTime() + NDSFileController.CELL_DATA_REFRESH_INTERVAL < Date.now()) {
                await NDSFileController.updateCellDataState();
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

        } catch (error: any) {
            logger.error('批量添加NDS文件任务出错:', error);
            res.internalError(`批量添加NDS文件任务出错 ${error}`);
        }
    }

    /**
     * 更新CellData状态
     * @param _req 请求对象（可选）
     * @param res 响应对象（可选）
     * @returns 更新结果
     */
    public static async updateCellDataState(_req?: Request, res?: Response): Promise<void> {
        try {
            cellDataState.enbids = await mysql.cellData.findMany({
                select: {
                    eNodeBID: true
                },
                distinct: ['eNodeBID']
            });
            cellDataState.lastRefreshTime = new Date();
        } catch (error: any) {
            logger.error('缓存eNodeBID出错:', error);
            if (res) res.internalError('缓存eNodeBID出错');
        }
    }

    public static async processUnhandledTasks(_req?: Request, res?: Response): Promise<void> {
        /**
         * 处理未处理的任务
         * @returns 处理结果
         */
        try {
            // 检查Redis状态,如果负荷过高，取消处理
            const memoryInfo = await redis.getMemoryInfo();
            const isMemoryHigh = memoryInfo.ratio >= REDIS_HIGH_MEMORY_THRESHOLD;
            if (isMemoryHigh) {
                if (res) res.customError('Redis内存负荷过高，无法处理请求', 429);
                return;
            }

            // 使用联合查询直接获取符合条件的文件记录
            const validFiles = await mysql.$queryRaw<NDSFileWithTask[]>`
                SELECT DISTINCT nfl.*
                FROM nds_file_list nfl
                INNER JOIN enb_task_list etl
                ON nfl.enodebid = etl.enodebid
                AND nfl.data_type = etl.data_type
                AND nfl.file_time >= etl.start_time
                AND nfl.file_time <= etl.end_time
                WHERE nfl.parsed = 0
                AND etl.parsed = 0
                AND etl.status = 0
                LIMIT ${NDSFileController.BATCH_SIZE}
            `;

            if (validFiles.length === 0) {
                if (res) res.success('没有符合任务条件的文件');
                return;
            }

            // 使用事务确保数据一致性
            await mysql.$transaction(async (tx) => {
                // 更新文件状态为已处理
                await tx.ndsFileList.updateMany({
                    where: {
                        file_hash: {
                            in: validFiles.map(file => file.file_hash)
                        }
                    },
                    data: {
                        parsed: 1
                    }
                });

                // 添加到Redis队列
                await redis.batchTaskEnqueue(validFiles.map(file => ({
                    NDSID: file.ndsId,
                    data: {
                        ndsId: file.ndsId,
                        file_path: file.file_path,
                        file_time: file.file_time.toISOString(),
                        data_type: file.data_type,
                        sub_file_name: file.sub_file_name,
                        header_offset: file.header_offset,
                        compress_size: file.compress_size,
                        file_size: file.file_size,
                        flag_bits: file.flag_bits,
                        enodebid: file.enodebid,
                        file_hash: file.file_hash
                    }
                })));
            });

            if (res) res.success({
                processed: validFiles.length
            });

        } catch (error: any) {
            logger.error('处理未处理任务出错:', error);
            if (res) res.internalError('处理未处理任务出错');
        }
    }

        // 静态初始化块
        static async startSchedule(): Promise<void> {
            // 首次执行定时15秒后运行
            setTimeout(async () => {
                try {
                    // noinspection DuplicatedCode
                    NDSFileController.processUnhandledTasks()
                        .then(() => {logger.info('NDSFiles - 扫描未处理任务完成')})
                        .catch(error => {logger.error('NDSFiles - 扫描未处理任务失败:', error)});
                    NDSFileController.cleanExpiredScanRecords()
                        .then(() => {logger.info('NDSFiles - 清理Redis过期数据完成')})
                        .catch(error => {logger.error('NDSFiles - 清理Redis过期数据失败:', error)});
                    NDSFileController.updateCellDataState()
                        .then(() => {logger.info('NDSFiles - 缓存eNodeBID完成')})
                        .catch(error => {logger.error('NDSFiles - 缓存eNodeBID失败:', error)});
                    NDSFileController.cleanExpiredNdsFiles()
                        .then(() => {logger.info('NDSFiles - 清理过期NDS文件记录完成')})
                        .catch(error => {logger.error('NDSFiles - 清理过期NDS文件记录失败:', error)});

                    setInterval(async () => {
                        try {
                            // noinspection DuplicatedCode
                            NDSFileController.processUnhandledTasks()
                                .then(() => {logger.info('NDSFiles - 扫描未处理任务完成')})
                                .catch(error => {logger.error('NDSFiles - 扫描未处理任务失败:', error)});
                            NDSFileController.cleanExpiredScanRecords()
                                .then(() => {logger.info('NDSFiles - 清理Redis过期数据完成')})
                                .catch(error => {logger.error('NDSFiles - 清理Redis过期数据失败:', error)});
                            NDSFileController.updateCellDataState()
                                .then(() => {logger.info('NDSFiles - 缓存eNodeBID完成')})
                                .catch(error => {logger.error('NDSFiles - 缓存eNodeBID失败:', error)});
                            NDSFileController.cleanExpiredNdsFiles()
                                .then(() => {logger.info('NDSFiles - 清理过期NDS文件记录完成')})
                                .catch(error => {logger.error('NDSFiles - 清理过期NDS文件记录失败:', error)});

                        } catch (error) {
                            logger.error('定时处理未处理任务出错:', error);
                        }
                    }, this.TASK_CHECK_INTERVAL);

                } catch (error) {
                    logger.error('NDSFiles 定时任务执行失败:', error);
                }
            }, 15000); // 15秒后执行首次任务
        }

}
// noinspection JSIgnoredPromiseFromCall
NDSFileController.startSchedule();

export default NDSFileController;
