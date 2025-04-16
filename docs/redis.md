# Redis 管理器文档

## 1. 概述

Redis 管理器是一个基于 ioredis 的单例模式封装，用于管理 Redis 连接、内存监控、任务队列和扫描记录等功能。该管理器实现了事件驱动模式，可以监听连接状态变化，并提供了一系列批量操作方法，以提高性能和可靠性。

## 2. 类图

```
RedisManager (extends EventEmitter)
├── 属性
│   ├── instance: RedisManager (静态单例)
│   ├── redis: Redis (ioredis 实例)
│   ├── TASK_QUEUE_PREFIX: string
│   ├── SCAN_LIST_PREFIX: string
│   ├── isConnected: boolean
│   ├── reconnectAttempts: number
│   ├── maxReconnectAttempts: number
│   └── scanListMaxTimes: Map<string, Date>
│
├── 公共方法
│   ├── getMemoryInfo(): Promise<MemoryInfo>  // 获取 Redis 内存使用情况
│   ├── batchScanEnqueue(items: QueueItem[]): Promise<void>  // 批量添加扫描记录
│   ├── batchTaskEnqueue(items: QueueItem[]): Promise<BatchResult>  // 批量添加任务队列
│   ├── filterNonExistingPaths(ndsId, filePaths): Promise<string[]>  // 筛选不存在的文件路径
│   ├── batchScanDequeue(items: QueueItem[]): Promise<void>  // 批量删除扫描记录
│   └── cleanExpiredScanRecords(max_age_days): Promise<{cleaned, total}>  // 清理过期扫描记录
│
└── 私有方法
    ├── initialize(): void
    ├── initRedis(): void
    ├── _bindEvents(): void
    ├── initScanListMaxTimes(): Promise<void>
    ├── ensureConnection(): Promise<void>
    ├── getTaskQueueKey(ndsId): string
    ├── getScanListKey(ndsId): string
    └── updateScanListMaxTime(ndsId, filePath): void
```

## 3. 接口定义

### 3.1 QueueItem 接口

用于批量操作队列的数据项接口。

```typescript
interface QueueItem {
    NDSID: string | number;  // NDS ID
    data: any;               // 数据内容
}
```

### 3.2 BatchResult 接口

批量操作的结果接口。

```typescript
interface BatchResult {
    success: number;  // 成功数量
    failed: number;   // 失败数量
}
```

### 3.3 MemoryInfo 接口

Redis 内存使用情况接口。

```typescript
interface MemoryInfo {
    used: number;      // 当前已使用的内存（字节）
    peak: number;      // Redis启动以来内存使用的历史峰值（字节）
    maxMemory: number; // 最大可用内存（字节）
    ratio: number;     // 当前内存使用率（百分比）
}
```

## 4. 初始化与连接管理

### 4.1 初始化流程

RedisManager 采用单例模式，确保整个应用中只有一个 Redis 连接实例。

```typescript
// 获取 Redis 管理器实例
import redisManager from '../database/redis';
```

### 4.2 连接配置

连接配置从配置文件中读取，支持以下参数：

- `redis.host`: Redis 服务器地址，默认为 '127.0.0.1'
- `redis.port`: Redis 服务器端口，默认为 6379
- `redis.password`: Redis 密码，默认为空
- `redis.database`: Redis 数据库索引，默认为 0
- `redis.maxMemoryGB`: Redis 最大内存限制（GB），默认为 8GB
- `redis.maxMemoryPolicy`: Redis 内存淘汰策略，默认为 'noeviction'

### 4.3 重连机制

当 Redis 连接断开时，管理器会自动尝试重连，重连策略如下：

- 最大重连次数：20 次
- 重连延迟：重连次数 * 100ms，最大不超过 5000ms
- 超过最大重连次数后，会触发 'maxReconnectAttemptsReached' 事件

### 4.4 事件监听

RedisManager 继承自 EventEmitter，支持以下事件：

- `connect`: Redis 连接成功
- `error`: Redis 连接错误
- `close`: Redis 连接关闭
- `reconnecting`: Redis 正在重连
- `maxReconnectAttemptsReached`: 达到最大重连次数

```typescript
// 监听连接事件示例
redisManager.on('connect', () => {
    console.log('Redis 连接成功');
});

redisManager.on('error', (error) => {
    console.error('Redis 错误:', error);
});
```

## 5. 内存管理

### 5.1 内存配置

在 Redis 连接成功后，管理器会自动设置最大内存限制和淘汰策略：

```typescript
// 设置最大内存和淘汰策略
await this.redis.config('SET', 'maxmemory', maxMemoryBytes.toString());
await this.redis.config('SET', 'maxmemory-policy', maxMemoryPolicy);
```

### 5.2 内存监控

提供 `getMemoryInfo()` 方法获取 Redis 当前内存使用情况：

```typescript
// 获取内存使用情况
const memoryInfo = await redisManager.getMemoryInfo();
console.log(`内存使用率: ${memoryInfo.ratio}%`);
console.log(`已用内存: ${memoryInfo.used / 1024 / 1024 / 1024} GB`);
console.log(`最大内存: ${memoryInfo.maxMemory / 1024 / 1024 / 1024} GB`);
```

## 6. 任务队列管理

### 6.1 任务队列结构

任务队列使用 Redis 的 List 数据结构，键名格式为 `task_for_nds:{ndsId}`。

### 6.2 批量入队操作

使用 `batchTaskEnqueue()` 方法批量将任务数据插入队列：

