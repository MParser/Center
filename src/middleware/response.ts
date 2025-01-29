/**
 * 响应处理中间件
 */
import { Request, NextFunction } from 'express';
import type { Response } from 'express';

/**
 * 统一响应处理工具
 */


/**
 * 响应数据接口
 */
interface ApiResponse<T = any> {
    code: number;
    data: T | null;
    message: string;
    timestamp: number;
    request_id: string;
}

/**
 * 格式化消息
 * @param message 消息内容
 * @param defaultMessage 默认消息
 * @returns 格式化后的消息
 */
const formatMessage = (message: any, defaultMessage: string): string => {
    if (message === undefined || message === null) {
        return defaultMessage;
    }
    return String(message);
};

/**
 * 格式化数据
 * @param data 数据内容
 * @returns 格式化后的数据
 */
const formatData = <T>(data: T): T | null => {
    if (data === undefined || data === null) {
        return null;
    }
    if (typeof data === 'number' && (isNaN(data) || !isFinite(data))) {
        return null;
    }
    return data;
};

/**
 * 成功响应
 * @param data 响应数据
 * @param message 响应消息
 * @param request_id 请求ID
 * @returns 统一格式的响应对象
 */
const success = <T>(data: T | null = null, message = '操作成功', request_id: string): ApiResponse<T> => ({
    code: 200,
    data: formatData(data),
    message: formatMessage(message, '操作成功'),
    timestamp: Date.now(),
    request_id
});

/**
 * 错误响应
 * @param message 错误消息
 * @param code HTTP状态码
 * @param request_id 请求ID
 * @returns 统一格式的响应对象
 */
const error = (message = '操作失败', code = 500, request_id: string): ApiResponse<null> => ({
    code,
    data: null,
    message: formatMessage(message, '操作失败'),
    timestamp: Date.now(),
    request_id
});

// 预定义的错误响应
const errors = {
    BAD_REQUEST: (message = '请求参数错误', request_id: string) =>
        error(message, 400, request_id),
    UNAUTHORIZED: (message = '未授权', request_id: string) =>
        error(message, 401, request_id),
    FORBIDDEN: (message = '禁止访问', request_id: string) =>
        error(message, 403, request_id),
    NOT_FOUND: (message = '资源不存在', request_id: string) =>
        error(message, 404, request_id),
    INTERNAL_ERROR: (message = '服务器内部错误', request_id: string) =>
        error(message, 500, request_id)
};

declare global {
    namespace Express {
        // noinspection JSUnusedGlobalSymbols
        interface Response {
            success: <T>(data?: T | null, message?: string) => void;
            error: (message?: string, code?: number) => void;
            badRequest: (message?: string) => void;
            unauthorized: (message?: string) => void;
            forbidden: (message?: string) => void;
            notFound: (message?: string) => void;
            internalError: (message?: string) => void;
            customError: (message: string, httpCode?: number) => void;
        }
    }
}

/**
 * 扩展 Response 对象，添加统一的响应方法
 */
export const responseHandler = (req: Request, res: Response, next: NextFunction): void => {
    // 添加成功响应方法
    res.success = function<T>(data?: T | null, message?: string): void {
        this.json(success(data, message, req.requestInfo.request_id));
    };

    // 添加错误响应方法
    res.error = function(message?: string, code?: number): void {
        this.json(error(message, code, req.requestInfo.request_id));
    };

    // 添加常用错误响应方法
    res.badRequest = function(message?: string): void {
        this.json(errors.BAD_REQUEST(message, req.requestInfo.request_id));
    };

    res.unauthorized = function(message?: string): void {
        this.json(errors.UNAUTHORIZED(message, req.requestInfo.request_id));
    };

    res.forbidden = function(message?: string): void {
        this.json(errors.FORBIDDEN(message, req.requestInfo.request_id));
    };

    res.notFound = function(message?: string): void {
        this.json(errors.NOT_FOUND(message, req.requestInfo.request_id));
    };

    res.internalError = function(message?: string): void {
        this.json(errors.INTERNAL_ERROR(message, req.requestInfo.request_id));
    };

    // 添加自定义错误响应方法
    res.customError = function(message: string, error_code: number = 400): void {
        this.json(error(message, error_code, req.requestInfo.request_id));
    };

    next();
};
