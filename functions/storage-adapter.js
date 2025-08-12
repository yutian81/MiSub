/**
 * 数据存储抽象层
 * 支持 KV 和 D1 两种存储方式
 * 根据设置自动选择存储类型
 */

// 存储类型常量
export const STORAGE_TYPES = {
    KV: 'kv',
    D1: 'd1'
};

// 数据键映射
const DATA_KEYS = {
    SUBSCRIPTIONS: 'misub_subscriptions_v1',
    PROFILES: 'misub_profiles_v1', 
    SETTINGS: 'worker_settings_v1'
};

/**
 * KV 存储适配器
 */
class KVStorageAdapter {
    constructor(kvNamespace) {
        this.kv = kvNamespace;
    }

    async get(key, type = 'json') {
        try {
            return await this.kv.get(key, type);
        } catch (error) {
            console.error(`[KV] Failed to get key ${key}:`, error);
            return null;
        }
    }

    async put(key, value) {
        try {
            const data = typeof value === 'string' ? value : JSON.stringify(value);
            await this.kv.put(key, data);
            return true;
        } catch (error) {
            console.error(`[KV] Failed to put key ${key}:`, error);
            throw error;
        }
    }

    async delete(key) {
        try {
            await this.kv.delete(key);
            return true;
        } catch (error) {
            console.error(`[KV] Failed to delete key ${key}:`, error);
            throw error;
        }
    }

    async list(prefix) {
        try {
            const result = await this.kv.list({ prefix });
            return result.keys || [];
        } catch (error) {
            console.error(`[KV] Failed to list keys with prefix ${prefix}:`, error);
            return [];
        }
    }
}

/**
 * D1 存储适配器
 */
class D1StorageAdapter {
    constructor(d1Database) {
        this.db = d1Database;
    }

    async get(key, type = 'json') {
        try {
            // 根据 key 确定查询的表和字段
            const { table, queryField, queryValue } = this._parseKey(key);

            const result = await this.db.prepare(
                `SELECT ${table === 'settings' ? 'value as data' : 'data'} FROM ${table} WHERE ${queryField} = ?`
            ).bind(queryValue).first();

            if (!result) return null;

            return type === 'json' ? JSON.parse(result.data) : result.data;
        } catch (error) {
            console.error(`[D1] Failed to get key ${key}:`, error);
            return null;
        }
    }

    async put(key, value) {
        try {
            const { table, queryField, queryValue } = this._parseKey(key);
            const data = typeof value === 'string' ? value : JSON.stringify(value);

            if (table === 'settings') {
                // settings 表使用 key-value 结构
                await this.db.prepare(`
                    INSERT OR REPLACE INTO ${table} (key, value, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `).bind(queryValue, data).run();
            } else {
                // subscriptions 和 profiles 表使用 id-data 结构
                await this.db.prepare(`
                    INSERT OR REPLACE INTO ${table} (id, data, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `).bind(queryValue, data).run();
            }

            return true;
        } catch (error) {
            console.error(`[D1] Failed to put key ${key}:`, error);
            throw error;
        }
    }

    async delete(key) {
        try {
            const { table, queryField, queryValue } = this._parseKey(key);

            await this.db.prepare(
                `DELETE FROM ${table} WHERE ${queryField} = ?`
            ).bind(queryValue).run();

            return true;
        } catch (error) {
            console.error(`[D1] Failed to delete key ${key}:`, error);
            throw error;
        }
    }

    async list(prefix) {
        try {
            // D1 中的 list 操作需要根据前缀查询相应的表
            const tables = [
                { name: 'subscriptions', keyField: 'id' },
                { name: 'profiles', keyField: 'id' },
                { name: 'settings', keyField: 'key' }
            ];
            const keys = [];

            for (const table of tables) {
                const results = await this.db.prepare(
                    `SELECT ${table.keyField} FROM ${table.name}`
                ).all();

                results.results.forEach(row => {
                    const key = this._buildKey(table.name, row[table.keyField]);
                    if (key.startsWith(prefix)) {
                        keys.push({ name: key });
                    }
                });
            }

            return keys;
        } catch (error) {
            console.error(`[D1] Failed to list keys with prefix ${prefix}:`, error);
            return [];
        }
    }

    /**
     * 解析 key，确定对应的表、查询字段和查询值
     */
    _parseKey(key) {
        if (key === DATA_KEYS.SUBSCRIPTIONS) {
            return { table: 'subscriptions', queryField: 'id', queryValue: 'main' };
        } else if (key === DATA_KEYS.PROFILES) {
            return { table: 'profiles', queryField: 'id', queryValue: 'main' };
        } else if (key === DATA_KEYS.SETTINGS) {
            return { table: 'settings', queryField: 'key', queryValue: 'main' };
        } else {
            // 处理其他格式的 key，默认作为 settings 表的 key
            return { table: 'settings', queryField: 'key', queryValue: key };
        }
    }

