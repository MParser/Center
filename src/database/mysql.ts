/**
 * Prisma 客户端
 */
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';
import { config } from '../utils/config';

const mysql_config = {
    host: config.get('mysql.host', 'localhost'),
    port: config.get('mysql.port', 3306),
    user: config.get('mysql.user', 'root'),
    password: config.get('mysql.password', ''),
    database: config.get('mysql.database', 'mparser'),
    connection_timeout: config.get('mysql.connection_timeout', 300),
    connection_limit: config.get('mysql.connection_limit', 100),
    pool_timeout: config.get('mysql.pool_timeout', 600)
};

// 创建 Prisma 客户端实例
const mysql = new PrismaClient({
    datasources: {
        db: {
            url: `mysql://${mysql_config.user}:${mysql_config.password}@${mysql_config.host}:${mysql_config.port}/${mysql_config.database}?connection_timeout=${mysql_config.connection_timeout}&connection_limit=${mysql_config.connection_limit}&pool_timeout=${mysql_config.pool_timeout}`
        }
    },
    log: [ // 定义日志级别
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
    ],
    // 设置事务超时时间为20分钟
    transactionOptions: {
        timeout: 1200000,
        maxWait: 600000,
    }
});

// 添加连接池管理
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const CONNECTION_RETRY_DELAY = 3000; // 3秒

// 连接错误处理函数
async function handleConnectionError() {
    connectionAttempts++;
    if (connectionAttempts <= MAX_CONNECTION_ATTEMPTS) {
        logger.warn(`数据库连接失败，第${connectionAttempts}次重试，等待${CONNECTION_RETRY_DELAY/1000}秒...`);
        await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_DELAY));
        try {
            await mysql.$connect();
            connectionAttempts = 0;
            logger.info('数据库重连成功');
        } catch (error) {
            logger.error('数据库重连失败:', error);
            await handleConnectionError();
        }
    } else {
        logger.error(`数据库连接失败，已达到最大重试次数${MAX_CONNECTION_ATTEMPTS}`);
        connectionAttempts = 0;
    }
}

// 添加日志监听，按日志级别输出
mysql.$on('query', (e) => {
    logger.debug('Query: ' + e.query);
    logger.debug('Params: ' + e.params);
    logger.debug('Duration: ' + e.duration + 'ms');
});

mysql.$on('error', (e: { message: unknown; }) => {
    logger.error('Database error:', e.message);
    if (e.message && typeof e.message === 'string' && 
        (e.message.includes('Connection') || e.message.includes('connect'))) {
        handleConnectionError();
    }
});

mysql.$on('info', (e: { message: unknown; }) => {
    logger.info('MySQL 配置:', e.message);
});

mysql.$on('warn', (e: { message: unknown; }) => {
    logger.warn('Database warning:', e.message);
});

export default mysql;
