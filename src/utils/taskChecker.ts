/**
 * 任务完成状态检查器
 * 定时检查任务是否完成，并更新状态
 */
import mysql from '../database/mysql';
import logger from '../utils/logger';
import { addMinutes } from 'date-fns';
import enbTaskMap from './enbTaskMap';

interface NdsTimeMap {
    [ndsid: string]: {
        min_time: Date;
        max_time: Date;
    }
}

interface EnbTaskMap {
    [enodebid: string]: EnbTaskMapItem;
}

interface EnbTaskMapItem {
    taskId: number;
    parsed_0_1_count: number;    // parsed=0或1的数量
    parsed_other_count: number;  // parsed非0且不等于1的数量
    end_time: Date;
    data_type: string;
}

export class TaskChecker {
    private static instance: TaskChecker;
    private checkInterval: NodeJS.Timeout | null = null;
    private isChecking: boolean = false;

    private constructor() {}

    public static getInstance(): TaskChecker {
        if (!TaskChecker.instance) {
            TaskChecker.instance = new TaskChecker();
        }
        return TaskChecker.instance;
    }

    /**
     * 启动定时检查
     */
    public start(): void {
        if (this.checkInterval) {
            return;
        }

        logger.info('启动任务完成状态检查器');
        this.checkInterval = setInterval(() => {
            this.check().catch(error => {
                logger.error('任务完成状态检查失败:', error);
            });
        }, 5 * 60 * 1000); // 每5分钟执行一次
    }