    /**
     * 构建 key
     */
    _buildKey(table, keyValue) {
        if (table === 'subscriptions' && keyValue === 'main') {
            return DATA_KEYS.SUBSCRIPTIONS;
        } else if (table === 'profiles' && keyValue === 'main') {
            return DATA_KEYS.PROFILES;
        } else if (table === 'settings' && keyValue === 'main') {
            return DATA_KEYS.SETTINGS;
        } else {
            return keyValue;
        }
    }
}

/**
 * 存储工厂类
 * 根据配置创建相应的存储适配器
 */
export class StorageFactory {
    /**
     * 创建存储适配器
     * @param {Object} env - Cloudflare 环境对象
     * @param {string} storageType - 存储类型 ('kv' | 'd1')
     * @returns {KVStorageAdapter|D1StorageAdapter}
     */
    static createAdapter(env, storageType = STORAGE_TYPES.KV) {
        switch (storageType) {
            case STORAGE_TYPES.D1:
                if (!env.MISUB_DB) {
                    console.warn('[Storage] D1 database not available, falling back to KV');
                    return new KVStorageAdapter(env.MISUB_KV);
                }
                return new D1StorageAdapter(env.MISUB_DB);
            
            case STORAGE_TYPES.KV:
            default:
                return new KVStorageAdapter(env.MISUB_KV);
        }
    }

    /**
     * 获取当前存储类型设置
     * @param {Object} env - Cloudflare 环境对象
     * @returns {Promise<string>} 存储类型
     */
    static async getStorageType(env) {
        try {
            // 先尝试从 KV 读取设置
            let settings = null;
            try {
                settings = await env.MISUB_KV.get(DATA_KEYS.SETTINGS, 'json');
            } catch (kvError) {
                console.warn('[Storage] Failed to read from KV:', kvError.message);
            }

            // 如果 KV 中有设置且指定了存储类型，使用它
            if (settings?.storageType) {
                return settings.storageType;
            }

            // 如果 KV 中没有设置或没有存储类型，尝试从 D1 读取
            if (env.MISUB_DB) {
                try {
                    const d1Adapter = new D1StorageAdapter(env.MISUB_DB);
                    const d1Settings = await d1Adapter.get(DATA_KEYS.SETTINGS);
                    if (d1Settings?.storageType) {
                        return d1Settings.storageType;
                    }
                } catch (d1Error) {
                    console.warn('[Storage] Failed to read from D1:', d1Error.message);
                }
            }

            // 默认使用 KV
            return STORAGE_TYPES.KV;
        } catch (error) {
            console.error('[Storage] Failed to get storage type:', error);
            return STORAGE_TYPES.KV;
        }
    }
}

/**
 * 数据迁移工具
 */
export class DataMigrator {
    /**
     * 从 KV 迁移到 D1
     * @param {Object} env - Cloudflare 环境对象
     * @returns {Promise<Object>} 迁移结果
     */
    static async migrateKVToD1(env) {
        try {
            const kvAdapter = new KVStorageAdapter(env.MISUB_KV);
            const d1Adapter = new D1StorageAdapter(env.MISUB_DB);

            const results = {
                subscriptions: false,
                profiles: false,
                settings: false,
                errors: []
            };

            // 迁移订阅数据
            try {
                const subscriptions = await kvAdapter.get(DATA_KEYS.SUBSCRIPTIONS);
                if (subscriptions) {
                    await d1Adapter.put(DATA_KEYS.SUBSCRIPTIONS, subscriptions);
                    results.subscriptions = true;
                }
            } catch (error) {
                results.errors.push(`订阅数据迁移失败: ${error.message}`);
            }

            // 迁移配置文件
            try {
                const profiles = await kvAdapter.get(DATA_KEYS.PROFILES);
                if (profiles) {
                    await d1Adapter.put(DATA_KEYS.PROFILES, profiles);
                    results.profiles = true;
                }
            } catch (error) {
                results.errors.push(`配置文件迁移失败: ${error.message}`);
            }

            // 迁移设置
            try {
                const settings = await kvAdapter.get(DATA_KEYS.SETTINGS);
                if (settings) {
                    // 更新存储类型为 D1
                    settings.storageType = STORAGE_TYPES.D1;
                    await d1Adapter.put(DATA_KEYS.SETTINGS, settings);
                    results.settings = true;
                }
            } catch (error) {
                results.errors.push(`设置迁移失败: ${error.message}`);
            }

            return results;
        } catch (error) {
            console.error('[Migration] Failed to migrate KV to D1:', error);
            throw error;
        }
    }
}
