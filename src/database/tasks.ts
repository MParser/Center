import mysql from './mysql';
import logger from '../utils/logger';
import { Mutex } from 'async-mutex';

interface PartitionInfo {
    partition_name: string;
    partition_description: string;
    table_rows: number;
}

export class PartitionManager {
    private static instance: PartitionManager;
    public partitionMap: Map<string, Date>;
    private readonly mutex: Mutex;
    private constructor() {
        this.partitionMap = new Map(); 
        this.mutex = new Mutex();
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): PartitionManager {
        if (!PartitionManager.instance) {
            PartitionManager.instance = new PartitionManager();
        }
        return PartitionManager.instance;
    }

    /**
     * 初始化分区
     */
    public async initPartition(): Promise<void> {
        // 从数据库中查询所有分区
        try {
            // 使用锁
            const release = await this.mutex.acquire();
            try {
                this.partitionMap.clear();
                const partitions = await mysql.$queryRaw<PartitionInfo[]>` SELECT partition_name, partition_description, table_rows FROM information_schema.PARTITIONS WHERE table_name = 'nds_file_list';`;
                // 遍历所有分区, 将分区名和分区描述添加到partitionMap中
                partitions.forEach((partition) => { 
                    // 从分区名中提取日期，格式为p_YYYYMMDD
                    const partitionName = partition.partition_name;
                    if (partitionName.startsWith('p_') && partitionName.length === 10) {
                        const dateStr = partitionName.substring(2); // 去掉p_前缀
                        // 转换为YYYY-MM-DD格式的日期
                        const year = dateStr.substring(0, 4);
                        const month = dateStr.substring(4, 6);
                        const day = dateStr.substring(6, 8);
                        const dateFormatted = `${year}-${month}-${day}`;
                        // 创建日期并减1天，以保持与addPartition中日期加1天的逻辑一致
                        const partitionDate = new Date(dateFormatted);
                        partitionDate.setDate(partitionDate.getDate() - 1);
                        this.partitionMap.set(partitionName, partitionDate);
                    }
                });
                
            } catch(e) {
                logger.error('初始化分区出错:', e);
            } finally {
                // 释放锁
                release();
            }
        } catch(e) {
            logger.error('获取分区锁出错:', e);
        }
    }

    /**
     * 获取所有分区, 按时间排序,从早到晚
     * @returns Map<string, Date> 分区名和分区描述
     */
    public getAllPartitions(): Map<string, Date> {
        return new Map([...this.partitionMap.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()));
    }

