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

            // 过滤出符合任务条件的记录（parsed=1的记录）
            const validItems = filteredItems.filter(item => item.parsed === 1);

            // 定义批处理大小
            const sqlBatchSize = NDSFileController.MAX_SQL_BATCH_SIZE;
            const redisBatchSize = 200; // 减小Redis批处理大小，避免单个事务处理过多数据
            const transactionBatchSize = 500; // 每个事务处理的最大记录数
            
            let totalInserted = 0;
            let totalQueued = 0;
            let transactionResults = [];

            try {
                // 分批处理数据，每批最多处理transactionBatchSize条记录
                for (let i = 0; i < dbModelItems.length; i += transactionBatchSize) {
                    const batchStart = Date.now();
                    const currentBatch = dbModelItems.slice(i, i + transactionBatchSize);
                    
                    // 当前批次中符合任务条件的记录
                    const currentValidItems = validItems.filter(item => 
                        currentBatch.some(dbItem => dbItem.file_hash === item.file_hash)
                    );
                    
                    logger.info(`NDSFiles - 开始处理第 ${i/transactionBatchSize + 1} 批数据，共 ${currentBatch.length} 条记录`);
                    
                    try {
                        // 使用事务确保数据一致性
                        const result = await mysql.$transaction(async (tx) => {
                            let batchInserted = 0;
                            
                            // 分批插入数据到MySQL
                            for (let j = 0; j < currentBatch.length; j += sqlBatchSize) {
                                const sqlBatch = currentBatch.slice(j, j + sqlBatchSize);
                                const insertResult = await tx.ndsFileList.createMany({
                                    data: sqlBatch,
                                    skipDuplicates: true  // 跳过已存在的记录
                                });
                                batchInserted += insertResult.count;
                                
                                // 记录每批处理进度
                                logger.debug(`NDSFiles - 已插入 ${j + sqlBatch.length} / ${currentBatch.length} 条记录`);
                            }
                            
                            // 如果有符合条件的记录，则添加到Redis
                            let batchQueued = 0;
                            if (currentValidItems.length > 0) {
                                // 分批添加到Redis队列
                                for (let j = 0; j < currentValidItems.length; j += redisBatchSize) {
                                    const redisBatch = currentValidItems.slice(j, j + redisBatchSize);
                                    await redis.batchTaskEnqueue(redisBatch.map(item => ({
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
                                    
                                    batchQueued += redisBatch.length;
                                    // 记录每批处理进度
                                    logger.debug(`NDSFiles - 已入队 ${j + redisBatch.length} / ${currentValidItems.length} 条记录到Redis`);
                                }
                            }
                            
                            return {
                                inserted: batchInserted,
                                queued: batchQueued
                            };
                        }, {
                            // 增加事务超时时间，避免长时间事务超时
                            timeout: 600000 // 10分钟超时
                        });
                        
                        totalInserted += result.inserted;
                        totalQueued += result.queued;
                        transactionResults.push(result);
                        
                        const batchDuration = Date.now() - batchStart;
                        logger.info(`NDSFiles - 第 ${i/transactionBatchSize + 1} 批数据处理完成，耗时 ${batchDuration}ms，插入 ${result.inserted} 条，入队 ${result.queued} 条`);
                        
                    } catch (error: any) {
                        // 如果是数据库连接错误或事务超时，记录错误并继续处理下一批
                        if (error.message && (error.message.includes("Can't reach database server") || 
                                             error.message.includes("Transaction already closed"))) {
                            logger.error(`批次 ${i/transactionBatchSize + 1} 处理出错:`, error);
                            // 删除redis中的扫描记录，避免数据不一致
                            try {
                                await redis.batchScanDequeue(currentValidItems.map(item => ({
                                    NDSID: item.ndsId,
                                    data: {
                                        file_path: item.file_path
                                    }
                                })));
                            } catch (redisError) {
                                logger.error('清理Redis扫描记录失败:', redisError);
                            }
                        } else {
                            // 其他错误直接抛出
                            throw error;
                        }
                    }
                }
                
                // 汇总处理结果
                const transactionResult = {
                    total: totalInserted,
                    filtered: filteredItems.length,
                    original: itemsWithHash.length,
                    valid: validItems.length,
                    queued: totalQueued
                };
                
                res.success(transactionResult);
            } catch (error: any) {
                // 如果是数据库连接错误，提供更详细的错误信息
                if (error.message && error.message.includes("Can't reach database server")) {
                    logger.error('数据库连接错误，请检查连接池配置或数据库服务状态:', error);
                    res.internalError(`数据库连接错误，请稍后重试: ${error.message}`);
                } else {
                    logger.error('批量添加NDS文件任务出错:', error);
                    res.internalError(`批量添加NDS文件任务出错: ${error.message}`);
                }
            }

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

    // 定义单批处理的最大数量
    private static readonly BATCH_PROCESS_SIZE = 500;
    // 定义单次SQL操作的最大记录数（避免too many placeholders错误）
    private static readonly MAX_SQL_BATCH_SIZE = 100;

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

            let totalProcessed = 0;
            let hasMoreRecords = true;

            // 分批处理记录
            while (hasMoreRecords) {
                // 使用联合查询直接获取符合条件的文件记录，每次最多获取BATCH_PROCESS_SIZE条
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
                    LIMIT ${NDSFileController.BATCH_PROCESS_SIZE}
                `;

                // 如果没有记录，退出循环
                if (validFiles.length === 0) {
                    hasMoreRecords = false;
                    break;
                }

                try {
                    // 使用事务确保数据一致性
                    await mysql.$transaction(async (tx) => {
                        // 分批更新文件状态为已处理，避免一次性生成过多的SQL占位符
                        const fileHashes = validFiles.map(file => file.file_hash);
                        const sqlBatchSize = NDSFileController.MAX_SQL_BATCH_SIZE;
                        
                        // 分批处理file_hash数组，每批最多处理sqlBatchSize条记录
                        for (let i = 0; i < fileHashes.length; i += sqlBatchSize) {
                            const batchHashes = fileHashes.slice(i, i + sqlBatchSize);
                            await tx.ndsFileList.updateMany({
                                where: {
                                    file_hash: {
                                        in: batchHashes
                                    }
                                },
                                data: {
                                    parsed: 1
                                }
                            });
                            
                            // 记录每批处理进度
                            logger.debug(`NDSFiles - 已更新 ${i + batchHashes.length} / ${fileHashes.length} 条记录状态`);
                        }

                        // 分批添加到Redis队列，避免一次性处理过多数据
                        const redisBatchSize = 500; // Redis批处理大小
                        for (let i = 0; i < validFiles.length; i += redisBatchSize) {
                            const batch = validFiles.slice(i, i + redisBatchSize);
                            await redis.batchTaskEnqueue(batch.map(file => ({
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
                            
                            // 记录每批处理进度
                            logger.debug(`NDSFiles - 已入队 ${i + batch.length} / ${validFiles.length} 条记录到Redis`);
                        }
                    }, {
                        // 设置事务超时，避免长时间事务
                        timeout: 600000 // 10分钟超时
                    });
                } catch (error) {
                    logger.error('处理未处理任务事务出错:', error);
                    // 如果是数据库连接错误，等待一段时间后继续
                    if ((error as any).message && (error as any).message.includes("Can't reach database server")) {
                        logger.warn('数据库连接错误，等待10秒后继续...');
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    } else {
                        throw error; // 其他错误直接抛出
                    }
                }

                totalProcessed += validFiles.length;

                // 如果获取的记录数小于批处理大小，说明没有更多记录了
                if (validFiles.length < NDSFileController.BATCH_PROCESS_SIZE) {
                    hasMoreRecords = false;
                }

                // 记录处理进度
                logger.info(`NDSFiles - 已处理 ${totalProcessed} 条未处理任务`);
            }

            if (res) res.success({
                processed: totalProcessed
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
