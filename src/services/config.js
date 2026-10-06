import sqliteService from './sqlite.js';
import { getHeadlessBootstrap, isHeadlessUiConfig } from './headlessBootstrap';

/**
 *
 * @param key
 */
function transformKey(key) {
    return `config:${String(key).toLowerCase()}`;
}

class ConfigRepository {
    async init() {
        if (window.__VRCX_HEADLESS__) { await getHeadlessBootstrap(); return; }
        await sqliteService.executeNonQuery(
            'CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT)'
        );
    }

    async remove(key) {
        const _key = transformKey(key);
        if (window.__VRCX_HEADLESS__ && isHeadlessUiConfig(key)) {
            const boot = await getHeadlessBootstrap();
            const response = await fetch('/headless/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, remove: true }) });
            if (!response.ok) throw new Error('Failed to remove configuration');
            delete boot.config[_key];
            return;
        }
        await sqliteService.executeNonQuery(
            `DELETE FROM configs WHERE key = @key`,
            {
                '@key': _key
            }
        );
    }

    /**
     * @param {string} key
     * @param {string} defaultValue
     * @returns {Promise<string | null>}
     */
    async getString(key, defaultValue = null) {
        const _key = transformKey(key);
        let value = undefined;
        if (window.__VRCX_HEADLESS__ && isHeadlessUiConfig(key)) {
            value = (await getHeadlessBootstrap()).config[_key];
        } else await sqliteService.execute(
            (row) => {
                value = row[0];
            },
            `SELECT value FROM configs WHERE key = @key`,
            {
                '@key': _key
            }
        );

        if (value === null || value === undefined || value === 'undefined') {
            return defaultValue;
        }
        return value;
    }

    /**
     * @param {string} key
     * @param {string} value
     * @returns {Promise<void>}
     */
    async setString(key, value) {
        const _key = transformKey(key);
        const _value = String(value);
        if (window.__VRCX_HEADLESS__ && isHeadlessUiConfig(key)) {
            const boot = await getHeadlessBootstrap();
            if (boot.config[_key] === _value) return;
            const response = await fetch('/headless/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: _value }) });
            if (!response.ok) throw new Error('Failed to save configuration');
            boot.config[_key] = _value;
            return;
        }
        await sqliteService.executeNonQuery(
            `INSERT OR REPLACE INTO configs (key, value) VALUES (@key, @value)`,
            {
                '@key': _key,
                '@value': _value
            }
        );
    }

    /**
     * @param {string} key
     * @param {boolean} defaultValue
     * @returns {Promise<boolean | null>}
     */
    async getBool(key, defaultValue = null) {
        const value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        return value === 'true';
    }

    /**
     * @param {string} key
     * @param {boolean} value
     * @returns {Promise<void>}
     */
    async setBool(key, value) {
        await this.setString(key, value ? 'true' : 'false');
    }

    /**
     * @param {string} key
     * @param {number} defaultValue
     * @returns {Promise<number | null>}
     */
    async getInt(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        value = parseInt(value, 10);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    async setInt(key, value) {
        await this.setString(key, value);
    }

    async getFloat(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        value = parseFloat(value);
        if (isNaN(value) === true) {
            return defaultValue;
        }
        return value;
    }

    async setFloat(key, value) {
        await this.setString(key, value);
    }

    async getObject(key, defaultValue = null) {
        let value = await this.getString(key, null);
        if (value === null || value === undefined) {
            return defaultValue;
        }
        try {
            value = JSON.parse(value);
        } catch {
            // ignore JSON parse errors
        }
        if (value !== Object(value)) {
            return defaultValue;
        }
        return value;
    }

    async setObject(key, value) {
        await this.setString(key, JSON.stringify(value));
    }

    /**
     * @param {string} key
     * @param {Array} defaultValue
     * @returns {Promise<Array | null>}
     */
    async getArray(key, defaultValue = null) {
        const value = await this.getObject(key, null);
        if (Array.isArray(value) === false) {
            return defaultValue;
        }
        return value;
    }

    async setArray(key, value) {
        await this.setObject(key, value);
    }
}

var self = new ConfigRepository();
window.configRepository = self;

export { self as default, ConfigRepository, transformKey };
