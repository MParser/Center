// noinspection ExceptionCaughtLocallyJS

/**
 * Redis 管理器
 */
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { extractTimeFromPath } from '../utils/timeUtils';

interface QueueItem {
    NDSID: string | number;
    data: any;
}

interface BatchResult {
    success: number;
    failed: number;
}

interface HealthCheckResult {
    status: 'healthy' | 'unhealthy';
    connected: boolean;
    reconnectAttempts: number;
    error?: string;
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
    private scanListMaxTimes: Map<string, Date> = new Map();
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

                logger.info('Redis配置已设置:', {
                    maxMemory: `${maxMemoryGB}GB`,
                    policy: maxMemoryPolicy
                });

                // 获取并记录当前内存使用情况
                const info = await this.redis.info('memory');
                const used = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');
                logger.info('Redis当前内存使用:', {
                    used: `${(used / 1024 / 1024 / 1024).toFixed(2)}GB`,
                    maxMemory: `${maxMemoryGB}GB`
                });
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

    /**
     * 初始化扫描记录表的最大时间映射
     */
    private async initScanListMaxTimes(): Promise<void> {
        try {
            // 获取所有scan_for_nds:*的key
            const scanKeys = await this.redis.keys(`${this.SCAN_LIST_PREFIX}*`);

            // 遍历每个scan_for_nds表
            for (const key of scanKeys) {
                const paths = await this.redis.smembers(key);
                let maxTime = new Date(0);

                // 检查每个文件路径中的时间戳
                for (const path of paths) {
                    const fileTime = extractTimeFromPath(path);
                    if (fileTime && fileTime > maxTime) {
                        maxTime = fileTime;
                    }
                }

                // 将最大时间存入映射
                this.scanListMaxTimes.set(key, maxTime);
            }

            logger.info('扫描记录表最大时间映射初始化完成');
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

    /**
     * 获取任务队列的key
     * @param ndsId NDSID（支持数字或字符串）
     */
    private getTaskQueueKey(ndsId: string | number): string {
        return `${this.TASK_QUEUE_PREFIX}${ndsId.toString()}`;
    }

    /**
     * 获取扫描记录列表表名
     * @param ndsId NDSID（支持数字或字符串）
     */
    private getScanListKey(ndsId: string | number): string {
        return  `${this.SCAN_LIST_PREFIX}${ndsId.toString()}`
    }


    /**
     * 更新扫描记录表的最大时间
     * @param ndsId NDSID
     * @param filePath 文件路径
     */
    private updateScanListMaxTime(ndsId: string | number, filePath: string): void {
        const fileTime = extractTimeFromPath(filePath);
        if (fileTime) {
            const scanQueueKey = this.getScanListKey(ndsId);
            const currentMaxTime = this.scanListMaxTimes.get(scanQueueKey) || new Date(0);
            if (fileTime > currentMaxTime) {
                this.scanListMaxTimes.set(scanQueueKey, fileTime);
            }
        }
    }

    /**
     * 批量插入已扫描文件清单
     * @param items 要插入的数据项数组
     */
    public async batchScanEnqueue(items: QueueItem[]){
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

            // 批量插入每个队列
            for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
                const scanQueueKey = this.getScanListKey(ndsId)
                dataList.forEach(data => {
                    pipeline.sadd(scanQueueKey, data.file_path); // 使用SADD添加扫描文件记录表
                    this.updateScanListMaxTime(ndsId, data.file_path); // 更新最大时间映射
                });
            }

            const results = await pipeline.exec();
            if (!results) {
                throw new Error('Pipeline execution failed');
            }

        }catch (error){
            logger.error('Redis批量入队失败:', error);
            throw error;
        }
    }



