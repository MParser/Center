/**
 * NDS文件控制器
 */
import { Request, Response } from 'express';
import logger from '../utils/logger';
import redis from '../database/redis'; // 添加redis导入
import { extractTimeFromPath } from '../utils/Utils';
import { taskManager } from '../database/taskdb';
import { taskListMap, refreshAllMaps } from '../utils/tableMap';


// 定义NDSFileTask请求体接口
interface NDSFileItem {
    ndsId: number;          // @db.Int
    file_path: string;      // @db.VarChar(255)
    file_time: Date;        // @db.DateTime
    data_type: string;      // @db.VarChar(64)
    sub_file_name: string;  // @db.VarChar(255)
    header_offset: number;  // @db.Int
    compress_size: number;  // @db.Int
    file_size: number;     // @db.Int
    flag_bits: number;     // @db.Int
    enodebid: string;      // @db.VarChar(16)
}

// 定义内存阈值常量
const REDIS_HIGH_MEMORY_THRESHOLD = 90;  // 高内存阈值

// 定义Redis内存检查结果接口
interface RedisMemoryCheckResult {
    isMemoryHigh: boolean;
    ratio: number;
}


export class NDSFileController { // NDSFile任务控制类
    // 定义定时器间隔（分钟）
    private static readonly TASK_CHECK_INTERVAL = 20 * 60 * 1000;

    static {
        this.startSchedule().catch(error => {
            logger.error('启动定时任务失败:', error);
        });
    }

    //检查Redis内存状态
    private static async checkRedisMemory(): Promise<RedisMemoryCheckResult> {
        const memoryInfo = await redis.getMemoryInfo();
        return {
            isMemoryHigh: memoryInfo.ratio >= REDIS_HIGH_MEMORY_THRESHOLD,
            ratio: memoryInfo.ratio
        };
    }



    /**
     * 过滤NDS文件
     * @param req 请求对象
     * @param res 响应对象
     * @returns 过滤后的NDS文件
     */
    public static async filterFiles(req: Request, res: Response): Promise<void> {
        try {
            const { ndsId, data_type, file_paths } = req.body; // 获取请求体参数
            if (!ndsId || !data_type || !Array.isArray(file_paths) || file_paths.length === 0) {
                res.badRequest('参数错误');
                return;
            }
            
            // 检查Redis状态,如果负荷过高，取消处理
            const { isMemoryHigh } = await NDSFileController.checkRedisMemory();
            if (isMemoryHigh) {
                res.customError('Redis内存负荷过高，无法处理请求', 429);
                return;
            }

            // 使用Redis过滤已存在的文件
            const nonExistingPaths = await redis.filterNonExistingPaths(ndsId, file_paths);
            if (nonExistingPaths.length === 0) {
                res.success([]);
                return;
            }

            // 过滤非任务时间文件和数据类型
            const tasks = await taskListMap.getTaskMap();
            if (tasks.length === 0) {
                res.success([]);
                return;
            }

            const filteredPaths = nonExistingPaths.reduce<string[]>((acc, path) => {
                const fileTime = extractTimeFromPath(path); // 提取文件路径中的时间信息
                if (!fileTime) return acc; // 如果无法提取时间信息，跳过
                if (tasks.some(item => {  // 检查是否在任务时间范围内, 如果在任务时间范围内，加入结果
                    const fileTimeMs = fileTime.getTime();
                    return fileTimeMs >= item.start_time.getTime() && fileTimeMs <= item.end_time.getTime();
                })) {acc.push(path);}
                return acc;
            }, []);
            res.success(filteredPaths);
        } catch (error: any) {
            logger.error('过滤NDS文件出错:', error);
            res.internalError('过滤NDS文件出错');
        }
    }

    /**
     * 批量添加NDS文件任务
     * @param req 请求对象
     * @param res 响应对象
     * @returns 添加结果
     */
    public static async batchAddTasks(req: Request, res: Response): Promise<void> {
        try {
            const items: NDSFileItem[] = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                res.badRequest('参数错误');
                return;
            }

            // 检查Redis状态,如果负荷过高，取消处理
            const { isMemoryHigh } = await NDSFileController.checkRedisMemory();
            if (isMemoryHigh) {
                res.customError('Redis内存负荷过高，无法处理请求', 429);
                return;
            }
            
            // 转换数据类型并处理无效日期
            const itemsWithTypes = items.reduce<NDSFileItem[]>((acc, item) => {
                // 处理日期：尝试从原始日期或文件路径中提取日期
                let file_time = new Date(item.file_time);
                // 检查日期是否有效
                if (isNaN(file_time.getTime())) {
                    const extractedTime = extractTimeFromPath(item.file_path); // 从文件路径中提取日期
                    if (!extractedTime) return acc;// 如果无法解析日期，则跳过该记录
                    file_time = extractedTime;
                }
                acc.push({ 
                    ...item, ndsId: Number(item.ndsId), header_offset: Number(item.header_offset), compress_size: Number(item.compress_size), 
                    file_size: Number(item.file_size), flag_bits: Number(item.flag_bits), file_time: file_time
                });
                return acc;
            }, []); 
            // 调用任务管理器添加任务
            const transactionResult = await taskManager.addTask(itemsWithTypes)
            res.success(transactionResult);
        } catch (error: any) {
            logger.error('批量添加NDS文件任务出错:', error);
            res.internalError(`批量添加NDS文件任务出错 ${error}`);
        }
    }

    /**
     * 更新任务状态
     * @param req 请求对象
     * @param res 响应对象
     * @returns 更新结果
     */
    public static async updateTaskStatus(req: Request, res: Response): Promise<void> {
        const { file_hash, file_path, status } = req.body;
        if (!file_hash || !file_path || status === undefined) {
            res.badRequest('参数错误');
            return;
        }

        const file_time = extractTimeFromPath(file_path); // 提取文件路径中的时间信息
        if (!file_time) {
            res.badRequest('无法提取文件时间');
            return;
        }

        // 调用任务管理器更新任务状态
        const transactionResult = await taskManager.updateTask(file_hash, file_time, status)
        if (transactionResult) {
            res.success("更新成功"); 
        }else {
            res.internalError("更新失败"); 
        }
    }


    /**
     * 定时任务流程函数
     */
    public static async scheduleTask(): Promise<void> {
        try {
            refreshAllMaps().finally();
        } catch (error) {
            logger.error('定时处理未处理任务出错:', error);
        }
    }

    // 静态初始化块
    static async startSchedule(): Promise<void> {
        // 延迟5秒后开始第一次任务检查
        await new Promise(resolve => setTimeout(resolve, 5000));
        setInterval(async () => { await this.scheduleTask(); }, this.TASK_CHECK_INTERVAL); 
        logger.info('NDSFiles - 定时任务已启动');
    }

}
// // noinspection JSIgnoredPromiseFromCall
// NDSFileController.startSchedule();

export default NDSFileController;
