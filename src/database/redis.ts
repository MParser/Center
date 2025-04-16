// noinspection ExceptionCaughtLocallyJS

/**
 * Redis 管理器
 */
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { extractTimeFromPath } from '../utils/Utils';

interface QueueItem {
    NDSID: string | number;
    data: string | object;
}

interface BatchResult {
    success: number;
    failed: number;
}


interface MemoryInfo {
    used: number;      // 当前已使用的内存（字节）
    peak: number;      // Redis启动以来内存使用的历史峰值（字节）
    maxMemory: number; // 最大可用内存（字节）
    ratio: number;     // 当前内存使用率（百分比）
}

class RedisManager extends EventEmitter {
    private static instance: RedisManager;
    private redis!: Redis;
    private readonly TASK_QUEUE_PREFIX = 'task_for_nds:';
    private readonly SCAN_LIST_PREFIX = "scan_for_nds:";
    private isConnected = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 20;
    public scanListMaxTimes: Map<string, Date> = new Map();
    constructor() {
        super();
        if (!RedisManager.instance) {
            this.initialize();
            RedisManager.instance = this;
        }
        return RedisManager.instance;
    }

    private initialize(): void { 
        this.initRedis(); 
    }

    private initRedis(): void {
        const redis_config = {
            host: config.get('redis.host', '127.0.0.1'),
            port: config.get('redis.port', 6379),
            password: config.get('redis.password', ''),
            db: config.get('redis.database', 0),
            maxRetriesPerRequest: 3,
            retryStrategy: (times: number) => {
                this.reconnectAttempts = times;
                if (times > this.maxReconnectAttempts) {
                    this.emit('maxReconnectAttemptsReached', times);
                    logger.error(`Redis重连次数超过最大限制: ${times}`);
                    return null;
                }
                const delay = Math.min(times * 100, 5000);
                this.emit('reconnecting', { attempt: times, delay });
                logger.warn(`Redis正在重连(第${times}次), 延迟${delay}ms`);
                return delay;
            },
            enableOfflineQueue: true,
            connectTimeout: 10000,
            keepAlive: 10000
        };

        this.redis = new Redis(redis_config);

        // 在连接成功后设置最大内存和淘汰策略
        this.redis.on('connect', async () => {
            try {
                const maxMemoryGB = config.get('redis.maxMemoryGB', 8);  // 默认8GB
                const maxMemoryPolicy = config.get('redis.maxMemoryPolicy', 'noeviction');
                const maxMemoryBytes = maxMemoryGB * 1024 * 1024 * 1024; // 转换为字节

                await this.redis.config('SET', 'maxmemory', maxMemoryBytes.toString()); // 设置最大内存
                await this.redis.config('SET', 'maxmemory-policy', maxMemoryPolicy);  // 设置淘汰策略 noeviction 表示不进行淘汰

                // 初始化扫描记录表的最大时间映射
                await this.initScanListMaxTimes();
                logger.info('Redis配置已设置:', {maxMemory: `${maxMemoryGB}GB`, policy: maxMemoryPolicy});
                // 获取并记录当前内存使用情况
                const info = await this.redis.info('memory');
                const used = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');
                logger.info('Redis当前内存使用:', { used: `${(used / 1024 / 1024 / 1024).toFixed(2)}GB`, maxMemory: `${maxMemoryGB}GB` });
            } catch (error) {
                logger.error('Redis内存配置设置失败:', error);
            }
        });

        this._bindEvents();
    }

    private _bindEvents(): void {
        this.redis.on('connect', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.emit('connect');
            logger.info('Redis连接成功');
        });

        this.redis.on('error', (error: Error) => {
            this.emit('error', error);
            logger.error('Redis错误:', error);
        });

        this.redis.on('close', () => {
            this.isConnected = false;
            this.emit('close');
            logger.warn('Redis连接已关闭');
        });