```typescript
// 批量插入任务队列
const items = [
    { NDSID: 1, data: { file_path: '/path/to/file1.txt', content: 'content1' } },
    { NDSID: 2, data: { file_path: '/path/to/file2.txt', content: 'content2' } }
];

const result = await redisManager.batchTaskEnqueue(items);
console.log(`成功: ${result.success}, 失败: ${result.failed}`);
```

## 7. 扫描记录管理

### 7.1 扫描记录结构

扫描记录使用 Redis 的 Set 数据结构，键名格式为 `scan_for_nds:{ndsId}`。

### 7.2 批量添加扫描记录

使用 `batchScanEnqueue()` 方法批量添加扫描记录：

```typescript
// 批量添加扫描记录
const items = [
    { NDSID: 1, data: { file_path: '/path/to/file1_20230101120000.txt' } },
    { NDSID: 1, data: { file_path: '/path/to/file2_20230102120000.txt' } }
];

await redisManager.batchScanEnqueue(items);
```

### 7.3 批量删除扫描记录

使用 `batchScanDequeue()` 方法批量删除扫描记录：

```typescript
// 批量删除扫描记录
const items = [
    { NDSID: 1, data: { file_path: '/path/to/file1_20230101120000.txt' } }
];

await redisManager.batchScanDequeue(items);
```

### 7.4 筛选不存在的文件路径

使用 `filterNonExistingPaths()` 方法筛选出不在扫描记录中的文件路径：

```typescript
// 筛选不存在的文件路径
const ndsId = 1;
const filePaths = [
    '/path/to/file1_20230101120000.txt',
    '/path/to/file2_20230102120000.txt',
    '/path/to/file3_20230103120000.txt'
];

const nonExistingPaths = await redisManager.filterNonExistingPaths(ndsId, filePaths);
console.log('不存在的文件路径:', nonExistingPaths);
```

### 7.5 清理过期扫描记录

使用 `cleanExpiredScanRecords()` 方法清理过期的扫描记录：

```typescript
// 清理超过45天的过期记录
const result = await redisManager.cleanExpiredScanRecords(45);
console.log(`共检查 ${result.total} 条记录，清理 ${result.cleaned} 条过期记录`);
```

## 8. 时间提取功能

### 8.1 从文件路径提取时间

系统使用 `extractTimeFromPath()` 函数从文件路径中提取时间信息，用于判断文件的时间顺序和过期情况：

```typescript
// 从文件路径中提取时间
import { extractTimeFromPath } from '../utils/Utils';

const filePath = '/path/to/file_20230101120000.txt';
const fileTime = extractTimeFromPath(filePath);
if (fileTime) {
    console.log('文件时间:', fileTime);
}
```

该函数使用正则表达式 `/\d{14}/` 匹配文件路径中的14位数字（格式为：年月日时分秒），并将其转换为 Date 对象。

## 9. 性能优化

### 9.1 Pipeline 批量操作

所有批量操作方法都使用 Redis 的 Pipeline 功能，减少网络往返次数，提高性能：

```typescript
const pipeline = this.redis.pipeline();
// 批量添加操作
dataList.forEach(data => {
    pipeline.rpush(taskQueueKey, JSON.stringify(data));
    pipeline.sadd(scanQueueKey, data.file_path);
});
// 执行批量操作
const results = await pipeline.exec();
```

### 9.2 分批处理大数据集

在处理大量数据时，使用 SCAN 命令分批获取数据，避免一次性加载过多数据导致内存压力：

```typescript
let cursor = '0';
do {
    // 每次扫描获取一部分数据
    const [nextCursor, paths] = await this.redis.sscan(key, cursor, 'COUNT', 1000);
    cursor = nextCursor;
    // 处理当前批次的数据
    // ...
} while (cursor !== '0'); // 当cursor为0时表示扫描完成
```

## 10. 错误处理

所有公共方法都包含完善的错误处理机制，捕获异常并记录日志：

```typescript
try {
    // 操作代码
} catch (error) {
    logger.error('操作失败:', error);
    throw error; // 将错误向上传递
}
```

## 11. 最佳实践

### 11.1 连接检查

在执行任何 Redis 操作前，使用 `ensureConnection()` 方法确保连接可用：

```typescript
await this.ensureConnection();
// 执行 Redis 操作
```

### 11.2 按 NDSID 分组处理

批量操作时，按 NDSID 分组处理数据，减少键切换开销：

```typescript
// 按 NDSID 分组
const ndsGroups: { [key: string]: any[] } = {};
items.forEach(item => {
    const ndsId = item.NDSID.toString();
    if (!ndsGroups[ndsId]) ndsGroups[ndsId] = [];
    ndsGroups[ndsId].push(item.data);
});

// 分组处理
for (const [ndsId, dataList] of Object.entries(ndsGroups)) {
    // 处理每组数据
}
```

### 11.3 兼容性处理

对于需要高版本 Redis 支持的命令，提供兼容性回退方案：

```typescript
try {
    // 尝试使用高版本特性 (Redis 6.2.0+)
    const existsArray = await this.redis.smismember(scanQueueKey, filePaths);
    // 处理结果
} catch (err) {
    // 回退到兼容性方案
    const pipeline = this.redis.pipeline();
    filePaths.forEach(path => pipeline.sismember(scanQueueKey, path));
    // 处理结果
}
```

## 12. 注意事项

1. Redis 管理器是单例模式，整个应用中共享一个实例
2. 所有公共方法都是异步的，需要使用 await 或 Promise 链式调用
3. 批量操作时，建议控制每批数据量，避免单次操作数据过多
4. 定期调用 `cleanExpiredScanRecords()` 清理过期记录，避免 Redis 内存持续增长
5. 监听 Redis 连接事件，及时处理连接异常情况