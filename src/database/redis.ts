/**
 * Redis 管理器
 */
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import logger from '../utils/logger';
import { config } from '../utils/config';

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
    private readonly QUEUE_PREFIX = 'nds_queue:';
    private isConnected = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 20;

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
                const maxMemoryBytes = maxMemoryGB * 1024 * 1024 * 1024;

                await this.redis.config('SET', 'maxmemory', maxMemoryBytes.toString());
                await this.redis.config('SET', 'maxmemory-policy', maxMemoryPolicy);

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
     * 获取队列的key
     * @param ndsId NDSID（支持数字或字符串）
     */
    private getQueueKey(ndsId: string | number): string {
        return `${this.QUEUE_PREFIX}${ndsId.toString()}`;
    }

    /**
     * 批量插入队列数据
     * @param items 要插入的数据项数组
     * @returns 成功和失败的数量
     */
    public async batchEnqueue(items: QueueItem[]): Promise<BatchResult> {
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
                const queueKey = this.getQueueKey(ndsId);
                dataList.forEach(data => {
                    pipeline.rpush(queueKey, JSON.stringify(data));  // 使用 RPUSH, 新数据插入尾部
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
     * 获取指定队列的长度
     * @param ndsId NDSID（支持数字或字符串）
     * @returns 队列长度
     */
    public async getQueueLength(ndsId: string | number): Promise<number> {
        try {
            await this.ensureConnection();
            const queueKey = this.getQueueKey(ndsId);
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

}

// 导出单例实例
export default new RedisManager();
