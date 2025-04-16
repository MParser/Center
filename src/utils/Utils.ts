/**
 * 工具类
 */

import crypto from 'crypto';

/**
 * 从文件路径中提取时间信息
 * @param filePath 文件路径
 * @returns 提取的时间，如果无法提取则返回null
 */
export function extractTimeFromPath(filePath: string): Date | null {
    const timeRegex = /\d{14}/;
    const match = filePath.match(timeRegex);
    if (!match) return null;

    const timeStr = match[0];
    return new Date(
        parseInt(timeStr.substring(0, 4)),    // 年份
        parseInt(timeStr.substring(4, 6)) - 1, // 月份
        parseInt(timeStr.substring(6, 8)),    // 日期
        parseInt(timeStr.substring(8, 10)),   // 小时
        parseInt(timeStr.substring(10, 12)),  // 分钟
        parseInt(timeStr.substring(12, 14))   // 秒数
    );
}

/**
 * 生成文件哈希值
 * @param ndsId NDSID
 * @param file_path 文件路径
 * @param sub_file_name 子文件名
 * @returns 生成的哈希值
 */
export function generateFileHash(ndsId: number, file_path: string, sub_file_name: string): string {
    const data = `${ndsId}${file_path}${sub_file_name}`;
    return crypto.createHash('md5').update(data).digest('hex');
}