    /**
     * 停止定时检查
     */
    public stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.info('停止任务完成状态检查器');
        }
    }

    /**
     * 执行检查
     */
    private async check(): Promise<void> {
        if (this.isChecking) {
            logger.warn('上一次检查尚未完成，跳过本次检查');
            return;
        }

        this.isChecking = true;
        let hasUpdates = false;  // 添加标记，记录是否有更新

        try {
            // 1. 获取nds时间映射
            const ndsTimeMap = await this.getNdsTimeMap();
            
            // 2. 获取未完成的任务映射
            const enbMap = await this.getEnbTaskMap();

            // 3. 获取最小的最大时间作为判断时间
            const minMaxTime = this.getMinMaxTime(ndsTimeMap);
            if (!minMaxTime) {
                logger.info('没有可用的NDS时间数据');
                return;
            }

            // 4. 检查每个任务是否完成
            const updates = await this.checkTasks(enbMap, minMaxTime);
            hasUpdates = updates > 0;

            // 5. 如果有更新，刷新内存映射
            if (hasUpdates) {
                await enbTaskMap.refresh();
                logger.info('任务状态更新完成，内存映射已刷新');
            }

        } finally {
            this.isChecking = false;
        }
    }

    /**
     * 获取NDS时间映射
     */
    private async getNdsTimeMap(): Promise<NdsTimeMap> {
        // 直接使用聚合查询获取每个ndsId的最大最小时间
        const results = await mysql.$queryRaw<Array<{
            ndsId: string;
            min_time: Date;
            max_time: Date;
        }>>`
            SELECT 
                ndsId,
                MIN(file_time) as min_time,
                MAX(file_time) as max_time
            FROM ndsFileList
            GROUP BY ndsId
        `;

        const timeMap: NdsTimeMap = {};
        for (const row of results) {
            timeMap[row.ndsId] = {
                min_time: row.min_time,
                max_time: row.max_time
            };
        }
        return timeMap;
    }

    /**
     * 获取未完成任务的映射
     */
    private async getEnbTaskMap(): Promise<EnbTaskMap> {
        // 1. 获取所有未完成的任务
        const tasks = await mysql.enbTaskList.findMany({
            where: {
                parsed: 0,
                status: 0
            },
            select: {
                taskId: true,
                enodebid: true,
                end_time: true,
                data_type: true
            }
        });

        const enbMap: EnbTaskMap = {};

        // 2. 获取每个任务的文件统计
        for (const task of tasks) {
            const endTime = task.end_time;
            const endTimePlus15 = addMinutes(endTime, 15);

            // 使用原生SQL查询优化性能
            const [counts] = await mysql.$queryRaw<Array<{
                parsed_0_1_count: number;
                parsed_other_count: number;
            }>>`
                SELECT 
                    COUNT(CASE WHEN parsed IN (0, 1) THEN 1 END) as parsed_0_1_count,
                    COUNT(CASE WHEN parsed NOT IN (0, 1) THEN 1 END) as parsed_other_count
                FROM ndsFileList
                WHERE data_type = ${task.data_type}
                AND file_time BETWEEN ${endTime} AND ${endTimePlus15}
                AND enodebid = ${task.enodebid}
            `;

            enbMap[task.enodebid] = {
                taskId: task.taskId,
                parsed_0_1_count: Number(counts.parsed_0_1_count),
                parsed_other_count: Number(counts.parsed_other_count),
                end_time: task.end_time,
                data_type: task.data_type
            };
        }

        return enbMap;
    }

    /**
     * 获取最小的最大时间
     */
    private getMinMaxTime(ndsTimeMap: NdsTimeMap): Date | null {
        const maxTimes = Object.values(ndsTimeMap).map(t => t.max_time);
        if (maxTimes.length === 0) {
            return null;
        }
        return new Date(Math.min(...maxTimes.map(t => t.getTime())));
    }

    /**
     * 检查任务是否完成
     * @returns 更新的任务数量
     */
    private async checkTasks(enbMap: EnbTaskMap, minMaxTime: Date): Promise<number> {
        let updateCount = 0;
        for (const [enodebid, task] of Object.entries(enbMap)) {
            // 检查是否超过结束时间15分钟
            if (minMaxTime > addMinutes(task.end_time, 15)) {
                if (task.parsed_0_1_count === 0) {
                    if (task.parsed_other_count > 0) {
                        // 直接标记为完成
                        await this.markTaskCompleted(task.taskId, enodebid);
                        updateCount++;
                        continue;
                    }

                    // 检查同taskId的其他enodebid是否有完成的
                    const hasOtherCompleted = await this.checkOtherEnodebTasks(task.taskId, enodebid);
                    if (hasOtherCompleted) {
                        await this.markTaskCompleted(task.taskId, enodebid);
                        updateCount++;
                    }
                }
            }
        }
        return updateCount;
    }

    /**
     * 检查同一任务的其他基站是否有完成的
     */
    private async checkOtherEnodebTasks(taskId: number, currentEnodebid: string): Promise<boolean> {
        // 先获取当前任务的 data_type
        const task = await mysql.enbTaskList.findFirst({
            where: {
                taskId: taskId,
                enodebid: currentEnodebid
            },
            select: {
                data_type: true
            }
        });

        if (!task) {
            return false;
        }

        // 使用原生SQL查询，只返回是否存在
        const [result] = await mysql.$queryRaw<Array<{ exists: number }>>`
            SELECT EXISTS (
                SELECT 1
                FROM enb_task_list et
                INNER JOIN ndsFileList nf 
                    ON et.enodebid = nf.enodebid 
                    AND et.data_type = nf.data_type
                WHERE et.taskId = ${taskId}
                AND et.enodebid != ${currentEnodebid}
                AND et.status = 0
                AND nf.parsed NOT IN (0, 1)
                AND nf.file_time BETWEEN et.start_time AND et.end_time
                LIMIT 1
            ) as exists
        `;

        return result.exists === 1;
    }

    /**
     * 标记任务为已完成
     */
    private async markTaskCompleted(taskId: number, enodebid: string): Promise<void> {
        await mysql.enbTaskList.updateMany({
            where: {
                taskId,
                enodebid
            },
            data: {
                parsed: 1
            }
        });
        
        logger.info(`任务已完成: taskId=${taskId}, enodebid=${enodebid}`);
    }
}

// 导出单例实例
export default TaskChecker.getInstance();
