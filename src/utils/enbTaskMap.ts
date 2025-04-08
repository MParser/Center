/**
 * 基站任务内存映射管理器
 * 用于缓存未处理的基站任务信息，避免频繁查询数据库
 */
import mysql from '../database/mysql';
import logger from '../utils/logger';

interface EnbTaskInfo {
    enodebid: string;
    data_type: string;
    start_time: Date;
    end_time: Date;
    trigger_check: number;
}

class EnbTaskMap {
    private static instance: EnbTaskMap;
    private taskMap: Map<string, EnbTaskInfo>;
    private readonly lock: Int32Array;
    private isRefreshing: boolean;

    private constructor() {
        this.taskMap = new Map();
        // 使用SharedArrayBuffer确保多线程安全
        this.lock = new Int32Array(new SharedArrayBuffer(4));
        this.isRefreshing = false;
    }

    public static getInstance(): EnbTaskMap {
        if (!EnbTaskMap.instance) {
            EnbTaskMap.instance = new EnbTaskMap();
        }
        return EnbTaskMap.instance;
    }

    /**
     * 获取任务信息
     * @param enodebid 基站ID
     */
    public getTask(enodebid: string): EnbTaskInfo | undefined {
        // 使用Atomics.load确保读取的原子性
        if (Atomics.load(this.lock, 0) === 1) {
            return undefined;  // 如果正在刷新，返回undefined
        }
        return this.taskMap.get(enodebid);
    }

    /**
     * 获取所有未处理的任务
     */
    public getAllTasks(): EnbTaskInfo[] {
        // 使用Atomics.load确保读取的原子性
        if (Atomics.load(this.lock, 0) === 1) {
            return [];  // 如果正在刷新，返回空数组
        }
        return Array.from(this.taskMap.values());
    }

    /**
     * 刷新内存映射
     * 从数据库重新加载未处理的任务
     */
    public async refresh(): Promise<void> {
        // 如果已经在刷新中，直接返回
        if (this.isRefreshing) {
            return;
        }

        try {
            // 设置刷新标志
            this.isRefreshing = true;
            // 设置锁定状态
            Atomics.store(this.lock, 0, 1);

            // 查询所有未处理的任务
            const tasks = await mysql.enbTaskList.findMany({
                where: {
                    parsed: 0,
                    status: 0
                },
                select: {
                    enodebid: true,
                    data_type: true,
                    start_time: true,
                    end_time: true,
                    trigger_check: true
                }
            });

            // 创建新的Map
            const newMap = new Map<string, EnbTaskInfo>();
            
            // 填充数据
            for (const task of tasks) {
                newMap.set(task.enodebid, {
                    enodebid: task.enodebid,
                    data_type: task.data_type,
                    start_time: task.start_time,
                    end_time: task.end_time,
                    trigger_check: task.trigger_check
                });
            }

            // 替换旧的Map
            this.taskMap = newMap;

            logger.info(`内存映射刷新完成，共加载 ${tasks.length} 条任务`);
        } catch (error) {
            logger.error('刷新内存映射失败:', error);
            throw error;
        } finally {
            // 解除锁定状态
            Atomics.store(this.lock, 0, 0);
            this.isRefreshing = false;
        }
    }

    /**
     * 检查指定时间范围内是否有任务
     * @param enodebid 基站ID
     * @param time 时间点
     */
    public hasTaskInTimeRange(enodebid: string, time: Date): boolean {
        const task = this.getTask(enodebid);
        if (!task) {
            return false;
        }

        return time >= task.start_time && time <= task.end_time;
    }

    /**
     * 获取需要触发检查的任务
     */
    public getTasksNeedCheck(): EnbTaskInfo[] {
        return this.getAllTasks().filter(task => task.trigger_check === 0);
    }
}

// 导出单例实例
export default EnbTaskMap.getInstance();