    /**
     * 批量插入队列数据
     * @param items 要插入的数据项数组
     * @returns 成功和失败的数量
     */
    public async batchTaskEnqueue(items: QueueItem[]): Promise<BatchResult> {
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

            // 批量插入每个队列
            for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
                const taskQueueKey = this.getTaskQueueKey(ndsId);
                const scanQueueKey = this.getScanListKey(ndsId)
                dataList.forEach(data => {
                    pipeline.rpush(taskQueueKey, JSON.stringify(data));  // 使用 RPUSH, 新数据插入尾部
                    pipeline.sadd(scanQueueKey, data.file_path); // 使用SADD添加扫描文件记录表
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



    /**
     * 获取指定任务队列的长度
     * @param ndsId NDSID（支持数字或字符串）
     * @returns 队列长度
     */
    public async getTaskQueueLength(ndsId: string | number): Promise<number> {
        try {
            await this.ensureConnection();
            const queueKey = this.getTaskQueueKey(ndsId);
            return await this.redis.llen(queueKey);
        } catch (error) {
            logger.error(`获取队列 NDS[${ndsId}] 长度失败:`, error);
            throw error;
        }
    }

    /**
     * 健康检查
     * @returns 健康检查结果
     */
    public async healthCheck(): Promise<HealthCheckResult> {
        try {
            await this.redis.ping();
            logger.info('Redis健康检查通过');
            return {
                status: 'healthy',
                connected: this.isConnected,
                reconnectAttempts: this.reconnectAttempts
            };
        } catch (error) {
            const err = error as Error;
            logger.error('Redis健康检查失败:', err);
            return {
                status: 'unhealthy',
                connected: this.isConnected,
                reconnectAttempts: this.reconnectAttempts,
                error: err.message
            };
        }
    }

    /**
     * 查询Redis内存使用情况
     * @returns Redis内存使用信息
     */
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
            const ratio = maxMemory > 0
                ? Number((used / maxMemory * 100).toFixed(2))
                : 0;

            logger.debug('Redis内存使用情况:', {
                used: `${(used / 1024 / 1024 / 1024).toFixed(2)}GB`,     // 当前已使用内存
                peak: `${(peak / 1024 / 1024 / 1024).toFixed(2)}GB`,     // 历史峰值内存（从启动到现在的最高值）
                maxMemory: maxMemory > 0 ? `${(maxMemory / 1024 / 1024 / 1024).toFixed(2)}GB` : '未限制',  // 最大可用内存
                ratio: `${ratio}%`  // 当前使用率
            });

            return {
                used,
                peak,
                maxMemory,
                ratio
            };
        } catch (error) {
            logger.error('获取Redis内存信息失败:', error);
            throw error;
        }
    }

    /**
     * 筛选不在扫描记录集合中的文件路径
     * @param ndsId NDSID（支持数字或字符串）
     * @param filePaths 要检查的文件路径数组
     * @returns 不存在于集合中的文件路径数组
     */
    public async filterNonExistingPaths(ndsId: string | number, filePaths: string[]): Promise<string[]> {
        try {
            if (!filePaths || filePaths.length === 0) {
                return [];
            }

            await this.ensureConnection();
            const scanQueueKey = this.getScanListKey(ndsId);
            const pipeline = this.redis.pipeline();
            const nonExistingPaths: string[] = [];

            // 使用pipeline批量检查每个路径是否存在于集合中
            filePaths.forEach(path => {
                pipeline.sismember(scanQueueKey, path);
            });

            const results = await pipeline.exec();
            if (!results) {
                throw new Error('Pipeline execution failed');
            }

            // 处理结果，找出不存在的路径
            results.forEach((result, index) => {
                const [err, exists] = result;
                if (err) {
                    logger.warn(`检查路径 ${filePaths[index]} 时出错:`, err);
                } else if (exists === 0) { // 0表示不存在于集合中
                    nonExistingPaths.push(filePaths[index]);
                }
            });

            logger.debug(`筛选完成: 共检查${filePaths.length}个路径，发现${nonExistingPaths.length}个不存在的路径`);
            return nonExistingPaths;
        } catch (error) {
            logger.error(`筛选不存在的文件路径失败 [NDS:${ndsId}]:`, error);
            throw error;
        }
    }

    /**
     * 批量删除已扫描文件清单
     * @param items 要删除的数据项数组
     */
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
                dataList.forEach(data => {
                    pipeline.srem(scanQueueKey, data.file_path); // 使用SREM移除扫描文件记录
                });
            }

            const results = await pipeline.exec();
            if (!results) {
                throw new Error('Pipeline execution failed');
            }

        } catch (error) {
            logger.error('Redis批量删除失败:', error);
            throw error;
        }
    }


    public async cleanExpiredScanRecords(max_age_days: number = 45): Promise<{ cleaned: number, total: number }> {
        try {
            await this.ensureConnection();
            const pipeline = this.redis.pipeline();
            let totalRecords = 0;
            let cleanedRecords = 0;

            // 获取所有scan_for_nds:*的key
            const scanKeys = await this.redis.keys(`${this.SCAN_LIST_PREFIX}*`);

            // 遍历每个scan_for_nds表
            for (const key of scanKeys) {
                // 获取集合中的所有文件路径
                const paths = await this.redis.smembers(key);
                totalRecords += paths.length;

                // 获取该表的最大时间
                const maxTime = this.scanListMaxTimes.get(key) || new Date(0);

                // 检查每个文件路径
                for (const path of paths) {
                    const fileTime = extractTimeFromPath(path);
                    let shouldDelete = false;

                    if (!fileTime) {
                        // 如果无法提取时间，删除该记录
                        shouldDelete = true;
                    } else {

                        // 计算文件时间与最大时间的差值（天数）
                        const daysDiff = (maxTime.getTime() - fileTime.getTime()) / (1000 * 60 * 60 * 24);
                        if (daysDiff > max_age_days) {
                            shouldDelete = true;
                        }
                    }

                    if (shouldDelete) {
                        pipeline.srem(key, path);
                        cleanedRecords++;
                    }
                }
            }

            // 执行批量删除操作
            const results = await pipeline.exec();
            if (!results) {
                throw new Error('Pipeline execution failed');
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
