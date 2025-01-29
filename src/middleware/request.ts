import { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';

/**
 * 获取客户端真实IP
 */
const getClientIP = (req: any): string => {
    const forwardedFor = req.headers['x-forwarded-for']
    if (forwardedFor) {
        const ip = forwardedFor.split(',')[0].trim()
        if (ip && ip !== '::1' && ip !== '127.0.0.1') {
            return ip
        }
    }
    const realIP = req.headers['x-real-ip']
    if (realIP && realIP !== "::1" && realIP !== "127.0.0.1") {
        return realIP;
    }
    const ip = req.socket.remoteAddress;
    if (ip) {
        // 去除IPv6前缀
        const realIP = ip.replace(/^::ffff:/, "");
        if (realIP && realIP === "::1") {
            return "127.0.0.1";
        }
        return realIP;
    }
    return "127.0.0.1";
};

/**
 * 请求处理中间件
 */
declare global {
    namespace Express {
        // noinspection JSUnusedGlobalSymbols
        interface Request {
            requestInfo: {
                ip: string;
                timestamp: number;
                method: string;
                path: string;
                userAgent?: string;
                request_id: string;
            };
        }
    }
}

/**
 * 请求信息处理中间件
 * 为每个请求添加统一的请求信息对象
 */
export const requestHandler = (req: Request, _res: Response, next: NextFunction): void => {
    // 添加统一的请求信息
    req.requestInfo = {
        ip: getClientIP(req),
        timestamp: Date.now(),
        method: req.method,
        path: req.path,
        userAgent: req.headers['user-agent'],
        request_id: req.body.request_id || req.params.request_id || uuid(),
    };

    next();
};
