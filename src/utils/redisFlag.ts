/**
 * Redis内存状态标记管理器
 */

class RedisFlag {
    private static instance: RedisFlag;
    private readonly lock = new Int32Array(new SharedArrayBuffer(4));

    private constructor() {}

    public static getInstance(): RedisFlag {
        if (!RedisFlag.instance) {
            RedisFlag.instance = new RedisFlag();
        }
        return RedisFlag.instance;
    }

    /**
     * 设置Redis内存过载标记
     * @param value 标记值
     */
    public setFlag(value: boolean): void {
        // 使用原子操作设置标记
        Atomics.store(this.lock, 0, value ? 1 : 0);
    }

    /**
     * 获取Redis内存过载标记
     */
    public getFlag(): boolean {
        // 使用原子操作读取标记
        return Atomics.load(this.lock, 0) === 1;
    }
}

export default RedisFlag.getInstance();
