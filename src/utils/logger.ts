/**
 * 日志工具
 * 统一的日志处理模块
 */

import { config } from './config';

// 日志级别定义
const enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

type LogLevelStrings = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevelStrings, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG
};

/**
 * 获取当前配置的日志级别
 * @returns {LogLevel} 日志级别数值
 */
const getLogLevel = (): LogLevel => {
  const configLevel = config.get<string>('log.level', 'info');
  if (!configLevel || typeof configLevel !== 'string') {
    return LogLevel.INFO;
  }
  const level = configLevel.toLowerCase() as LogLevelStrings;
  return LOG_LEVELS[level] !== undefined ? LOG_LEVELS[level] : LogLevel.INFO;
};

/**
 * 检查是否应该记录该级别的日志
 * @param {LogLevelStrings} level 日志级别
 * @returns {boolean} 是否应该记录
 */
const shouldLog = (level: LogLevelStrings): boolean => {
  const currentLevel = getLogLevel();
  return LOG_LEVELS[level] <= currentLevel;
};

/**
 * 格式化参数为字符串
 * @param {unknown} arg 参数
 * @returns {string} 格式化后的字符串
 */
const formatArg = (arg: unknown): string => {
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg === 'symbol') return arg.toString();
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
  }
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
};

/**
 * 格式化日志消息
 * @param {LogLevelStrings} level 日志级别
 * @param {unknown[]} args 日志参数
 * @returns {string} 格式化后的日志
 */
const formatLog = (level: LogLevelStrings, args: unknown[]): string => {
  const timestamp = new Date().toISOString();
  const message = args.map(formatArg).join(' ');
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
};

// 日志接口类型定义
interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

// 日志接口实现
const logger: Logger = {
  error: (...args: unknown[]): void => {
    if (shouldLog('error')) {
      console.error(formatLog('error', args));
    }
  },

  warn: (...args: unknown[]): void => {
    if (shouldLog('warn')) {
      console.warn(formatLog('warn', args));
    }
  },

  info: (...args: unknown[]): void => {
    if (shouldLog('info')) {
      console.info(formatLog('info', args));
    }
  },

  debug: (...args: unknown[]): void => {
    if (shouldLog('debug')) {
      console.debug(formatLog('debug', args));
    }
  }
};

export default logger;