        this.redis.on('reconnecting', () => {
            this.emit('reconnecting', {
                attempt: this.reconnectAttempts
            });
        });
    }

    //查询Redis内存使用情况
    public async getMemoryInfo(): Promise<MemoryInfo> {
        try {
            await this.ensureConnection();
            // 使用INFO命令获取内存信息
            const info = await this.redis.info('memory');
            // 解析INFO命令返回的字符串
            const used = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');
            const peak = parseInt(info.match(/used_memory_peak:(\d+)/)?.[1] || '0');
            const maxMemory = parseInt(info.match(/maxmemory:(\d+)/)?.[1] || '0');
            // 计算使用率（保留2位小数）
            const ratio = maxMemory > 0 ? Number((used / maxMemory * 100).toFixed(2)) : 0;
            return {used, peak, maxMemory, ratio};
        } catch (error) {
            logger.error('获取Redis内存信息失败:', error);
            throw error;
        }
    }

    //初始化扫描记录表的最大时间映射
    private async initScanListMaxTimes(): Promise<void> {
        try {
            // 获取所有scan_for_nds:*的key
            const scanKeys = await this.redis.keys(`${this.SCAN_LIST_PREFIX}*`);
            if (scanKeys.length === 0) return;
            // 逐个处理每个集合，避免一次性加载所有数据
            for (const key of scanKeys) {
                try {
                    // 使用SSCAN命令分批获取集合成员，而不是一次性获取全部
                    let cursor = '0';
                    let maxTime = new Date(0);
                    
                    do {
                        // 每次扫描获取一部分数据, 避免一次性加载大量数据
                        const [nextCursor, paths] = await this.redis.sscan(key, cursor, 'COUNT', 1000);
                        cursor = nextCursor;
                        // 处理当前批次的路径
                        for (const path of paths) {
                            const fileTime = extractTimeFromPath(path);
                            if (fileTime && fileTime > maxTime) maxTime = fileTime;
                        }
                    } while (cursor !== '0'); // 当cursor为0时表示扫描完成
                    
                    // 将最大时间存入映射
                    this.scanListMaxTimes.set(key, maxTime);
                } catch (err) {
                    logger.error(`处理集合 ${key} 失败:`, err);
                }
            }

            logger.info(`扫描记录表最大时间映射初始化完成，共处理 ${scanKeys.length} 个集合`);
        } catch (error) {
            logger.error('初始化扫描记录表最大时间映射失败:', error);
        }
    }

    private async ensureConnection(): Promise<void> {
        if (!this.isConnected) {
            try {
                await this.redis.ping();
                this.isConnected = true;
            } catch (error) {
                logger.error('Redis连接检查失败:', error);
                throw new Error('Redis连接不可用');
            }
        }
    }

    //获取任务队列的key task_for_nds:*
    private getTaskQueueKey(ndsId: string | number): string {
        return `${this.TASK_QUEUE_PREFIX}${ndsId.toString()}`;
    }

    //获取扫描记录列表表名 scan_for_nds:*
    private getScanListKey(ndsId: string | number): string {
        return  `${this.SCAN_LIST_PREFIX}${ndsId.toString()}`
    }


    //更新扫描记录表的最大时间
    private updateScanListMaxTime(ndsId: string | number, filePath: string): void {
        const fileTime = extractTimeFromPath(filePath);
        if (fileTime) {
            const scanQueueKey = this.getScanListKey(ndsId);
            const currentMaxTime = this.scanListMaxTimes.get(scanQueueKey) || new Date(0);
            if (fileTime > currentMaxTime) this.scanListMaxTimes.set(scanQueueKey, fileTime);
        }
    }

    //批量插入已扫描文件清单
    public async batchScanEnqueue(items: QueueItem[]): Promise<number[]> {
        try {
            await this.ensureConnection();

            const pipeline = this.redis.pipeline();
            const ndsGroups: { [key: string]: any[] } = {};

            // 按 NDSID 分组，确保转换为字符串
            items.forEach(item => {
                const ndsId = item.NDSID.toString();
                if (!ndsGroups[ndsId]) ndsGroups[ndsId] = [];
                ndsGroups[ndsId].push(item.data);
            });

            // 批量插入每个队列
            for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
                const scanQueueKey = this.getScanListKey(ndsId)
                dataList.forEach(data => {
                    if (typeof data !== 'string') data = data.file_path; // 将对象转换为字符串
                    pipeline.sadd(scanQueueKey, data); // 使用SADD添加扫描文件记录表, 当记录已存在时不会重复添加
                    this.updateScanListMaxTime(ndsId, data); // 更新最大时间映射
                });
            }

            const results = await pipeline.exec();
            if (!results) throw new Error('Pipeline execution failed');
            
            // 返回每个操作的结果（1表示添加成功，0表示已存在）
            return results.map(result => result[1] as number);
        } catch (error) {
            logger.error('Redis批量入队失败:', error);
            throw error;
        }
    }



    // 批量插入队列数据
    public async batchTaskEnqueue(items: QueueItem[]): Promise<BatchResult> {
        try {
            await this.ensureConnection();

            const pipeline = this.redis.pipeline();
            const ndsGroups: { [key: string]: any[] } = {};

            // 按 NDSID 分组，确保转换为字符串
            items.forEach(item => {
                const ndsId = item.NDSID.toString();
                if (!ndsGroups[ndsId]) ndsGroups[ndsId] = [];
                ndsGroups[ndsId].push(item.data);
            });

            // 批量插入每个队列
            for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
                const taskQueueKey = this.getTaskQueueKey(ndsId);
                const scanQueueKey = this.getScanListKey(ndsId)
                dataList.forEach(data => {
                    pipeline.rpush(taskQueueKey, JSON.stringify(data));  // 使用 RPUSH, 新数据插入尾部
                    pipeline.sadd(scanQueueKey, data.file_path); // 使用SADD添加扫描文件记录表
                    this.updateScanListMaxTime(ndsId, data.file_path); // 更新最大时间映射
                });
            }

            const results = await pipeline.exec();
            if (!results) {
                throw new Error('Pipeline execution failed');
            }

            return {
                success: results.filter(([err]) => !err).length,
                failed: results.filter(([err]) => err).length
            };
        } catch (error) {
            logger.error('Redis批量入队失败:', error);
            throw error;
        }
    }


    // 筛选不在扫描记录集合中的文件路径
    public async filterNonExistingPaths(ndsId: string | number, filePaths: string[]): Promise<string[]> {
        try {
            if (!filePaths || filePaths.length === 0) return [];
            await this.ensureConnection(); // 检查连接状态

            const scanQueueKey = this.getScanListKey(ndsId); // scan_for_nds:*
            
            try {
                // 使用SMISMEMBER一次性检查多个成员是否存在(版本要求Redis 6.2.0及以上)
                const existsArray = await this.redis.smismember(scanQueueKey, filePaths);
                // 直接过滤出不存在的路径
                const nonExistingPaths = filePaths.filter((_, index) => existsArray[index] === 0);
                return nonExistingPaths;
            } catch (err) {
                // 如果SMISMEMBER不支持，回退到pipeline方式
                const pipeline = this.redis.pipeline();
                filePaths.forEach(path => pipeline.sismember(scanQueueKey, path));
                const results = await pipeline.exec();
                if (!results) throw new Error('Pipeline execution failed');
                const nonExistingPaths: string[] = [];
                results.forEach((result, index) => {
                    const [err, exists] = result;
                    if (!err && exists === 0) nonExistingPaths.push(filePaths[index]);
                });
                return nonExistingPaths;

            }
        } catch (error) {
            logger.error(`筛选不存在的文件路径失败 [NDS:${ndsId}]:`, error);
            throw error;
        }
    }


    //批量删除扫描文件记录
    public async batchScanDequeue(items: QueueItem[]): Promise<void> {
        try {
            await this.ensureConnection();
            const pipeline = this.redis.pipeline();
            const ndsGroups: { [key: string]: any[] } = {};

            // 按 NDSID 分组，确保转换为字符串
            items.forEach(item => {
                const ndsId = item.NDSID.toString();
                if (!ndsGroups[ndsId]) {
                    ndsGroups[ndsId] = [];
                }
                ndsGroups[ndsId].push(item.data);
            });

            // 批量删除每个队列中的记录
            for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
                const scanQueueKey = this.getScanListKey(ndsId);
                dataList.forEach(data => pipeline.srem(scanQueueKey, data.file_path)); // 使用SREM移除扫描文件记录
            }
            const results = await pipeline.exec();
            if (!results) throw new Error('Pipeline execution failed');
            
        } catch (error) {
            logger.error('Redis批量删除失败:', error);
            throw error;
        }
    }


    // 批量删除过期扫描记录
    public async cleanExpiredScanRecords(max_age_days: number = 45): Promise<{ cleaned: number, total: number }> {
        try {
            await this.ensureConnection();
            let totalRecords = 0;
            let cleanedRecords = 0;

            // 获取所有scan_for_nds:*的key
            const scanKeys = await this.redis.keys(`${this.SCAN_LIST_PREFIX}*`);
            if (scanKeys.length === 0) return { cleaned: 0, total: 0 };

            // 逐个处理每个集合
            for (const key of scanKeys) {
                try {
                    // 使用SSCAN命令分批获取集合成员
                    let cursor = '0';
                    let keyTotalRecords = 0;
                    let keyCleanedRecords = 0;
                    const maxTime = this.scanListMaxTimes.get(key) || new Date(0);
                    do {
                        // 每次扫描获取一部分数据
                        const [nextCursor, paths] = await this.redis.sscan(key, cursor, 'COUNT', 1000);
                        cursor = nextCursor;
                        
                        // 处理当前批次的路径
                        const pathsToDelete: string[] = [];
                        for (const path of paths) {
                            keyTotalRecords++;
                            const fileTime = extractTimeFromPath(path);
                            // 如果无法提取时间或时间差超过阈值，则删除
                            if (!fileTime || (maxTime.getTime() - fileTime.getTime()) / (1000 * 60 * 60 * 24) > max_age_days) {
                                pathsToDelete.push(path);
                                keyCleanedRecords++;
                            }
                        }
                        
                        // 如果有需要删除的记录，执行删除操作
                        if (pathsToDelete.length > 0)  await this.redis.srem(key, ...pathsToDelete);
                        
                    } while (cursor !== '0'); // 当cursor为0时表示扫描完成
                    
                    // 更新总计数
                    totalRecords += keyTotalRecords;
                    cleanedRecords += keyCleanedRecords;
                    
                    logger.info(`清理集合 ${key} 完成: 共检查${keyTotalRecords}条记录，清理${keyCleanedRecords}条过期记录`);
                    
                } catch (err) {
                    logger.error(`处理集合 ${key} 失败:`, err);
                }
            }

            logger.info(`清理过期扫描记录完成: 共检查${totalRecords}条记录，清理${cleanedRecords}条过期记录`);
            return { cleaned: cleanedRecords, total: totalRecords };
        } catch (error) {
            logger.error('清理过期扫描记录失败:', error);
            throw error;
        }
    }

}

// 导出单例实例
export default new RedisManager();
