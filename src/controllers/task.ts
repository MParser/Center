/**
 * 任务控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';
import enbTaskMap from '../utils/enbTaskMap';

/**
 * 任务创建数据类型
 */
interface TaskCreate {
    name: string;
    data_type: string;
    start_time: string;
    end_time: string;
    remark?: string;
    enodebids: string[];
}

export class TaskController {
    // 静态初始化代码
    static {
        // 初始化任务映射
        enbTaskMap.refresh().then(() => {
            logger.info('任务映射初始化完成');
        }).catch(error => {
            logger.error('任务映射初始化失败:', error);
        });

        // // 启动任务检查器
        // taskChecker.start();
    }

    /**
     * 获取任务列表
     */
    static async list(_req: Request, res: Response): Promise<void> {
        try {
            const taskList = await mysql.taskList.findMany({
                orderBy: {
                    createdAt: 'desc'
                }
            });
            res.success(taskList, '获取任务列表成功');
        } catch (error: any) {
            logger.error('获取任务列表失败:', error);
            res.internalError('获取任务列表失败');
        }
    }

    /**
     * 获取任务时间范围
     */
    static async getTimeRange(_req: Request, res: Response): Promise<void> {
        try {
            // 直接在数据库中进行去重查询
            const uniqueTimeRanges = await mysql.$queryRaw`
                SELECT DISTINCT start_time, end_time 
                FROM \`task_list\`
                ORDER BY start_time DESC
            `;

            res.success(uniqueTimeRanges, '获取任务时间范围成功');

        } catch (error: any) {
            logger.error('获取任务时间范围失败:', error);
            res.internalError('获取任务时间范围失败');
        }
    }

    /**
     * 获取任务详情（包括关联的基站任务）
     */
    static async get(req: Request, res: Response): Promise<void> {
        try {
            const id = parseInt(req.params.id);

            // 获取任务信息和关联的基站任务
            const task = await mysql.taskList.findUnique({
                where: { id: id }
            });

            if (!task) {
                res.notFound('任务不存在');
                return;
            }

            // 获取关联的基站任务
            const enbTasks = await mysql.enbTaskList.findMany({
                where: { taskId: id },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            res.success({
                ...task,
                enb_tasks: enbTasks
            }, '获取任务详情成功');
        } catch (error: any) {
            logger.error('获取任务详情失败:', error);
            res.internalError('获取任务详情失败');
        }
    }

    /**
     * 创建任务（同时创建基站任务）
     */
    static async create(req: Request, res: Response): Promise<void> {
        try {
            const data = req.body as TaskCreate;

            // 使用事务确保数据一致性
            const result = await mysql.$transaction(async (tx) => {
                // 1. 创建主任务
                const task = await tx.taskList.create({
                    data: {
                        name: data.name,
                        data_type: data.data_type,
                        remark: data.remark,
                        start_time: data.start_time,
                        end_time: data.end_time
                    }
                });

                // 2. 创建基站任务
                const enbTasks = await tx.enbTaskList.createMany({
                    data: data.enodebids.map(enodebid => ({
                        taskId: task.id,
                        enodebid: enodebid,
                        data_type: data.data_type,
                        start_time: new Date(data.start_time),
                        end_time: new Date(data.end_time),
                        trigger_check: 0  // 新任务需要触发检查
                    }))
                });

                return {
                    task,
                    enbTasksCount: enbTasks.count
                };
            });

            // 刷新内存映射
            await enbTaskMap.refresh();

            res.success(result, '创建任务成功');
        } catch (error: any) {
            logger.error('创建任务失败:', error);
            res.internalError('创建任务失败');
        }
    }

    /**
     * 删除任务（同时删除关联的基站任务）
     */
    static async delete(req: Request, res: Response): Promise<void> {
        try {
            const id = parseInt(req.params.id);

            // 使用事务确保数据一致性
            await mysql.$transaction(async (tx) => {
                // 1. 删除关联的基站任务
                await tx.enbTaskList.deleteMany({
                    where: { taskId: id }
                });

                // 2. 删除主任务
                await tx.taskList.delete({
                    where: { id }
                });
            });

            // 刷新内存映射
            await enbTaskMap.refresh();

            res.success(null, '删除任务成功');
        } catch (error: any) {
            logger.error('删除任务失败:', error);
            res.internalError('删除任务失败');
        }
    }

    /**
     * 检查指定基站在指定时间是否有任务
     */
    static async checkTime(req: Request, res: Response): Promise<void> {
        try {
            const { enodebid, time } = req.query;

            // 参数验证
            if (!enodebid || !time || typeof enodebid !== 'string' || typeof time !== 'string') {
                res.badRequest('参数错误: 需要提供 enodebid 和 time');
                return;
            }

            // 验证时间格式
            const checkTime = new Date(time);
            if (isNaN(checkTime.getTime())) {
                res.badRequest('参数错误: time 格式不正确');
                return;
            }

            // 使用内存映射检查
            const hasTask = enbTaskMap.hasTaskInTimeRange(enodebid, checkTime);

            if (hasTask) {
                // 如果有任务，获取具体任务信息
                const taskInfo = enbTaskMap.getTask(enodebid);
                res.success({
                    hasTask: true,
                    taskInfo: {
                        enodebid: taskInfo?.enodebid,
                        start_time: taskInfo?.start_time,
                        end_time: taskInfo?.end_time,
                        trigger_check: taskInfo?.trigger_check
                    }
                }, '在指定时间范围内存在任务');
            } else {
                res.success({
                    hasTask: false,
                    taskInfo: null
                }, '在指定时间范围内不存在任务');
            }
        } catch (error) {
            logger.error('检查任务时间范围失败:', error);
            res.internalError('检查任务时间范围失败');
        }
    }
}