    /**
     * 添加分区
     * @param file_time 文件时间
     */
    public async addPartition(file_time: Date): Promise<void> {
        try {
            // 获取锁
            const tomorrow = new Date(file_time);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const year = tomorrow.getFullYear();
            const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
            const day = String(tomorrow.getDate()).padStart(2, '0');
            const formattedDate = `${year}-${month}-${day}`;
            // 判断是否存在该分区
            if (this.partitionMap.has(`p_${formattedDate}`)) return;
            
            const release = await this.mutex.acquire();
            // 再次判断是否存在该分区, 避免因为锁导致重复添加
            if (this.partitionMap.has(`p_${formattedDate}`)) {
                release();
                return;
            }

            try {
                // 如果没有分区，创建第一个分区
                if (this.partitionMap.size === 0) {
                    logger.info('未找到分区，正在创建第一个分区...');
                    const partitionName = `p_${formattedDate}`;
                    const createPartitionSql = `ALTER TABLE nds_file_list PARTITION BY RANGE (TO_DAYS(file_time)) (PARTITION ${partitionName} VALUES LESS THAN (TO_DAYS('${formattedDate}')));`;
                    await mysql.$executeRaw`${createPartitionSql}`;
                    this.partitionMap.set(partitionName, file_time); // 添加到映射中
                    logger.info(`成功创建第一个分区: ${partitionName}`);
                }
                
                // 查找所有分区中的最大日期值
                let maxDate = new Date(0); // 初始化为最小日期
                for (const [_, date] of this.partitionMap.entries()) {
                    if (date.getTime() > maxDate.getTime()) maxDate = date;
                }
                
                // 判断传入日期是否大于最大日期
                const isGreaterThanMaxDate = file_time.getTime() > maxDate.getTime();
                
                if (isGreaterThanMaxDate) {
                    // 如果传入日期大于最大日期，从最大日期开始添加分区，一直到传入日期(日期+1)
                    const startDate = new Date(maxDate);
                    const endDate = new Date(file_time);
                    
                    // 创建日期数组，从startDate到endDate，每天一个分区
                    const dates: Date[] = [];
                    let currentDate = new Date(startDate);
                    currentDate.setDate(currentDate.getDate() + 1); // 从最大日期的下一天开始
                    
                    while (currentDate.getTime() <= endDate.getTime()) {
                        dates.push(new Date(currentDate));
                        currentDate.setDate(currentDate.getDate() + 1);
                    }
                    
                    // 为每个日期创建分区
                    for (const date of dates) {
                        const partitionDate = new Date(date);
                        partitionDate.setDate(partitionDate.getDate() + 1); // 将时间加1天，MySQL分区逻辑是小于该时间
                        
                        // 格式化日期为YYYYMMDD
                        const year = partitionDate.getFullYear();
                        const month = String(partitionDate.getMonth() + 1).padStart(2, '0');
                        const day = String(partitionDate.getDate()).padStart(2, '0');
                        const partitionDateStr = `${year}${month}${day}`;
                        const partitionName = `p_${partitionDateStr}`;
                        if (this.partitionMap.has(partitionName)) continue; // 跳过已存在的分区
                        const newPartitionDate = `${year}-${month}-${day}`; // 格式化新分区日期
                        // 添加分区
                        const addPartitionSql = `ALTER TABLE nds_file_list ADD PARTITION (PARTITION ${partitionName} VALUES LESS THAN (TO_DAYS('${newPartitionDate}')));`;
                        await mysql.$executeRaw`${addPartitionSql}`;
                        // 添加到映射中
                        this.partitionMap.set(partitionName, date);
                        logger.info(`成功添加分区: ${partitionName}`);
                    }
                } else {
                    // 如果传入日期不大于最大日期，从传入日期开始添加分区，一直到最大日期
                    const partitionDate = new Date(file_time);
                    partitionDate.setDate(partitionDate.getDate() + 1); // 将时间加1天，MySQL分区逻辑是小于该时间
                    
                    // 格式化日期为YYYYMMDD
                    const year = partitionDate.getFullYear();
                    const month = String(partitionDate.getMonth() + 1).padStart(2, '0');
                    const day = String(partitionDate.getDate()).padStart(2, '0');
                    const partitionDateStr = `${year}${month}${day}`;
                    const partitionName = `p_${partitionDateStr}`;
                    
                    if (this.partitionMap.has(partitionName)) {
                        release();
                        return; // 如果已存在该分区，直接返回
                    }
                    // 重建分区结构
                    // 先将新分区添加到映射中
                    this.partitionMap.set(partitionName, file_time);
                    // 对分区按时间排序
                    const sortedPartitions = [...this.partitionMap.entries()].sort((a, b) => a[1].getTime() - b[1].getTime());
                    
                    // 构建SQL语句
                    let partitionSql = `ALTER TABLE nds_file_list PARTITION BY RANGE (TO_DAYS(file_time)) (`;
                    
                    // 基于排序后的分区构建SQL语句
                    for (let i = 0; i < sortedPartitions.length; i++) {
                        const [name, date] = sortedPartitions[i];
                        const partDate = new Date(date);
                        partDate.setDate(partDate.getDate() + 1); // 获取分区日期，需要加1天，因为存储时减了1天
                        const formattedDate = partDate.toISOString().split('T')[0]; // YYYY-MM-DD格式
                        partitionSql += `\n\tPARTITION ${name} VALUES LESS THAN (TO_DAYS('${formattedDate}'))${i === sortedPartitions.length - 1 ? '' : ','}`; // 最后一个分区不加逗号
                    }
                    
                    partitionSql += `\n);`;
                    
                    // 执行SQL重建分区
                    await mysql.$executeRaw`${partitionSql}`;
                    logger.info(`成功重建分区结构，添加分区: ${partitionName}`);
                }
            } catch(e) {
                logger.error(`添加分区出错:`, e); 
            } finally {
                // 释放锁
                release();
            }
        } catch(e) {
            logger.error(`分区操作出错:`, e);
        }
    }

