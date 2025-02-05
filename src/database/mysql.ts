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
};

if (config.get('app.env', 'development') === 'development') {
    mysql_config.host = config.get('mysql_dev.host', 'localhost');
    mysql_config.port = config.get('mysql_dev.port', 3306);
    mysql_config.user = config.get('mysql_dev.user', 'root');
    mysql_config.password = config.get('mysql_dev.password', '');
    mysql_config.database = config.get('mysql_dev.database', 'mparser');
}


// 创建 Prisma 客户端实例
const mysql = new PrismaClient({
    datasources: {
        db: {
            url: `mysql://${mysql_config.user}:${mysql_config.password}@${mysql_config.host}:${mysql_config.port}/${mysql_config.database}`
        }
    },
    log: [ // 定义日志级别
        {
            emit: 'event',
            level: 'query',
        },
        {
            emit: 'event',
            level: 'error',
        },
        {
            emit: 'event',
            level: 'info',
        },
        {
            emit: 'event',
            level: 'warn',
        },
    ],
});

// 添加日志监听，按日志级别输出
mysql.$on('query', (e) => {
    logger.debug('Query: ' + e.query);
    logger.debug('Params: ' + e.params);
    logger.debug('Duration: ' + e.duration + 'ms');
});

mysql.$on('error', (e: { message: unknown; }) => {
    logger.error('Database error:', e.message);
});

mysql.$on('info', (e: { message: unknown; }) => {
    logger.info('Database info:', e.message);
});

mysql.$on('warn', (e: { message: unknown; }) => {
    logger.warn('Database warning:', e.message);
});

export default mysql;
