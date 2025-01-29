import fs from 'fs';
import path from 'path';

type ConfigValue = string | number | boolean | null | ConfigDict;
interface ConfigDict {
    [key: string]: ConfigValue;
}

class Config {
    private readonly _configPath: string;
    private readonly _envPath: string;
    private _jsonConfig: ConfigDict = {};
    private _config: ConfigDict = {};

    constructor() {
        this._configPath = path.join(__dirname, '../../config.json');
        this._envPath = path.join(__dirname, '../../.env');
        this._loadConfig();
    }

    /**
     * 从config.json中获取配置值
     */
    private _getFromJson(key: string): any {
        return this._getValueByPath(this._jsonConfig, key);
    }

    /**
     * 从.env文件中获取配置值
     */
    private _getFromEnv(key: string | null): any {
        if (!fs.existsSync(this._envPath)) {
            return key === null ? {} : undefined;
        }

        // 如果key为null，返回所有配置
        if (key === null) {
            const envConfig: ConfigDict = {};
            const envContent = fs.readFileSync(this._envPath, 'utf8');
            const lines = envContent.split('\n');

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) continue;

                const equalIndex = trimmedLine.indexOf('=');
                if (equalIndex === -1) continue;

                const k = trimmedLine.slice(0, equalIndex).trim();
                const v = trimmedLine.slice(equalIndex + 1).trim();
                const configKey = this._convertEnvKeyToConfigKey(k);
                if (configKey) {
                    this._setValueByPath(envConfig, configKey, this._convertValue(v));
                }
            }

