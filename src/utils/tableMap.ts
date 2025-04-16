
/**
 * 任务内存映射管理器
 * 用于缓存任务信息，避免频繁查询数据库
 */
import mysql from '../database/mysql';
import logger from '../utils/logger';
import { Mutex } from 'async-mutex';

interface TaskInfo {
    id: number;
    name: string;
    data_type: string;
    start_time: Date;
    end_time: Date;
    status: number;
}

interface EnbTaskInfo {
    id: number;
    taskId: number;
    enodebid: string;
    data_type: string;
    start_time: Date;
    end_time: Date;
    parsed: number;
    status: number;
    trigger_check: number;
}

export class TaskListMap {
    private static instance: TaskListMap;
    private taskMap: TaskInfo[];
    private readonly mutex: Mutex;
    private isRefreshing: boolean;

    private constructor() {
        this.taskMap = [];
        // 使用Mutex确保多线程安全
        this.mutex = new Mutex();
        this.isRefreshing = false;
        this.refresh().finally();
    }

    public static getInstance(): TaskListMap {
        if (!TaskListMap.instance) {
            TaskListMap.instance = new TaskListMap();
        }
        return TaskListMap.instance;
    }


    /**
     * 刷新内存映射
     * 从数据库重新加载任务
     */
    public async refresh(): Promise<void> {
        // 如果已经在刷新中，直接返回
        if (this.isRefreshing) {
            return;
        }

        // 获取互斥锁
        const release = await this.mutex.acquire();
        try {
            // 设置刷新标志
            this.isRefreshing = true;
            // 查询所有未完成任务
            const tasks = await mysql.taskList.findMany({
                select: { id: true, name: true, data_type: true, start_time: true, end_time: true, status: true },
                where: { status: 0 }
            });
            this.taskMap = tasks;

            logger.info(`任务清单映射刷新完成，共加载 ${tasks.length} 条数据`);
        } catch (error) {
            logger.error('刷新任务内存映射失败:', error);
            throw error;
        } finally {
            // 解除刷新标志
            this.isRefreshing = false;
            // 释放互斥锁
            release();
        }
    }

    /**
     * 获取任务信息
     * @param id 任务ID
     */
    public async getTaskMap(): Promise<TaskInfo[]> {
        // 使用互斥锁确保数据一致性
        return await this.mutex.runExclusive(() => {
            return this.taskMap;
        });
    }
}

export class EnbTaskListMap {
    private static instance: EnbTaskListMap;
    private taskMap: EnbTaskInfo[];
    private readonly mutex: Mutex;
    private isRefreshing: boolean;

    private constructor() {
        this.taskMap = [];
        // 使用Mutex确保多线程安全
        this.mutex = new Mutex();
        this.isRefreshing = false;
        this.refresh().finally();
    }

    public static getInstance(): EnbTaskListMap {
        if (!EnbTaskListMap.instance) {
            EnbTaskListMap.instance = new EnbTaskListMap();
        }
        return EnbTaskListMap.instance;
    }

    /**
     * 刷新内存映射
     * 从数据库重新加载任务
     */
    public async refresh(): Promise<void> {
        // 如果已经在刷新中，直接返回
        if (this.isRefreshing) {
            return;
        }

        // 获取互斥锁
        const release = await this.mutex.acquire();
        try {
            // 设置刷新标志
            this.isRefreshing = true;

            // 查询所有未完成任务
            const tasks = await mysql.enbTaskList.findMany({
                select: { id: true, taskId: true, enodebid: true, data_type: true, start_time: true, end_time: true, parsed: true, status: true, trigger_check: true },
                where: { parsed: 0, status: 0 }
            });

            // 创建新的数组
            const newArray: EnbTaskInfo[] = [];
            
            // 填充数据
            for (const task of tasks) {
                newArray.push({
                    id: task.id,
                    taskId: task.taskId,
                    enodebid: task.enodebid,
                    data_type: task.data_type,
                    start_time: task.start_time,
                    end_time: task.end_time,
                    parsed: task.parsed,
                    status: task.status,
                    trigger_check: task.trigger_check
                });
            }

            // 替换旧的数组
            this.taskMap = newArray;

            logger.info(`ENB任务清单映射刷新完成，共加载 ${tasks.length} 条数据`);
        } catch (error) {
            logger.error('ENB任务清单映射失败:', error);
            throw error;
        } finally {
            // 解除刷新标志
            this.isRefreshing = false;
            // 释放互斥锁
            release();
        }
    }

    /**
     * 获取所有任务信息
     */
    public async getTaskMap(): Promise<EnbTaskInfo[]> {
        // 使用互斥锁确保数据一致性
        return await this.mutex.runExclusive(() => {
            return this.taskMap;
        });
    }

}

export class CellDataENBMap {
    private static instance: CellDataENBMap;
    private enbMap: number[];
    private readonly mutex: Mutex;
    private isRefreshing: boolean;

    private constructor() {
        this.enbMap = [];
        // 使用Mutex确保多线程安全
        this.mutex = new Mutex();
        this.isRefreshing = false;
        this.refresh().finally();
    }

    public static getInstance(): CellDataENBMap {
        if (!CellDataENBMap.instance) CellDataENBMap.instance = new CellDataENBMap();
        return CellDataENBMap.instance;
    }

    /**
     * 刷新内存映射
     * 从数据库重新加载任务
     */
    public async refresh(): Promise<void> {
        // 如果已经在刷新中，直接返回
        if (this.isRefreshing) return;
        
        // 获取互斥锁
        const release = await this.mutex.acquire();
        try {
            this.isRefreshing = true; // 设置刷新标志
            const enbIDs = await mysql.cellData.findMany({ select: {eNodeBID: true}, distinct: ['eNodeBID'] }) // 查询所有eNodeBID并去重(Disinct)
            this.enbMap = enbIDs.map(item => item.eNodeBID); // 将查询结果转换为number数组
            logger.info(`eNBID清单刷新完成，共加载 ${enbIDs.length} 条数据`);
        } catch (error) {
            logger.error('刷新CellData-eNodeBID清单内存映射失败:', error);
            throw error;
        } finally {
            CellDataENBMap.instance.isRefreshing = false; // 解除刷新标志
            release(); // 释放互斥锁
        }
    }

    /**
     * 获取所有eNodeBID
     */
    public async getENBMap(): Promise<number[]> {
        // 使用互斥锁确保数据一致性
        return await this.mutex.runExclusive(() => {
            return this.enbMap;
        });
    }
}


export async function refreshAllMaps() {
    await taskListMap.refresh();
    await enbTaskListMap.refresh();
    await cellDataENBMap.refresh(); 
}

// 导出单例实例
export const taskListMap = TaskListMap.getInstance();
export const enbTaskListMap = EnbTaskListMap.getInstance();
export const cellDataENBMap = CellDataENBMap.getInstance();