    /**
     * 删除分区
     * @param partitionDate 分区日期
     */
    public async deletePartition(partitionDate: Date): Promise<void> {
        try {
            // 将日期加1天，以保持与addPartition中日期加1天的逻辑一致
            const deleteDate = new Date(partitionDate);
            deleteDate.setDate(deleteDate.getDate() + 1);
            
            // 格式化日期为YYYYMMDD
            const year = deleteDate.getFullYear();
            const month = String(deleteDate.getMonth() + 1).padStart(2, '0');
            const day = String(deleteDate.getDate()).padStart(2, '0');
            const partitionDateStr = `${year}${month}${day}`;
            const partitionName = `p_${partitionDateStr}`;
            
            // 检查是否存在该分区
            if (!this.partitionMap.has(partitionName)) return;
            
            // 获取锁
            const release = await this.mutex.acquire();
            
            try {
                // 删除分区
                await mysql.$executeRaw`ALTER TABLE nds_file_list DROP PARTITION ${partitionName}`;
                // 从映射中移除
                this.partitionMap.delete(partitionName);
                logger.info(`成功删除分区: ${partitionName}`);
            } catch(e) {
                logger.error(`删除分区出错:`, e); 
            } finally {
                // 释放锁
                release(); 
            }
        } catch(e) {
            logger.error(`分区操作出错:`, e);
        }
    }
    
    /**
     * 清理过期分区（删除比最大日期早45天以上的分区）
     */
    public async cleanExpiredPartitions(): Promise<void> {
        try {
            // 如果分区映射为空，先初始化
            if (this.partitionMap.size === 0) {
                await this.initPartition();
                if (this.partitionMap.size === 0) {
                    logger.info('分区映射为空，无需清理');
                    return;
                }
            }
            
            // 查找所有分区中的最大日期值
            let maxDate = new Date(0); // 初始化为最小日期
            for (const [_, date] of this.partitionMap.entries()) {
                if (date.getTime() > maxDate.getTime()) maxDate = date;
            }
            
            // 计算45天前的日期
            const expirationDate = new Date(maxDate);
            expirationDate.setDate(expirationDate.getDate() - 45);
            
            // 获取锁
            const release = await this.mutex.acquire();
            
            try {
                // 找出所有过期的分区
                const expiredPartitions: [string, Date][] = [];
                for (const [name, date] of this.partitionMap.entries()) {
                    if (date.getTime() < expirationDate.getTime()) {
                        expiredPartitions.push([name, date]);
                    }
                }
                
                // 删除过期分区
                for (const [name, date] of expiredPartitions) {
                    try {
                        await mysql.$executeRaw`ALTER TABLE nds_file_list DROP PARTITION ${name}`;
                        this.partitionMap.delete(name);
                        logger.info(`成功删除过期分区: ${name}，日期: ${date.toISOString().split('T')[0]}`);
                    } catch (e) {
                        logger.error(`删除过期分区出错: ${name}`, e);
                    }
                }
                
                logger.info(`清理完成，共删除 ${expiredPartitions.length} 个过期分区`);
            } catch(e) {
                logger.error(`清理过期分区出错:`, e); 
            } finally {
                // 释放锁
                release(); 
            }
        } catch(e) {
            logger.error(`分区操作出错:`, e);
        }
    }
}