            return envConfig;
        }

        // 获取单个配置值
        const envContent = fs.readFileSync(this._envPath, 'utf8');
        const envKey = this._convertToEnvKey(key);
        const lines = envContent.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;

            const equalIndex = trimmedLine.indexOf('=');
            if (equalIndex === -1) continue;

            const k = trimmedLine.slice(0, equalIndex).trim();
            const v = trimmedLine.slice(equalIndex + 1).trim();

            if (k === envKey) {
                return this._convertValue(v);
            }
        }

        return undefined;
    }

    /**
     * 从环境变量中获取配置值
     */
    private _getFromEnvVars(key: string | null): any {
        // 如果key为null，返回所有配置
        if (key === null) {
            const envConfig: ConfigDict = {};
            for (const [k, v] of Object.entries(process.env)) {
                const configKey = this._convertEnvKeyToConfigKey(k);
                if (configKey && v !== undefined) {
                    this._setValueByPath(envConfig, configKey, this._convertValue(v));
                }
            }
            return envConfig;
        }

        // 获取单个配置值
        const envKey = this._convertToEnvKey(key);
        const value = process.env[envKey];
        return value ? this._convertValue(value) : undefined;
    }

    /**
     * 写入配置到config.json
     */
    private _writeToJson(key: string, value: any): void {
        const config = { ...this._jsonConfig };
        this._setValueByPath(config, key, value);
        fs.writeFileSync(this._configPath, JSON.stringify(config, null, 2));
        this._jsonConfig = config;
    }

    /**
     * 写入配置到.env文件
     */
    private _writeToEnv(key: string, value: any): void {
        const envContent = fs.readFileSync(this._envPath, 'utf8');
        const lines = envContent.split('\n');
        const envKey = this._convertToEnvKey(key);

        let found = false;
        const newLines = lines.map(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) return line;

            const equalIndex = line.indexOf('=');
            if (equalIndex === -1) return line;

            const k = line.slice(0, equalIndex).trim();
            if (k === envKey) {
                found = true;
                return `${envKey}=${value}`;
            }
            return line;
        });

        if (!found) {
            newLines.push(`${envKey}=${value}`);
        }

        fs.writeFileSync(this._envPath, newLines.join('\n'));
    }

    /**
     * 写入配置到环境变量
     */
    private _writeToEnvVars(key: string, value: any): void {
        const envKey = this._convertToEnvKey(key);
        process.env[envKey] = String(value);
    }

    /**
     * 加载JSON配置文件
     */
    private _loadJsonConfig(): void {
        if (fs.existsSync(this._configPath)) {
            try {
                const content = fs.readFileSync(this._configPath, 'utf-8');
                this._jsonConfig = JSON.parse(content);
            } catch (error) {
                this._jsonConfig = {};
            }
        }
    }

    /**
     * 将点号分隔的键转换为环境变量格式
     * 例如：app.port -> APP_PORT
     */
    private _convertToEnvKey(key: string): string {
        return key.toUpperCase().replace(/\./g, '_');
    }

    /**
     * 将环境变量格式的键转换为配置键
     * 例如：APP_HOST -> app.host
     */
    private _convertEnvKeyToConfigKey(key: string): string | null {
        const parts = key.toLowerCase().split('_');
        // 忽略系统环境变量和特殊变量
        if (parts.some(p => p.includes('.')) || parts.length === 1) {
            return null;
        }
        return parts.join('.');
    }

    /**
     * 根据路径获取值
     */
    private _getValueByPath(obj: any, path: string): any {
        const parts = path.split('.');
        let current = obj;

        for (const part of parts) {
            if (current && typeof current === 'object') {
                current = current[part];
            } else {
                return undefined;
            }
        }

        return current;
    }

    /**
     * 根据路径设置值
     */
    private _setValueByPath(obj: any, path: string, value: any): void {
        const parts = path.split('.');
        let current = obj;

        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            // 如果当前节点不是对象，或者是null，创建一个新对象
            if (typeof current[part] !== 'object' || current[part] === null) {
                current[part] = {};
            }
            current = current[part];
        }

        // 设置最后一个节点的值
        const lastPart = parts[parts.length - 1];
        current[lastPart] = value;
    }

    /**
     * 值类型转换
     */
    private _convertValue(value: any): ConfigValue {
        // 如果不是字符串，直接返回
        if (typeof value !== 'string') {
            return value;
        }

        const lowerValue = value.toLowerCase();

        // 处理布尔值
        if (['true', 'yes', 'on', '1'].includes(lowerValue)) {
            return true;
        }
        if (['false', 'no', 'off', '0'].includes(lowerValue)) {
            return false;
        }

        // 处理None值
        if (['none', 'null'].includes(lowerValue)) {
            return null;
        }

        // 处理数字
        try {
            if (/^\d+$/.test(value)) {
                return parseInt(value, 10);
            }
            if (/^\d*\.\d+$/.test(value)) {
                const floatValue = parseFloat(value);
                return isNaN(floatValue) ? value : floatValue;
            }
        } catch {
            // 如果转换失败，返回原始字符串
        }

        return value;
    }

    /**
     * 合并配置
     */
    private _mergeConfigs(base: ConfigDict, override: ConfigDict): ConfigDict {
        const result = { ...base };

        for (const [key, value] of Object.entries(override)) {
            if (value === undefined || value === null) {
                continue;
            }

            if (
                key in result &&
                result[key] !== null &&
                typeof result[key] === 'object' &&
                typeof value === 'object'
            ) {
                result[key] = this._mergeConfigs(
                    result[key] as ConfigDict,
                    value as ConfigDict
                );
            } else {
                result[key] = value;
            }
        }

        return result;
    }

    /**
     * 获取所有配置
     */
    public getAll(): ConfigDict {
        return { ...this._config };
    }

    /**
     * 重新加载配置
     */
    private _loadConfig(): void {
        // 加载所有配置源
        this._loadJsonConfig();

        // 设置配置覆盖标志
        const configOverride = this._jsonConfig?.CONFIG_OVERRIDE ?? false;

        if (configOverride) {
            // CONFIG_OVERRIDE=true时：config.json > .env > 环境变量
            this._config = this._mergeConfigs({}, this._getFromEnv(null));
            this._config = this._mergeConfigs(this._config, this._getFromEnvVars(null));
            this._config = this._mergeConfigs(this._config, this._jsonConfig);
        } else {
            // CONFIG_OVERRIDE=false时：环境变量 > .env > config.json
            this._config = this._mergeConfigs({}, this._jsonConfig);
            this._config = this._mergeConfigs(this._config, this._getFromEnv(null));
            this._config = this._mergeConfigs(this._config, this._getFromEnvVars(null));
        }
    }

    /**
     * 重新加载配置
     */
    public reload(): void {
        this._loadConfig();
    }

    /**
     * 获取配置值
     */
    public get<T>(key: string, defaultValue?: T): T {
        if (!key) {
            return defaultValue as T;
        }

        // 获取CONFIG_OVERRIDE的值，如果config.json不存在或CONFIG_OVERRIDE未配置，则默认为false
        const configOverride = this._jsonConfig?.CONFIG_OVERRIDE ?? false;
        let value: T | undefined;

        if (configOverride) {
            // CONFIG_OVERRIDE=true时：config.json > .env > 环境变量
            value = this._getFromJson(key);
            if (value !== undefined) return value as T;

            value = this._getFromEnv(key);
            if (value !== undefined) return value as T;

            value = this._getFromEnvVars(key);
            if (value !== undefined) return value as T;
        } else {
            // CONFIG_OVERRIDE=false时：环境变量 > .env > config.json
            value = this._getFromEnvVars(key);
            if (value !== undefined) return value as T;

            value = this._getFromEnv(key);
            if (value !== undefined) return value as T;

            value = this._getFromJson(key);
            if (value !== undefined) return value as T;
        }

        return defaultValue as T;
    }

    /**
     * 设置配置值
     */
    public set(key: string, value: any): void {
        // 获取CONFIG_OVERRIDE的值，如果config.json不存在或CONFIG_OVERRIDE未配置，则默认为false
        const configOverride = this._jsonConfig?.CONFIG_OVERRIDE ?? false;

        if (configOverride) {
            // 当CONFIG_OVERRIDE=true时，只写入config.json
            if (fs.existsSync(this._configPath)) {
                this._writeToJson(key, value);
            }
        } else {
            // 当CONFIG_OVERRIDE=false时，按以下顺序写入：
            // 1. 写入环境变量（必须）
            this._writeToEnvVars(key, value);

            // 2. 如果.env文件存在，则写入.env
            if (fs.existsSync(this._envPath)) {
                this._writeToEnv(key, value);
            }

            // 3. 如果config.json文件存在，则写入config.json
            if (fs.existsSync(this._configPath)) {
                this._writeToJson(key, value);
            }
        }

        // 重新加载配置
        this._loadConfig();
    }
}

// 创建全局配置实例
export const config = new Config();
