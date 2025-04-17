import mysql from './mysql';
import redis from './redis';
import { Mutex } from 'async-mutex';
import logger from '../utils/logger';
import { generateFileHash } from '../utils/Utils';
import { enbTaskListMap, cellDataENBMap} from '../utils/tableMap';



interface PartitionInfo {
    PARTITION_NAME: string;
}

interface Partition {
    name: string; // 分区名称
    date: Date; // 分区实际数据时间
    p_date: string; // 分区日期字符串
}

class PartitionManager {
    private static instance: PartitionManager;
    public partitions: Map<string, Date>;
    private readonly mutex: Mutex;
    
    private constructor() {
        this.partitions = new Map<string, Date>();
        this.mutex = new Mutex();
    }

    public static getInstance(): PartitionManager {
        if (!PartitionManager.instance) {
            PartitionManager.instance = new PartitionManager();
        }
        return PartitionManager.instance;
    }

    /**
     * 转换时间为分区配置信息
     * @param time 时间
     * @returns <string, Date>
     */
    public convertTimeToPartition(time: Date): Partition {
        try {

            // 将传入时间+1天
            const newTime = new Date(time);
            newTime.setDate(newTime.getDate() + 1);  // 正确的日期加1天方法
            
            let year = time.getFullYear();
            let month = time.getMonth() + 1; // 月份从0开始，需要加1
            let day = time.getDate();
            // 生成分区名称
            const partitionName = `p_${year}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
            // 生成分区日期
            year = newTime.getFullYear();
            month = newTime.getMonth() + 1; // 月份从0开始，需要加1
            day = newTime.getDate();
            return  { name: partitionName, date: time, p_date: `${year}-${month}-${day}` }; 
        } catch (error) {
            logger.error('PartitionManager convertTimeToPartition error:'+ error);
            return { name: '', date: new Date(), p_date: '' }; 
        }
    }


    public async initPartitionMap(): Promise<void>  {
        try {
           const release = await this.mutex.acquire();
           try {
                this.partitions.clear();
                const partitions = await mysql.$queryRaw<PartitionInfo[]>`SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE table_name = 'nds_file_list' ORDER BY PARTITION_NAME ASC;`;
                partitions.forEach(partition => { 
                    const partitionName = partition.PARTITION_NAME;
                    if (typeof partitionName === 'string' && partitionName.startsWith('p_') && partitionName.length === 10) {
                        const dateStr = partitionName.substring(2); // 去掉p_前缀
                        // 转换为YYYY-MM-DD格式的日期
                        const year = dateStr.substring(0, 4);
                        const month = dateStr.substring(4, 6);
                        const day = dateStr.substring(6, 8);
                        const dateFormatted = `${year}-${month}-${day}`;
                        const partitionDate = new Date(dateFormatted);
                        this.partitions.set(partitionName, partitionDate);
                    }
                });
                logger.info('初始化分区映射成功');
            } catch (error) {
                logger.error('PartitionManager initPartitionMap error: ' + error); 
            } finally {
                release();
            }
        } catch (error) {
            logger.error('PartitionManager initPartitionMap error:'+ error);
        }
    }

    public async getPartitionMap(): Promise<Map<string, Date>> {
        let partitions: Map<string, Date>;
        const release = await this.mutex.acquire();
        try {
            partitions = this.partitions;  
        } finally {
            release(); 
        }
        return new Map([...partitions.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()));

    }

    public async addPartition(file_time: Date): Promise<void> {
        const partition = this.convertTimeToPartition(file_time);
        if (partition.name === '') return;
        if (this.partitions.has(partition.name)) return; // 已经存在
        
        const release = await this.mutex.acquire();
        try {
            if (this.partitions.has(partition.name)) return; // 再次判断, 避免并发
            if (this.partitions.size === 0) { // 第一次添加
                logger.info('当前无分区, 正在初始化分区...');
                const createPartitionSql = `ALTER TABLE nds_file_list PARTITION BY RANGE (TO_DAYS(file_time)) (PARTITION ${partition.name} VALUES LESS THAN (TO_DAYS('${partition.p_date}')));`;
                await mysql.$executeRawUnsafe(createPartitionSql);
                logger.info('添加分区:'+ partition.name);
                this.partitions.set(partition.name, partition.date)
                return ;
            }
            // 查找所有分区中的最大日期值
            let findDate = new Date(0); // 初始化为最小日期
            for (const [_, date] of this.partitions.entries()) { if (date.getTime() > findDate.getTime()) findDate = date; }
            const isGreaterThanMaxDate = partition.date.getTime() > findDate.getTime(); // 判断传入日期是否大于最大日期
            if (isGreaterThanMaxDate) { // 大于最大日期, 使用ADD方法往后顺延分区序列
                const dates: Date[] = [];
                let currentDate = findDate;
                while (currentDate.getTime() <= partition.date.getTime()) {
                    dates.push(new Date(currentDate));
                    currentDate.setDate(currentDate.getDate() + 1);
                }
                for (const date of dates) {
                    try {
                        const partition = this.convertTimeToPartition(date);
                        const addPartitionSql = `ALTER TABLE nds_file_list ADD PARTITION (PARTITION ${partition.name} VALUES LESS THAN (TO_DAYS('${partition.p_date}')));`;
                        if (this.partitions.has(partition.name)) continue;
                        await mysql.$executeRawUnsafe(addPartitionSql); 
                        this.partitions.set(partition.name, partition.date);
                        logger.info('添加分区:['+ partition.name + '] - Date: ('+ partition.p_date + ')成功');
                    }catch(err) {
                        logger.warn(`ALTER TABLE nds_file_list ADD PARTITION (PARTITION ${partition.name} VALUES LESS THAN (TO_DAYS('${partition.p_date}')));`)
                        logger.warn('添加分区:['+ partition.name + '] - Date: ('+ partition.p_date + ')失败; ' + err);
                    }
                }
            } else { // 小于最大日期, 使用重构结构的方式进行插入
                // 获取最小日期
                findDate = partition.date; // 初始化为最小日期
                // 遍历所有分区, 找到最小日期, 作为新的最小日期
                for (const [_, date] of this.partitions.entries()) { if (date.getTime() < findDate.getTime()) findDate = date; }
                // 生成所有分区
                const startDate = findDate.getTime();
                const endDate = partition.date.getTime();
                const dates: Date[] = [];
                let currentDate = new Date(startDate);
                while (currentDate.getTime() <= endDate) {
                    dates.push(new Date(currentDate));
                    currentDate.setDate(currentDate.getDate() + 1);
                }
                for (const date of dates) {
                    const partition = this.convertTimeToPartition(date);
                    this.partitions.set(partition.name, partition.date);
                }
                const sortedPartitions = [...this.partitions.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()); // 日期从小到大排序
                let partitionSql = `ALTER TABLE nds_file_list PARTITION BY RANGE (TO_DAYS(file_time)) (`;
                for (let i = 0; i < sortedPartitions.length; i++) {
                    const [p_name, p_date] = sortedPartitions[i];
                    const p = this.convertTimeToPartition(p_date);
                    partitionSql += `PARTITION ${p_name} VALUES LESS THAN (TO_DAYS('${p.p_date}'))${i === sortedPartitions.length - 1? '' : ','}`;
                }
                partitionSql += ');';
                await mysql.$executeRawUnsafe(partitionSql);
                logger.info(`成功重建分区结构，添加分区: ${partition.name}`);

            }
            this.partitions.set(partition.name, partition.date);
            const partitions = this.partitions;
            const sortedPartitions = new Map([...partitions.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()));
            this.partitions = sortedPartitions;
        } catch (error) {
            logger.error(`添加分区[${partition.name} - ${partition.p_date}]失败:`+ error); 
        } finally {

            release();
        }
    }

    public async delPartition(file_time: Date): Promise<void> {
        const partition = this.convertTimeToPartition(file_time);
        if (partition.name === '') return;
        if (!this.partitions.has(partition.name)) return; // 不存在

        const release = await this.mutex.acquire();
        try {
            if (!this.partitions.has(partition.name)) return; // 再次判断, 避免并发
            const delPartitionSql = `ALTER TABLE nds_file_list DROP PARTITION ${partition.name};`;
            await mysql.$executeRawUnsafe(delPartitionSql); 
            this.partitions.delete(partition.name);
            logger.info(`成功删除分区: ${partition.name}`);
        }catch (error) {
            logger.error('删除分区失败:'+ error); 
        } finally {
            release();
        }
    }

    /**
     * 清理过期分区
     * @param retentionDays 保留天数
     */
    public async cleanExpiredPartitions(retentionDays: number = 45): Promise<void> {
        try {
           // 获取分区列表中最大的日期,作为基准,删除基准-retentionDays天之前的分区
            const partitionMap = await this.getPartitionMap();
            if (partitionMap.size === 0) return;
            let maxDate = new Date(0); // 初始化为最小日期
            for (const [_, date] of partitionMap.entries()) { if (date.getTime() > maxDate.getTime()) maxDate = date; }
            const retentionDate = new Date(maxDate.getTime() - retentionDays * 24 * 60 * 60 * 1000); // 计算保留日期
            const partitions = [...partitionMap.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()); // 日期从小到大排序
            for (const [_, p_date] of partitions) { if (p_date.getTime() < retentionDate.getTime()) await this.delPartition(p_date); } 
        }catch (error) {
            logger.error('清理过期分区失败:'+ error);
        }
    }

}


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

interface NDSFileWithTask {
    file_hash: string;      // @db.VarChar(128)
    ndsId: number;          // @db.Int
    file_path: string;      // @db.VarChar(255)
    file_time: Date;        // @db.DateTime
    data_type: string;      // @db.VarChar(64)
    sub_file_name: string;  // @db.VarChar(255)
    header_offset: number;  // @db.Int
    compress_size: number;  // @db.Int
    file_size: number;      // @db.Int
    flag_bits: number;      // @db.Int
    enodebid: string;      // @db.VarChar(16)
    parsed: number;         // @db.Int
    createdAt: Date;        // @db.DateTime
    updatedAt: Date;        // @db.DateTime
}

interface AddTaskResult {
    total: number;       // 成功插入数据库的总数
    filtered: number;    // 经过eNodeB过滤后的数量
    original: number;    // 原始任务数量
    valid: number;       // 有效任务数量(parsed=1)
    queued: number;      // 已入队的任务数量
}

export class TaskManager {
    private static instance: TaskManager;
    private pm: PartitionManager = PartitionManager.getInstance();
    private enbTaskList = enbTaskListMap;
    private cellDataENB = cellDataENBMap;
    private inited: boolean = false;

    private constructor() {}
    public static getInstance(): TaskManager {
        if (!TaskManager.instance) {
            TaskManager.instance = new TaskManager();
            TaskManager.instance.init().catch(error => logger.error('任务管理器初始化失败:', error));
            
        } 
        return TaskManager.instance;
    }

    
    public async init(): Promise<void> {
        if (this.inited) return;
        this.inited = true;
        try {
            await this.pm.initPartitionMap();
            await this.pm.cleanExpiredPartitions(); // 清理过期分区
            await this.cleanExpiredScanRecords(); // 清理过期扫描记录
            // 定时清理过期分区
            setInterval(async () => {
                logger.info('定时清理过期数据...');
                this.pm.cleanExpiredPartitions(45).finally(); // 清理过期分区
                redis.cleanExpiredScanRecords(45).finally(); // 清理过期扫描记录
            }, 24 * 60 * 60 * 1000); // 24 hours
            logger.info('任务管理器初始化成功');
            this.inited = true;
        } catch (error) {
            this.inited = false; // 初始化失败, 重置inited为false, 以便下次init时重新尝试初始化
            logger.error('任务管理器初始化失败:'+ error);
        }
    }

    public async addTask(tasks: NDSFileItem[]): Promise<AddTaskResult> {
        const result: AddTaskResult = {
            total: 0,          // 成功插入数据库的总数
            filtered: 0,       // 经过eNodeB过滤后的数量
            original: tasks.length, // 原始任务数量
            valid: 0,          // 有效任务数量(parsed=1)
            queued: 0,         // 已入队的任务数量
        };
        
        try {
            // 获取所有NDSID和file_path并去重, 整合为数组, 然后调用redis.batchScanEnqueue();方法记录到redis中
            const items = tasks.map(task => ({NDSID: task.ndsId, data: task.file_path}));
            const seen = new Set();
            const uniqueItems = [];
            for (const item of items) {
                const key = `${item.NDSID}-${item.data}`;
                if (seen.has(key)) continue;
                seen.add(key);
                uniqueItems.push(item);
            }
            seen.clear(); // 清空seen
            const scanResults = await redis.batchScanEnqueue(uniqueItems);
            // 计算成功添加的记录数（值为1表示新添加，0表示已存在）
            result.queued += scanResults ? scanResults.filter(res => res === 1).length : 0;
            
            const enb_list = await this.cellDataENB.getENBMap();
            const filteredTasks = tasks.filter(task => enb_list.includes(parseInt(task.enodebid))); // 判断tasks中的enodebid是否在enb_list中
            result.filtered = filteredTasks.length;
            
            if (filteredTasks.length === 0) return result;

            const enb_task = await enbTaskListMap.getTaskMap();

            // 判断任务是否在enb_task中, enodebid是否在enb_list中, 并且file_time是否在start_time和end_time之间
            const itemsWithHash = filteredTasks.map(item => {
                const isValidForTask = enb_task.some(task => 
                    task.enodebid === item.enodebid && 
                    task.data_type === item.data_type &&
                    task.start_time.getTime() <= item.file_time.getTime() && 
                    task.end_time.getTime() >= item.file_time.getTime()
                );
                
                if (isValidForTask) result.valid++;
                return { ...item, file_hash: generateFileHash(item.ndsId, item.file_path, item.sub_file_name), parsed: isValidForTask ? 1 : 0 };
            });

            // 提取所有file_time,转为Date(只保留年月日)并去重, 然后调用PartitionManager.addPartition()方法添加分区
            const file_times = itemsWithHash.map(item => {
                const d = new Date(item.file_time);
                return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
            });
            const uniqueFileTimes = [...new Set(file_times)];
            const p_times = await this.pm.getPartitionMap();
            // 遍历uniqueFileTimes, 如果不在p_times中, 则调用PartitionManager.addPartition()方法添加分区
            for (const file_time of uniqueFileTimes) {
                if (!p_times.has(this.pm.convertTimeToPartition(file_time).name)) {
                    await this.pm.addPartition(file_time);
                }
            }
            
            // 过滤掉非数据库模型字段，只保留与ndsFileList模型匹配的字段
            const dbModelItems = itemsWithHash.map(item => ({
                file_hash: item.file_hash,
                ndsId: item.ndsId,
                file_path: item.file_path,
                file_time: item.file_time,
                data_type: item.data_type,
                sub_file_name: item.sub_file_name,
                header_offset: item.header_offset,
                compress_size: item.compress_size,
                file_size: item.file_size,
                flag_bits: item.flag_bits,
                enodebid: item.enodebid,
                parsed: item.parsed
            }));
            
            // 批量插入数据, 分批插入, 每次插入1000条, 如果有重复的, 则跳过
            const batchSize = 1000;
            for (let i = 0; i < dbModelItems.length; i += batchSize) {
                const batch = dbModelItems.slice(i, i + batchSize);
                try {
                    const insertResult = await mysql.$transaction(async (tx) => {
                        return await tx.ndsFileList.createMany({ data: batch, skipDuplicates: true });
                    }, {maxWait: 600000, timeout: 1200000});
                    
                    result.total += insertResult.count;
                    
                    // 批量插入redis
                    const queueItems = batch.map(item => ({
                        NDSID: item.ndsId,
                        data: {
                            ndsId: item.ndsId,
                            file_path: item.file_path,
                            file_time: item.file_time.toISOString(),
                            data_type: item.data_type,
                            sub_file_name: item.sub_file_name,
                            header_offset: item.header_offset,
                            compress_size: item.compress_size,
                            file_size: item.file_size,
                            flag_bits: item.flag_bits,
                            enodebid: item.enodebid,
                            file_hash: item.file_hash
                        }
                    }));
                    
                    const queueResult = await redis.batchTaskEnqueue(queueItems);
                    result.queued += queueResult?.success || 0;
                    
                    logger.info(`数据库插入${insertResult.count}条数据，队列添加${queueResult?.success || 0}条(batch: ${batch?.length || 0})`);
                } catch (error) {
                    logger.error('TaskManager addTask error on insert database:'+ error); 
                }
            }
            
            logger.info(`任务处理完成: 总数=${dbModelItems.length}, 过滤后=${result.filtered}, 入队=${result.queued}`);
        } catch (error) {
            logger.error('TaskManager addTask error:'+ error);
        }
        
        return result;
    }

    public async updateTask(hash: string, file_time: Date | string, parsed: number): Promise<Boolean> {
        try {
            if (file_time) {
                const d = typeof file_time === 'string' ? new Date(file_time) : file_time;
                file_time = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
                const partition = this.pm.convertTimeToPartition(file_time)
                if (partition.name === '' || !this.pm.partitions.has(partition.name)) {
                    await mysql.ndsFileList.update({ where: { file_hash_file_time: { file_hash: hash, file_time: file_time }}, data: { parsed: parsed }});
                }else {
                    await mysql.$executeRaw`UPDATE nds_file_list PARTITION (${partition.name}) SET parsed = ${parsed} WHERE file_hash = '${hash}';`;
                }
            }else {
                await mysql.ndsFileList.updateMany({ where: { file_hash: hash }, data: { parsed: parsed } });
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }


    /**
     * 处理未处理的任务
     * 1. 刷新enbTaskList数据
     * 2. 根据enbTaskList数据获取指定的分区名称并去重
     * 3. 循环处理每个分区中的未处理任务，将它们的parsed字段更新为1并添加到Redis队列中
     * @returns 处理结果
     */
    public async processUnhandledTasks(): Promise<{processed: number}> {
        let totalProcessed = 0;
        
        try {
            // 1. 刷新enbTaskList数据
            await this.enbTaskList.refresh();
            
            // 获取enbTaskList数据中的开始时间和结束时间并去重,格式[{start_time: Date, end_time: Date}, ...]
            const enbTaskListData = await this.enbTaskList.getTaskMap();
            const time_map = new Set()
            const time_ranges = []
            for (const task of enbTaskListData.values()) {
                const set_key = `${task.start_time.getTime()}~${task.end_time.getTime()}`
                if (time_map.has(set_key)) continue;
                time_map.add(set_key)
                const start_time = new Date(task.start_time);
                const end_time = new Date(task.end_time);
                time_ranges.push({start_time, end_time})
            }
            
            // 2. 获取分区名称并去重, 提取date在start_time和end_time之间的分区
            const partition_map = await this.pm.getPartitionMap();
            const partitionNames = new Set();
        
            for (const [partitionName, partitionTime] of partition_map.entries()) {
                if (time_ranges.some(range => partitionTime.getTime() >= range.start_time.getTime() && partitionTime.getTime() <= range.end_time.getTime())) {
                    partitionNames.add(partitionName); 
                }
            }
            
            
            // 3. 循环处理每个分区中的未处理任务
            for (const partitionName of partitionNames.values()) {
                let hasMoreRecords = true;
                const batchSize = 1000; // 每批处理1000条记录
                
                while (hasMoreRecords) {
                    // 使用联合查询获取符合条件的文件记录
                    const validFiles = await mysql.$queryRaw<NDSFileWithTask[]>`
                        SELECT DISTINCT nfl.*
                        FROM nds_file_list PARTITION(${partitionName}) nfl
                        INNER JOIN enb_task_list etl
                        ON nfl.enodebid = etl.enodebid
                        AND nfl.data_type = etl.data_type
                        AND nfl.file_time >= etl.start_time
                        AND nfl.file_time <= etl.end_time
                        WHERE nfl.parsed = 0
                        AND etl.parsed = 0
                        AND etl.status = 0
                        LIMIT ${batchSize}
                    `;
                    
                    // 如果没有记录，退出循环
                    if (validFiles.length === 0) {
                        hasMoreRecords = false;
                        break;
                    }
                    
                    try {
                        await mysql.$transaction(async (tx) => { // 使用事务确保数据一致性
                            const fileHashes = validFiles.map(file => file.file_hash); // 获取所有文件哈希值
                            await tx.ndsFileList.updateMany({where: {file_hash: {in: fileHashes}}, data: {parsed: 1}}); // 更新文件状态为已处理
                        }, {maxWait: 600000, timeout: 1200000});
                        
                        await redis.batchTaskEnqueue(validFiles.map(file => ({ // 添加到Redis队列, 放到事务外, 避免事务超时
                            NDSID: file.ndsId,
                            data: {
                                ndsId: file.ndsId,
                                file_path: file.file_path,
                                file_time: file.file_time.toISOString(),
                                data_type: file.data_type,
                                sub_file_name: file.sub_file_name,
                                header_offset: file.header_offset,
                                compress_size: file.compress_size,
                                file_size: file.file_size,
                                flag_bits: file.flag_bits,
                                enodebid: file.enodebid,
                                file_hash: file.file_hash
                            }
                        })));
                    } catch (error) {
                        logger.error(`处理分区 ${partitionName} 的未处理任务事务出错:`, error);
                        continue;
                    }
                    totalProcessed += validFiles.length;
                    if (validFiles.length < batchSize)  hasMoreRecords = false; // 如果获取的记录数小于批处理大小，说明没有更多记录了
                    logger.info(`分区 ${partitionName} 已处理 ${totalProcessed} 条未处理任务`);
                }
            }
            
            logger.info(`所有分区处理完成，共处理 ${totalProcessed} 条未处理任务`);
            return { processed: totalProcessed };
            
        } catch (error) {
            logger.error('处理未处理任务出错:', error);
            throw error;
        }
    }

        // 清理过期的扫描记录
    public async cleanExpiredScanRecords(): Promise<void> {
        try {
            const result = await redis.cleanExpiredScanRecords(45);
            logger.info(`清理过期扫描记录成功: ${result.cleaned} 条记录已删除`);
        } catch (error: any) {
            logger.error('清理过期扫描记录出错:', error);

        }
    }

}

export const taskManager = TaskManager.getInstance();