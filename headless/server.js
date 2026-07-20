#!/usr/bin/env node
/* global require, module, __dirname, Buffer */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocketClient = require('ws');
const { WebSocketServer } = WebSocketClient;

const rootDir = path.resolve(__dirname, '..');
const staticDir = path.join(rootDir, 'build', 'html');
const dataDir = process.env.VRCX_APP_DATA_DIR || '/data';
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8080);
const friendRefreshIntervalMs = Number(
    process.env.VRCX_FRIEND_REFRESH_INTERVAL_MS || 0
);
const configuredAuthValidationIntervalMs = Number(
    process.env.VRCX_AUTH_VALIDATION_INTERVAL_MS || 420000
);
const authValidationIntervalMs =
    Number.isFinite(configuredAuthValidationIntervalMs) &&
    configuredAuthValidationIntervalMs > 0
        ? Math.max(60000, configuredAuthValidationIntervalMs)
        : 420000;

const defaultEndpoint = 'https://api.vrchat.cloud/api/1';
const defaultPipeline = 'wss://pipeline.vrchat.cloud';

let bridge;
let session;

function readVersion() {
    try {
        return fs.readFileSync(path.join(rootDir, 'Version'), 'utf8').trim();
    } catch {
        return 'Headless Build';
    }
}

function ensureDotNetRuntime() {
    const bundledDotNetPath = path.join(
        rootDir,
        'build',
        'Electron',
        'dotnet-runtime'
    );
    if (fs.existsSync(bundledDotNetPath)) {
        process.env.DOTNET_ROOT = bundledDotNetPath;
        process.env.PATH = `${bundledDotNetPath}:${process.env.PATH}`;
    }
}

class DotNetBridge {
    constructor() {
        this.createdObjects = {};
        ensureDotNetRuntime();
        const armBridgePath = path.join(
            rootDir,
            'build',
            'Electron',
            'VRCX-Electron-arm64.cjs'
        );
        const bridgePath =
            process.arch === 'arm64' && fs.existsSync(armBridgePath)
                ? armBridgePath
                : path.join(rootDir, 'build', 'Electron', 'VRCX-Electron.cjs');
        require(bridgePath);
        const InteropApi = require(path.join(rootDir, 'src-electron', 'InteropApi'));
        this.interop = new InteropApi();
    }

    getObject(className) {
        if (!this.createdObjects[className]) {
            this.createdObjects[className] =
                this.interop.getDotNetObject(className);
        }
        return this.createdObjects[className];
    }

    call(className, methodName, args = []) {
        return this.interop.callMethod(className, methodName, args);
    }
}

function jsonResponse(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}

function textResponse(res, statusCode, text, contentType = 'text/plain') {
    res.writeHead(statusCode, {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 25 * 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function safeError(err) {
    return {
        message: err?.message || String(err),
        stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack
    };
}

function buildRequestInit(endpoint, options = {}, endpointDomain = defaultEndpoint) {
    const init = {
        url: `${endpointDomain}/${endpoint}`,
        method: 'GET',
        ...options
    };
    const { params } = init;
    if (init.method === 'GET') {
        if (params === Object(params)) {
            const url = new URL(init.url);
            for (const key of Object.keys(params)) {
                if (params[key] !== undefined && params[key] !== null) {
                    url.searchParams.set(key, params[key]);
                }
            }
            init.url = url.toString();
        }
    } else if (
        init.uploadImage ||
        init.uploadFilePUT ||
        init.uploadImageLegacy ||
        init.uploadImagePrint
    ) {
        // Upload payloads are already encoded by the UI before reaching WebApi.
    } else {
        init.headers = {
            'Content-Type': 'application/json;charset=utf-8',
            ...init.headers
        };
        init.body = params === Object(params) ? JSON.stringify(params) : '{}';
    }
    delete init.params;
    return init;
}

function parseMaybeJson(value) {
    if (typeof value !== 'string' || !value) return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toDotNetMap(value) {
    if (!value || value instanceof Map) return value;
    return new Map(
        Object.entries(value).map(([key, item]) => [
            key,
            item === undefined ? null : item
        ])
    );
}

function normalizeSqlArgs(sql, args) {
    if (!args || typeof args !== 'object') return args || null;
    const normalized =
        args instanceof Map ? Object.fromEntries(args.entries()) : { ...args };
    for (const match of String(sql || '').matchAll(/@[\w]+/g)) {
        if (!Object.prototype.hasOwnProperty.call(normalized, match[0])) {
            normalized[match[0]] = null;
        }
    }
    for (const key of Object.keys(normalized)) {
        if (normalized[key] === undefined) normalized[key] = null;
    }
    return normalized;
}

function splitSetCookieHeader(header) {
    if (!header) return [];
    const cookies = [];
    let start = 0;
    let inExpires = false;
    for (let index = 0; index < header.length; index += 1) {
        const char = header[index];
        if (char === ',') {
            if (!inExpires) {
                cookies.push(header.slice(start, index).trim());
                start = index + 1;
            }
            continue;
        }
        if (char === ';') {
            inExpires = false;
            continue;
        }
        if (
            header
                .slice(Math.max(0, index - 8), index + 1)
                .toLowerCase()
                .endsWith('expires=')
        ) {
            inExpires = true;
        }
    }
    cookies.push(header.slice(start).trim());
    return cookies.filter(Boolean);
}

function userPrefix(userId) {
    let prefix = String(userId || '').replaceAll('-', '').replaceAll('_', '');
    if (/^\d/.test(prefix)) prefix = `_${prefix}`;
    return prefix;
}

function isRealInstance(location) {
    return typeof location === 'string' && /^wrld_[^:]+:.+/.test(location);
}

function parseLocation(location = '') {
    const value = String(location || '');
    const [worldId, rest = ''] = value.split(':');
    const instanceId = rest.split('~')[0] || '';
    const groupMatch = value.match(/group\((grp_[^)]+)\)/);
    return {
        tag: value,
        worldId: worldId.startsWith('wrld_') ? worldId : '',
        instanceId,
        groupId: groupMatch ? groupMatch[1] : ''
    };
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function extractFileId(value) {
    const match = String(value || '').match(/file_[0-9A-Za-z-]+/);
    return match ? match[0] : '';
}

function parseAvatarName(file) {
    const match = /Avatar - (.*) - Image -/i.exec(String(file?.name || ''));
    return match ? match[1] : '';
}

function trustLevelFromTags(tags = []) {
    if (!Array.isArray(tags)) return '';
    if (tags.includes('system_trust_veteran')) return 'Trusted User';
    if (tags.includes('system_trust_trusted')) return 'Known User';
    if (tags.includes('system_trust_known')) return 'User';
    if (tags.includes('system_trust_basic')) return 'New User';
    return 'Visitor';
}

function normalizeTrustLevel(value) {
    switch (String(value || '').toLowerCase()) {
        case 'veteran':
        case 'trusted user':
        case 'veteran user':
            return 'Trusted User';
        case 'trusted':
        case 'known user':
            return 'Known User';
        case 'known':
        case 'user':
            return 'User';
        case 'basic':
        case 'new user':
            return 'New User';
        case 'visitor':
            return 'Visitor';
        default:
            return String(value || '');
    }
}

class CookieJar {
    constructor(session) {
        this.session = session;
        this.cookies = [];
    }

    async load() {
        this.importBase64(await this.session.configGet('headlessCookies', ''));
    }

    async save() {
        await this.session.configSet('headlessCookies', this.exportBase64());
    }

    clear() {
        this.cookies = [];
    }

    cloneCookies() {
        return this.cookies.map((cookie) => ({ ...cookie }));
    }

    mergeCookies(cookies) {
        for (const cookie of cookies || []) {
            this.cookies = this.cookies.filter(
                (item) =>
                    item.name !== cookie.name ||
                    item.domain !== cookie.domain ||
                    item.path !== cookie.path
            );
            this.cookies.push({ ...cookie });
        }
    }

    importBase64(value) {
        if (!value) {
            this.cookies = [];
            return;
        }
        try {
            const json = Buffer.from(value, 'base64').toString('utf8');
            const cookies = JSON.parse(json);
            this.cookies = Array.isArray(cookies) ? cookies : [];
            this.removeExpired();
        } catch {
            this.cookies = [];
        }
    }

    exportBase64() {
        this.removeExpired();
        return Buffer.from(JSON.stringify(this.cookies), 'utf8').toString('base64');
    }

    removeExpired() {
        const now = Date.now();
        this.cookies = this.cookies.filter(
            (cookie) => !cookie.expires || Date.parse(cookie.expires) > now
        );
    }

    domainMatches(hostname, cookie) {
        const domain = String(cookie.domain || '').toLowerCase();
        if (!domain) return false;
        if (cookie.hostOnly) return hostname === domain;
        return hostname === domain || hostname.endsWith(`.${domain}`);
    }

    pathMatches(pathname, cookiePath) {
        const pathValue = cookiePath || '/';
        return pathname === pathValue || pathname.startsWith(pathValue);
    }

    headerFor(urlValue) {
        this.removeExpired();
        const url = new URL(urlValue);
        const hostname = url.hostname.toLowerCase();
        const isSecure = url.protocol === 'https:';
        return this.cookies
            .filter(
                (cookie) =>
                    this.domainMatches(hostname, cookie) &&
                    this.pathMatches(url.pathname || '/', cookie.path) &&
                    (!cookie.secure || isSecure)
            )
            .sort((a, b) => (b.path || '/').length - (a.path || '/').length)
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join('; ');
    }

    defaultPath(pathname) {
        if (!pathname || pathname[0] !== '/') return '/';
        const index = pathname.lastIndexOf('/');
        if (index <= 0) return '/';
        return pathname.slice(0, index);
    }

    storeFromResponse(urlValue, headers) {
        const setCookieHeaders =
            typeof headers.getSetCookie === 'function'
                ? headers.getSetCookie()
                : splitSetCookieHeader(headers.get('set-cookie'));
        for (const header of setCookieHeaders) {
            this.storeCookie(urlValue, header);
        }
        return setCookieHeaders.length > 0;
    }

    storeCookie(urlValue, header) {
        const parts = header.split(';').map((part) => part.trim());
        const [nameValue, ...attributes] = parts;
        const equalsIndex = nameValue.indexOf('=');
        if (equalsIndex <= 0) return;

        const url = new URL(urlValue);
        const cookie = {
            name: nameValue.slice(0, equalsIndex),
            value: nameValue.slice(equalsIndex + 1),
            domain: url.hostname.toLowerCase(),
            hostOnly: true,
            path: this.defaultPath(url.pathname),
            secure: false,
            httpOnly: false,
            sameSite: '',
            expires: ''
        };

        let deleteCookie = false;
        for (const attribute of attributes) {
            const [rawKey, ...rawValue] = attribute.split('=');
            const key = rawKey.trim().toLowerCase();
            const value = rawValue.join('=').trim();
            if (key === 'domain' && value) {
                cookie.domain = value.replace(/^\./, '').toLowerCase();
                cookie.hostOnly = false;
            } else if (key === 'path' && value) {
                cookie.path = value;
            } else if (key === 'secure') {
                cookie.secure = true;
            } else if (key === 'httponly') {
                cookie.httpOnly = true;
            } else if (key === 'samesite') {
                cookie.sameSite = value;
            } else if (key === 'expires' && value) {
                if (Date.parse(value) <= Date.now()) deleteCookie = true;
                cookie.expires = value;
            } else if (key === 'max-age') {
                const maxAge = Number(value);
                if (Number.isFinite(maxAge)) {
                    if (maxAge <= 0) {
                        deleteCookie = true;
                    } else {
                        cookie.expires = new Date(
                            Date.now() + maxAge * 1000
                        ).toUTCString();
                    }
                }
            }
        }

        // VRCX's desktop CookieContainer deliberately keeps accepted session
        // cookies alive and lets the API decide whether they are still valid.
        // Match that behavior so a browser-independent backend does not discard
        // an otherwise reusable VRChat session merely because local time passed.
        if (!deleteCookie && cookie.expires) {
            cookie.expires = 'Fri, 31 Dec 9999 23:59:59 GMT';
        }

        this.cookies = this.cookies.filter(
            (item) =>
                item.name !== cookie.name ||
                item.domain !== cookie.domain ||
                item.path !== cookie.path
        );
        if (!deleteCookie) this.cookies.push(cookie);
    }
}

class HeadlessSession {
    constructor(dotnetBridge) {
        this.bridge = dotnetBridge;
        this.endpointDomain = process.env.VRCX_API_ENDPOINT || defaultEndpoint;
        this.websocketDomain = process.env.VRCX_PIPELINE_ENDPOINT || defaultPipeline;
        this.currentUser = null;
        this.loggedIn = false;
        this.authState = 'logged_out';
        this.authStateReason = '';
        this.pendingTwoFactor = [];
        this.pendingLoginParams = null;
        this.authOperation = Promise.resolve();
        this.websocketConnected = false;
        this.websocketMessageCount = 0;
        this.lastPipelineMessage = '';
        this.pipelineSocket = null;
        this.reconnectTimer = null;
        this.pipelineHeartbeatTimer = null;
        this.pipelineRecoveryTimer = null;
        this.authRecoveryTimer = null;
        this.authRecoveryInFlight = false;
        this.lastAuthValidationAt = 0;
        this.lastAuthRecoveryAt = 0;
        this.authRecoveryCount = 0;
        this.autoRecoveryDisabled = false;
        this.friendRefreshTimer = null;
        this.friendRefreshInFlight = false;
        this.clients = new Set();
        this.friends = new Map();
        this.logStreamClients = new Map();
        this.pipelineSelfInstance = {
            location: '',
            locationAt: 0,
            locationCreatedAt: '',
            worldName: ''
        };
        this.worldNameCache = new Map();
        this.groupNameCache = new Map();
        this.avatarNameCache = new Map();
        this.startedAt = new Date().toJSON();
        this.cookieJar = new CookieJar(this);
        this.logStreamToken = process.env.VRCX_LOG_STREAM_TOKEN || '';
    }

    async init({ restoreSession = true } = {}) {
        await this.initGlobalTables();
        await this.cookieJar.load();
        this.autoRecoveryDisabled =
            (await this.configGet('headlessAutoRecoveryDisabled', 'false')) ===
            'true';
        await this.restoreEndpointFromStorage();
        if (restoreSession) {
            await this.tryRestoreSession();
        }
    }

    state() {
        return {
            startedAt: this.startedAt,
            loggedIn: this.loggedIn,
            authState: this.authState,
            authStateReason: this.authStateReason,
            authMaintenance: {
                validationIntervalMs: authValidationIntervalMs,
                autoRecoveryEnabled: !this.autoRecoveryDisabled,
                lastValidatedAt: this.lastAuthValidationAt
                    ? new Date(this.lastAuthValidationAt).toJSON()
                    : '',
                lastRecoveredAt: this.lastAuthRecoveryAt
                    ? new Date(this.lastAuthRecoveryAt).toJSON()
                    : '',
                recoveryCount: this.authRecoveryCount
            },
            pendingTwoFactor: this.pendingTwoFactor,
            websocketConnected: this.websocketConnected,
            websocketMessageCount: this.websocketMessageCount,
            currentUser: this.currentUser
                ? {
                      id: this.currentUser.id,
                      displayName: this.currentUser.displayName,
                      username: this.currentUser.username
                  }
                : null,
            endpointDomain: this.endpointDomain,
            websocketDomain: this.websocketDomain,
            browserClients: this.clients.size,
            friendCacheSize: this.friends.size,
            logStream: {
                tokenConfigured: !!this.logStreamToken,
                clients: Array.from(this.logStreamClients.values()).map((client) => ({
                    machineId: client.machineId,
                    connected: !!client.connected,
                    lastSeenAt: client.lastSeenAt || '',
                    lastEventAt: client.lastEventAt || '',
                    currentFile: client.currentFile || '',
                    fileOffset: client.fileOffset || 0,
                    acceptedCount: client.acceptedCount || 0,
                    duplicateCount: client.duplicateCount || 0,
                    failedCount: client.failedCount || 0,
                    lastError: client.lastError || ''
                }))
            }
        };
    }

    async call(className, methodName, args = []) {
        return await this.bridge.call(className, methodName, args);
    }

    async sqliteExecute(sql, args = null) {
        const json = await this.call('SQLite', 'ExecuteJson', [
            sql,
            toDotNetMap(normalizeSqlArgs(sql, args))
        ]);
        return JSON.parse(json || '[]');
    }

    async sqliteNonQuery(sql, args = null) {
        return await this.call('SQLite', 'ExecuteNonQuery', [
            sql,
            toDotNetMap(normalizeSqlArgs(sql, args))
        ]);
    }

    async storageGet(key) {
        return await this.call('VRCXStorage', 'Get', [key]);
    }

    async storageSet(key, value) {
        return await this.call('VRCXStorage', 'Set', [key, String(value ?? '')]);
    }

    isTwoFactorCookie(cookie) {
        return String(cookie?.name || '').toLowerCase() === 'twofactorauth';
    }

    async clearCookies({ preserveTwoFactorCookies = false } = {}) {
        const preservedCookies = preserveTwoFactorCookies
            ? this.cookieJar
                  .cloneCookies()
                  .filter((cookie) => this.isTwoFactorCookie(cookie))
            : [];
        this.cookieJar.clear();
        this.cookieJar.mergeCookies(preservedCookies);
        await this.cookieJar.save();
    }

    async mergeSavedTwoFactorCookies(cookies) {
        if (!cookies) return;
        const savedJar = new CookieJar(this);
        savedJar.importBase64(cookies);
        this.cookieJar.mergeCookies(
            savedJar
                .cloneCookies()
                .filter((cookie) => this.isTwoFactorCookie(cookie))
        );
        await this.cookieJar.save();
    }

    async getCookies() {
        return this.cookieJar.exportBase64();
    }

    async setCookies(cookies) {
        const savedJar = new CookieJar(this);
        savedJar.importBase64(cookies);
        this.cookieJar.mergeCookies(savedJar.cloneCookies());
        await this.cookieJar.save();
    }

    async configGet(key, defaultValue = null) {
        const rows = await this.sqliteExecute(
            'SELECT value FROM configs WHERE key = @key',
            {
                '@key': `config:${String(key).toLowerCase()}`
            }
        );
        if (!rows.length || rows[0][0] === undefined || rows[0][0] === null) {
            return defaultValue;
        }
        return rows[0][0];
    }

    async configSet(key, value) {
        await this.sqliteNonQuery(
            'INSERT OR REPLACE INTO configs (key, value) VALUES (@key, @value)',
            {
                '@key': `config:${String(key).toLowerCase()}`,
                '@value': String(value ?? '')
            }
        );
    }

    async configRemove(key) {
        await this.sqliteNonQuery('DELETE FROM configs WHERE key = @key', {
            '@key': `config:${String(key).toLowerCase()}`
        });
    }

    setAuthState(authState, reason = '') {
        this.authState = authState;
        this.authStateReason = reason;
    }

    async runAuthOperation(operation) {
        const previous = this.authOperation;
        let release;
        this.authOperation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    stopAuthenticatedServices() {
        this.loggedIn = false;
        this.stopFriendRefreshLoop();
        this.closePipeline();
    }

    async persistPendingLogin() {
        if (!this.pendingLoginParams) {
            await this.configRemove('headlessPendingLogin');
            return;
        }
        await this.configSet(
            'headlessPendingLogin',
            JSON.stringify({
                loginParams: this.pendingLoginParams,
                pendingTwoFactor: this.pendingTwoFactor
            })
        );
    }

    async loadPendingLogin() {
        const raw = await this.configGet('headlessPendingLogin', '');
        if (!raw) return false;
        try {
            const pending = JSON.parse(raw);
            if (!pending?.loginParams) return false;
            this.pendingLoginParams = this.buildLoginParams(pending.loginParams);
            this.pendingTwoFactor = Array.isArray(pending.pendingTwoFactor)
                ? pending.pendingTwoFactor
                : [];
            return true;
        } catch {
            await this.configRemove('headlessPendingLogin');
            return false;
        }
    }

    async enterTwoFactor(user, loginParams = null) {
        this.stopAuthenticatedServices();
        this.currentUser = null;
        this.pendingTwoFactor = Array.isArray(user?.requiresTwoFactorAuth)
            ? user.requiresTwoFactorAuth
            : [];
        if (loginParams) {
            this.pendingLoginParams = this.buildLoginParams(loginParams);
        }
        this.setAuthState('awaiting_2fa');
        await this.persistPendingLogin();
        this.broadcast({ type: 'state', state: this.state() });
    }

    async markAuthenticationLost(reason) {
        if (this.authState === 'awaiting_2fa' || this.authState === 'authenticating') {
            return;
        }
        this.stopAuthenticatedServices();
        this.currentUser = null;
        this.setAuthState('recovering', reason || 'VRChat session expired');
        this.broadcast({ type: 'state', state: this.state() });
        setTimeout(() => {
            this.ensureAuthenticated().catch((err) => {
                console.warn('Immediate auth recovery failed:', err.message || err);
            });
        }, 0).unref?.();
    }

    async webApiExecute(options) {
        const headers = {
            'User-Agent': `VRCX ${readVersion()}`,
            ...(options.headers || {})
        };
        const cookieHeader = this.cookieJar.headerFor(options.url);
        if (cookieHeader) headers.Cookie = cookieHeader;

        const init = {
            method: options.method || 'GET',
            headers
        };

        if (options.uploadFilePUT) {
            init.body = Buffer.from(String(options.fileData || ''), 'base64');
            init.headers['Content-Type'] = options.fileMIME || 'application/octet-stream';
            if (options.fileMD5) init.headers['Content-MD5'] = options.fileMD5;
        } else if (
            options.uploadImage ||
            options.uploadImageLegacy ||
            options.uploadImagePrint
        ) {
            const formData = new FormData();
            const postData = parseMaybeJson(options.postData) || {};
            if (options.uploadImageLegacy) {
                formData.append('data', String(options.postData || ''));
                formData.append(
                    'image',
                    new Blob([Buffer.from(String(options.imageData || ''), 'base64')], {
                        type: 'image/png'
                    }),
                    'image.png'
                );
            } else if (options.uploadImagePrint) {
                for (const [key, value] of Object.entries(postData)) {
                    formData.append(key, String(value));
                }
                formData.append(
                    'image',
                    new Blob([Buffer.from(String(options.imageData || ''), 'base64')], {
                        type: 'image/png'
                    }),
                    'image'
                );
            } else {
                for (const [key, value] of Object.entries(postData)) {
                    formData.append(key, String(value));
                }
                formData.append(
                    'file',
                    new Blob([Buffer.from(String(options.imageData || ''), 'base64')], {
                        type: 'image/png'
                    }),
                    'blob'
                );
            }
            delete init.headers['Content-Type'];
            init.body = formData;
        } else if (options.body !== undefined && init.method !== 'GET') {
            init.body = options.body;
        }

        const wasLoggedIn = this.loggedIn;
        const trustedCookies = this.cookieJar
            .cloneCookies()
            .filter((cookie) => this.isTwoFactorCookie(cookie));
        const response = await fetch(options.url, init);
        const cookiesChanged = this.cookieJar.storeFromResponse(
            options.url,
            response.headers
        );

        const contentType = response.headers.get('content-type') || '';
        let data =
            contentType.includes('image/') ||
            contentType.includes('application/octet-stream')
                ? `data:image/png;base64,${Buffer.from(
                      await response.arrayBuffer()
                  ).toString('base64')}`
                : await response.text();

        const authenticationError =
            response.status === 401 && this.isAuthenticationErrorResponse(data);
        const authenticationFailed = wasLoggedIn && authenticationError;

        // A rejected auth response may delete every cookie. Keep the independent
        // 2FA trust cookie so password fallback can mint a new auth session without
        // asking the operator for another code.
        if (response.status === 401 && trustedCookies.length) {
            this.cookieJar.mergeCookies(trustedCookies);
        }
        await this.cookieJar.save();

        if (
            cookiesChanged &&
            this.loggedIn &&
            this.currentUser?.id &&
            !authenticationFailed
        ) {
            await this.updateSavedCookieSnapshot();
        }

        if (authenticationFailed) {
            await this.markAuthenticationLost('VRChat rejected the active session');
        }

        if (response.status === 200 && !data.startsWith('data:')) {
            data = this.augmentApiResponse(options.url, data);
        }

        return {
            status: response.status,
            data
        };
    }

    isAuthenticationErrorResponse(data) {
        const parsed = parseMaybeJson(data);
        const message = String(
            parsed?.error?.message || parsed?.message || data || ''
        ).toLowerCase();
        return message.includes('missing credentials') || message.includes('unauthorized');
    }

    async vrchatRequest(endpoint, options = {}) {
        const result = await this.webApiExecute(
            buildRequestInit(endpoint, options, this.endpointDomain)
        );
        const data = parseMaybeJson(result.data);
        if (result.status < 200 || result.status >= 300) {
            const err = new Error(
                data?.error?.message || data?.message || result.data || 'VRChat API error'
            );
            err.status = result.status;
            err.data = data;
            err.endpoint = endpoint;
            throw err;
        }
        return data;
    }

    async initGlobalTables() {
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT)'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_event (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data))'
        );
        await this.sqliteNonQuery(
            `DELETE FROM gamelog_event
             WHERE trim(data) LIKE '{"type":%'
               AND data LIKE '%"content":%'`
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location))'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS gamelog_location_created_at_idx ON gamelog_location (created_at)'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS idx_gamelog_location_world_created ON gamelog_location (world_id, created_at)'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name))'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location)'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_created ON gamelog_join_leave (user_id, created_at)'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_display_created ON gamelog_join_leave (display_name, created_at)'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (id INTEGER PRIMARY KEY, created_at TEXT, display_name TEXT, location TEXT, user_id TEXT, instance_id TEXT, world_name TEXT, UNIQUE(created_at, display_name))'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_resource_load (id INTEGER PRIMARY KEY, created_at TEXT, resource_url TEXT, resource_type TEXT, location TEXT, UNIQUE(created_at, resource_url))'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS gamelog_external (id INTEGER PRIMARY KEY, created_at TEXT, message TEXT, display_name TEXT, user_id TEXT, location TEXT, UNIQUE(created_at, message))'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS headless_pipeline_events (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, data TEXT)'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS headless_log_stream_events (client_event_id TEXT PRIMARY KEY, received_at TEXT, machine_id TEXT, file_name TEXT, file_offset INTEGER, logged_at TEXT, event_type TEXT, raw_line TEXT, data TEXT)'
        );
        await this.sqliteNonQuery(
            'CREATE INDEX IF NOT EXISTS headless_log_stream_events_logged_at_idx ON headless_log_stream_events (logged_at)'
        );
        await this.sqliteNonQuery(
            'CREATE TABLE IF NOT EXISTS headless_log_stream_clients (machine_id TEXT PRIMARY KEY, last_seen_at TEXT, last_event_at TEXT, current_file TEXT, file_offset INTEGER, connected INTEGER, accepted_count INTEGER, duplicate_count INTEGER, failed_count INTEGER, last_error TEXT)'
        );
    }

    async initUserTables(userId) {
        const prefix = userPrefix(userId);
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_feed_status (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_feed_avatar (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, owner_id TEXT, avatar_name TEXT, current_avatar_image_url TEXT, current_avatar_thumbnail_image_url TEXT, previous_current_avatar_image_url TEXT, previous_current_avatar_thumbnail_image_url TEXT)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT)`
        );
        await this.sqliteNonQuery(
            `CREATE INDEX IF NOT EXISTS ${prefix}_feed_online_offline_user_created_idx ON ${prefix}_feed_online_offline (user_id, created_at)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER)`
        );
        await this.sqliteNonQuery(
            `CREATE INDEX IF NOT EXISTS ${prefix}_friend_log_history_user_id_idx ON ${prefix}_friend_log_history (user_id)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_notifications (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired INTEGER)`
        );
        await this.sqliteNonQuery(
            `CREATE TABLE IF NOT EXISTS ${prefix}_notifications_v2 (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen INTEGER, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT)`
        );
    }

    async restoreEndpointFromStorage() {
        const savedCredentials = await this.getSavedCredentials();
        const lastUserLoggedIn = await this.configGet('lastUserLoggedIn', '');
        const saved = savedCredentials[lastUserLoggedIn];
        if (saved?.loginParams?.endpoint) {
            this.endpointDomain = saved.loginParams.endpoint;
            this.websocketDomain = saved.loginParams.websocket || defaultPipeline;
        }
    }

    async getSavedCredentials() {
        const raw = await this.configGet('savedCredentials', '{}');
        try {
            return JSON.parse(raw || '{}');
        } catch {
            return {};
        }
    }

    async getRecoveryCredential() {
        if (this.autoRecoveryDisabled) return null;

        const savedCredentials = await this.getSavedCredentials();
        const lastUserLoggedIn = await this.configGet('lastUserLoggedIn', '');
        if (lastUserLoggedIn && savedCredentials[lastUserLoggedIn]) {
            return {
                userId: lastUserLoggedIn,
                saved: savedCredentials[lastUserLoggedIn]
            };
        }

        const candidates = Object.entries(savedCredentials).filter(
            ([, saved]) => saved?.user?.id && saved?.loginParams
        );
        let candidate = candidates.length === 1 ? candidates[0] : null;
        if (!candidate && candidates.length > 1) {
            const dated = candidates
                .filter(([, saved]) => Number.isFinite(Date.parse(saved.updatedAt)))
                .sort(
                    ([, a], [, b]) =>
                        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
                );
            if (dated.length) candidate = dated[0];
        }
        if (!candidate) return null;

        const [userId, saved] = candidate;
        await this.configSet('lastUserLoggedIn', userId);
        console.warn(`Rebuilt missing last-user recovery index for ${userId}`);
        return { userId, saved };
    }

    async saveCredential(user, loginParams = null) {
        if (!user?.id) return;
        const savedCredentials = await this.getSavedCredentials();
        const existing = savedCredentials[user.id];

        const cookies = await this.getCookies();
        savedCredentials[user.id] = {
            user,
            loginParams: {
                username: existing?.loginParams?.username || '',
                password: existing?.loginParams?.password || '',
                endpoint: existing?.loginParams?.endpoint || '',
                websocket: existing?.loginParams?.websocket || '',
                ...(loginParams || {})
            },
            cookies,
            updatedAt: new Date().toJSON()
        };
        await this.configSet('savedCredentials', JSON.stringify(savedCredentials));
        await this.configSet('lastUserLoggedIn', user.id);
        this.autoRecoveryDisabled = false;
        await this.configRemove('headlessAutoRecoveryDisabled');
    }

    async updateSavedCookieSnapshot() {
        if (!this.currentUser?.id) return;
        const savedCredentials = await this.getSavedCredentials();
        const saved = savedCredentials[this.currentUser.id];
        if (!saved) return;
        saved.user = this.currentUser;
        saved.cookies = await this.getCookies();
        saved.updatedAt = new Date().toJSON();
        await this.configSet('savedCredentials', JSON.stringify(savedCredentials));
    }

    buildLoginParams({ username, password, endpoint, websocket }) {
        return {
            username: username || '',
            password: password || '',
            endpoint: endpoint || '',
            websocket: websocket || ''
        };
    }

    async requestCurrentUser() {
        await this.vrchatRequest('config');
        return await this.vrchatRequest('auth/user');
    }

    async restoreWithCookies(cookies, loginParams = null) {
        if (cookies) await this.setCookies(cookies);
        const user = await this.requestCurrentUser();
        if (user?.requiresTwoFactorAuth) {
            await this.enterTwoFactor(user, loginParams);
            console.log(
                `Restored login requires 2FA: ${this.pendingTwoFactor.join(', ')}`
            );
            return false;
        }
        await this.completeLogin(user, loginParams);
        console.log(`Restored VRCX session for ${user.displayName || user.id}`);
        return true;
    }

    async tryRestoreSession() {
        const recoveryCredential = await this.getRecoveryCredential();
        const saved = recoveryCredential?.saved;
        await this.loadPendingLogin();

        if (this.autoRecoveryDisabled) return false;

        try {
            if (this.cookieJar.cookies.length) {
                return await this.restoreWithCookies(
                    null,
                    this.pendingLoginParams || saved?.loginParams || null
                );
            }
        } catch (err) {
            console.warn('Active VRChat session could not be restored:', err.message || err);
        }

        try {
            if (saved?.cookies) {
                return await this.restoreWithCookies(
                    saved.cookies,
                    this.pendingLoginParams || saved.loginParams || null
                );
            }
        } catch (err) {
            console.warn('Saved VRChat session could not be restored:', err.message || err);
        }

        return await this.trySavedPasswordLogin(saved);
    }

    async trySavedPasswordLogin(saved = null) {
        try {
            if (!saved) {
                const recoveryCredential = await this.getRecoveryCredential();
                saved = recoveryCredential?.saved;
            }
            const primaryPasswordEnabled =
                (await this.configGet('enablePrimaryPassword', 'false')) === 'true';
            if (primaryPasswordEnabled) return false;
            const loginParams = saved?.loginParams;
            if (!loginParams?.username || !loginParams?.password) return false;
            await this.mergeSavedTwoFactorCookies(saved.cookies);
            await this.loginInternal(
                {
                    username: loginParams.username,
                    password: loginParams.password,
                    endpoint: loginParams.endpoint || '',
                    websocket: loginParams.websocket || ''
                },
                { preserveTwoFactorCookies: true }
            );
            return this.loggedIn;
        } catch (err) {
            console.warn('Saved password login failed:', err.message || err);
            if (this.authState !== 'awaiting_2fa') {
                if (Number.isInteger(err?.status)) {
                    this.setAuthState(
                        'logged_out',
                        err.message || 'Saved login failed'
                    );
                } else {
                    this.setAuthState(
                        'recovering',
                        'VRChat network unavailable; recovery will retry'
                    );
                }
                this.broadcast({ type: 'state', state: this.state() });
            }
            return false;
        }
    }

    async login(params) {
        return await this.runAuthOperation(() => this.loginInternal(params));
    }

    async loginInternal(
        { username, password, endpoint, websocket },
        { preserveTwoFactorCookies = false } = {}
    ) {
        if (!username || !password) {
            const err = new Error('Username and password are required.');
            err.status = 400;
            throw err;
        }

        this.stopAuthenticatedServices();
        this.currentUser = null;
        this.endpointDomain = endpoint || defaultEndpoint;
        this.websocketDomain = websocket || defaultPipeline;
        this.pendingTwoFactor = [];
        this.pendingLoginParams = null;
        this.setAuthState('authenticating');
        await this.persistPendingLogin();
        this.broadcast({ type: 'state', state: this.state() });
        await this.clearCookies({ preserveTwoFactorCookies });
        const loginParams = this.buildLoginParams({
            username,
            password,
            endpoint,
            websocket
        });

        try {
            await this.vrchatRequest('config');
            const auth = Buffer.from(
                `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
            ).toString('base64');
            const user = await this.vrchatRequest('auth/user', {
                method: 'GET',
                headers: {
                    Authorization: `Basic ${auth}`
                }
            });

            if (user?.requiresTwoFactorAuth) {
                await this.enterTwoFactor(user, loginParams);
                console.log(
                    `VRChat login requires 2FA: ${this.pendingTwoFactor.join(', ')}`
                );
                return {
                    requiresTwoFactorAuth: this.pendingTwoFactor
                };
            }

            await this.completeLogin(user, loginParams);
            return user;
        } catch (err) {
            if (this.authState !== 'awaiting_2fa') {
                this.pendingTwoFactor = [];
                this.pendingLoginParams = null;
                await this.persistPendingLogin();
                this.setAuthState('logged_out', err.message || 'Login failed');
                this.broadcast({ type: 'state', state: this.state() });
            }
            throw err;
        }
    }

    async verifyTwoFactor(type, code) {
        return await this.runAuthOperation(() =>
            this.verifyTwoFactorInternal(type, code)
        );
    }

    async verifyTwoFactorInternal(type, code) {
        const endpoints = {
            otp: 'auth/twofactorauth/otp/verify',
            totp: 'auth/twofactorauth/totp/verify',
            emailOtp: 'auth/twofactorauth/emailotp/verify'
        };
        const endpoint = endpoints[type];
        if (!endpoint) {
            const err = new Error(`Unsupported 2FA type: ${type}`);
            err.status = 400;
            throw err;
        }
        if (this.authState !== 'awaiting_2fa' || !this.pendingTwoFactor.length) {
            const err = new Error(
                'No pending VRChat login. Please submit username and password again.'
            );
            err.status = 409;
            throw err;
        }
        if (!code || !String(code).trim()) {
            const err = new Error('Two-factor authentication code is required.');
            err.status = 400;
            throw err;
        }

        try {
            await this.vrchatRequest(endpoint, {
                method: 'POST',
                params: { code: String(code).trim() }
            });
            const user = await this.vrchatRequest('auth/user');
            if (user?.requiresTwoFactorAuth) {
                await this.enterTwoFactor(user, this.pendingLoginParams);
                const err = new Error('VRChat did not accept the two-factor code.');
                err.status = 401;
                throw err;
            }
            const loginParams = this.pendingLoginParams;
            await this.completeLogin(user, loginParams);
            console.log(`VRChat 2FA verified for ${user.displayName || user.id}`);
            return user;
        } catch (err) {
            if (this.authState !== 'authenticated') {
                this.setAuthState('awaiting_2fa', err.message || '2FA verification failed');
                this.broadcast({ type: 'state', state: this.state() });
            }
            throw err;
        }
    }

    async resendEmailTwoFactor() {
        return await this.runAuthOperation(async () => {
            if (
                this.authState !== 'awaiting_2fa' ||
                !this.pendingLoginParams?.username ||
                !this.pendingLoginParams?.password
            ) {
                const err = new Error(
                    'No pending login credentials are available to resend email 2FA.'
                );
                err.status = 409;
                throw err;
            }
            const result = await this.loginInternal(this.pendingLoginParams);
            if (!result?.requiresTwoFactorAuth?.includes('emailOtp')) {
                const err = new Error('VRChat did not request email 2FA.');
                err.status = 409;
                throw err;
            }
            return result;
        });
    }

    async logout() {
        return await this.runAuthOperation(async () => {
            this.stopAuthenticatedServices();
            this.currentUser = null;
            this.pendingTwoFactor = [];
            this.pendingLoginParams = null;
            this.friends.clear();
            this.setAuthState('logged_out');
            await this.persistPendingLogin();
            await this.clearCookies();
            await this.configRemove('lastUserLoggedIn');
            this.autoRecoveryDisabled = true;
            await this.configSet('headlessAutoRecoveryDisabled', 'true');
            this.broadcast({ type: 'state', state: this.state() });
        });
    }

    startAuthRecoveryLoop() {
        this.stopAuthRecoveryLoop();
        this.authRecoveryTimer = setInterval(() => {
            this.maintainAuthentication().catch((err) => {
                console.warn('Auth maintenance failed:', err.message || err);
            });
        }, 60000);
        this.authRecoveryTimer.unref?.();
    }

    stopAuthRecoveryLoop() {
        if (this.authRecoveryTimer) {
            clearInterval(this.authRecoveryTimer);
            this.authRecoveryTimer = null;
        }
    }

    async ensureAuthenticated() {
        if (
            this.authState === 'authenticated' ||
            this.authState === 'awaiting_2fa' ||
            this.authState === 'authenticating' ||
            this.authRecoveryInFlight
        ) {
            return false;
        }
        return await this.runAuthOperation(async () => {
            if (
                this.authState === 'authenticated' ||
                this.authState === 'awaiting_2fa' ||
                this.authState === 'authenticating'
            ) {
                return false;
            }
            this.authRecoveryInFlight = true;
            this.setAuthState('recovering');
            this.broadcast({ type: 'state', state: this.state() });
            try {
                const restored = await this.tryRestoreSession();
                if (restored) {
                    this.lastAuthRecoveryAt = Date.now();
                    this.authRecoveryCount++;
                }
                if (
                    !restored &&
                    this.authState === 'recovering' &&
                    !this.authStateReason
                ) {
                    this.setAuthState('logged_out', 'No reusable VRChat session');
                }
                this.broadcast({ type: 'state', state: this.state() });
                return restored;
            } finally {
                this.authRecoveryInFlight = false;
            }
        });
    }

    async maintainAuthentication() {
        if (!this.loggedIn || this.authState !== 'authenticated') {
            return await this.ensureAuthenticated();
        }
        if (Date.now() - this.lastAuthValidationAt < authValidationIntervalMs) {
            return false;
        }

        return await this.runAuthOperation(async () => {
            if (!this.loggedIn || this.authState !== 'authenticated') return false;
            if (Date.now() - this.lastAuthValidationAt < authValidationIntervalMs) {
                return false;
            }
            try {
                const user = await this.requestCurrentUser();
                if (user?.requiresTwoFactorAuth) {
                    const lastUserLoggedIn = await this.configGet(
                        'lastUserLoggedIn',
                        ''
                    );
                    const savedCredentials = await this.getSavedCredentials();
                    await this.enterTwoFactor(
                        user,
                        savedCredentials[lastUserLoggedIn]?.loginParams || null
                    );
                    return false;
                }
                this.currentUser = user;
                this.lastAuthValidationAt = Date.now();
                await this.saveCredential(user);
                this.broadcast({ type: 'state', state: this.state() });
                return true;
            } catch (err) {
                // Authentication 401s schedule recovery in webApiExecute. Network
                // errors leave the current session intact for the next probe.
                if (this.authState !== 'recovering') {
                    console.warn('VRChat session validation failed:', err.message || err);
                }
                return false;
            }
        });
    }

    async completeLogin(user, loginParams = null) {
        if (!user?.id || user?.requiresTwoFactorAuth) {
            const err = new Error('VRChat login is not fully authenticated.');
            err.status = 401;
            throw err;
        }
        this.currentUser = user;
        await this.initUserTables(user.id);
        await this.saveCredential(user, loginParams);
        this.loggedIn = true;
        this.lastAuthValidationAt = Date.now();
        this.pendingTwoFactor = [];
        this.pendingLoginParams = null;
        this.setAuthState('authenticated');
        await this.persistPendingLogin();
        this.broadcast({ type: 'state', state: this.state() });
        this.connectPipeline().catch((err) => {
            console.warn('Initial Pipeline connection failed:', err.message || err);
        });
        this.initializeAuthenticatedData(user.id).catch((err) => {
            console.warn('Post-login initialization failed:', err.message || err);
        });
    }

    async initializeAuthenticatedData(userId) {
        await this.loadFriendSnapshot();
        if (!this.loggedIn || this.currentUser?.id !== userId) return;
        await this.backfillSelfInstanceActivityFromLocations();
        if (!this.loggedIn || this.currentUser?.id !== userId) return;
        this.startFriendRefreshLoop();
        await this.backfillFeedFromPipelineEvents();
        if (!this.loggedIn || this.currentUser?.id !== userId) return;
        this.broadcast({ type: 'feed-refresh' });
    }

    async backfillSelfInstanceActivityFromLocations() {
        if (!this.currentUser?.id) return;
        const userId = this.currentUser.id;
        const displayName = this.currentUser.displayName || this.currentUser.username || userId;
        const joined = await this.sqliteNonQuery(
            `INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time)
             SELECT gl.created_at, 'OnPlayerJoined', @display_name, gl.location, @user_id, 0
             FROM gamelog_location gl
             WHERE gl.location != ''
               AND gl.location != 'traveling'
               AND NOT EXISTS (
                   SELECT 1
                   FROM gamelog_join_leave jl
                   WHERE jl.user_id = @user_id
                     AND jl.type = 'OnPlayerJoined'
                     AND jl.location = gl.location
                     AND jl.created_at = gl.created_at
               )`,
            {
                '@display_name': displayName,
                '@user_id': userId
            }
        );
        const left = await this.sqliteNonQuery(
            `INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time)
             SELECT
                 strftime('%Y-%m-%dT%H:%M:%fZ', gl.created_at, '+' || (gl.time * 1.0 / 1000) || ' seconds'),
                 'OnPlayerLeft',
                 @display_name,
                 gl.location,
                 @user_id,
                 gl.time
             FROM gamelog_location gl
             WHERE gl.location != ''
               AND gl.location != 'traveling'
               AND gl.time > 0
               AND NOT EXISTS (
                   SELECT 1
                   FROM gamelog_join_leave jl
                   WHERE jl.user_id = @user_id
                     AND jl.type = 'OnPlayerLeft'
                     AND jl.location = gl.location
                     AND julianday(jl.created_at) BETWEEN julianday(gl.created_at)
                         AND julianday(gl.created_at, '+' || ((gl.time + 1000) * 1.0 / 1000) || ' seconds')
               )`,
            {
                '@display_name': displayName,
                '@user_id': userId
            }
        );
        if (Number(joined || 0) || Number(left || 0)) {
            this.broadcast({ type: 'game-log-refresh' });
        }
    }

    stateForUserId(userId, fallback = 'offline') {
        if (this.currentUser?.onlineFriends?.includes(userId)) return 'online';
        if (this.currentUser?.activeFriends?.includes(userId)) return 'active';
        if (this.currentUser?.offlineFriends?.includes(userId)) return 'offline';
        return fallback;
    }

    async loadFriendSnapshot({ persistChanges = false } = {}) {
        if (!this.currentUser?.id) return;
        const friends = [];
        const load = async (offline) => {
            const pageSize = 100;
            for (let offset = 0; offset < 50000; offset += pageSize) {
                const page = await this.vrchatRequest('auth/user/friends', {
                    method: 'GET',
                    params: {
                        offline,
                        n: pageSize,
                        offset
                    }
                });
                if (!Array.isArray(page) || page.length === 0) break;
                for (const friend of page) {
                    friend.state = this.stateForUserId(
                        friend.id,
                        offline ? 'offline' : 'online'
                    );
                    friends.push(friend);
                    await this.mergeUser(friend, { persist: persistChanges });
                }
                if (page.length < pageSize) break;
            }
        };
        await load(false);
        await load(true);
        await this.reconcileFriendLogSnapshot(friends);
    }

    startFriendRefreshLoop() {
        this.stopFriendRefreshLoop();
        if (!Number.isFinite(friendRefreshIntervalMs) || friendRefreshIntervalMs <= 0) {
            return;
        }
        this.friendRefreshTimer = setInterval(() => {
            this.refreshFriendSnapshot().catch((err) => {
                console.warn('Friend snapshot refresh failed:', err.message || err);
            });
        }, friendRefreshIntervalMs);
        this.friendRefreshTimer.unref?.();
    }

    stopFriendRefreshLoop() {
        if (this.friendRefreshTimer) {
            clearInterval(this.friendRefreshTimer);
            this.friendRefreshTimer = null;
        }
    }

    async refreshFriendSnapshot() {
        if (!this.loggedIn || this.friendRefreshInFlight) return;
        this.friendRefreshInFlight = true;
        try {
            await this.loadFriendSnapshot({ persistChanges: true });
            this.broadcast({ type: 'feed-refresh' });
        } finally {
            this.friendRefreshInFlight = false;
        }
    }

    async connectPipeline() {
        if (!this.loggedIn || this.pipelineSocket) return;
        try {
            const auth = await this.vrchatRequest('auth');
            if (!auth?.ok || !auth.token) return;
            const socket = new WebSocketClient(
                `${this.websocketDomain}/?auth=${encodeURIComponent(auth.token)}`,
                {
                    handshakeTimeout: 15000,
                    perMessageDeflate: false,
                    headers: {
                        'User-Agent': `VRCX ${readVersion()} Headless`
                    }
                }
            );
            socket.isAlive = true;
            this.pipelineSocket = socket;
            socket.on('open', () => {
                socket.isAlive = true;
                this.websocketConnected = true;
                this.startPipelineHeartbeat(socket);
                this.broadcast({ type: 'state', state: this.state() });
                console.log('VRChat Pipeline connected.');
            });
            socket.on('pong', () => {
                socket.isAlive = true;
            });
            socket.on('close', (code, reason) => {
                if (this.pipelineSocket === socket) {
                    this.pipelineSocket = null;
                }
                this.stopPipelineHeartbeat(socket);
                this.websocketConnected = false;
                this.broadcast({ type: 'state', state: this.state() });
                if (this.loggedIn && code !== 1000) {
                    const reasonText = reason?.toString?.() || '';
                    console.warn(
                        `VRChat Pipeline closed with code ${code}${reasonText ? `: ${reasonText}` : ''}`
                    );
                }
                this.schedulePipelineReconnect();
            });
            socket.on('error', (err) => {
                console.warn('VRChat Pipeline error:', err?.message || err);
                try {
                    socket.terminate();
                } catch {
                    // ignored
                }
            });
            socket.on('message', async (data) => {
                const raw = Buffer.isBuffer(data)
                    ? data.toString('utf8')
                    : String(data);
                await this.handlePipelineMessage(raw);
            });
        } catch (err) {
            console.warn('Failed to connect VRChat Pipeline:', err.message || err);
            if (
                this.loggedIn &&
                String(err?.message || '').toLowerCase().includes('two-factor')
            ) {
                await this.markAuthenticationLost(
                    'VRChat requires two-factor authentication again'
                );
                return;
            }
            this.schedulePipelineReconnect();
        }
    }

    closePipeline() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.pipelineSocket;
        this.pipelineSocket = null;
        this.websocketConnected = false;
        this.stopPipelineHeartbeat(socket);
        if (socket) {
            try {
                socket.close();
            } catch {
                // ignored
            }
        }
    }

    startPipelineHeartbeat(socket) {
        this.stopPipelineHeartbeat();
        this.pipelineHeartbeatTimer = setInterval(() => {
            if (this.pipelineSocket !== socket) {
                this.stopPipelineHeartbeat(socket);
                return;
            }
            if (socket.readyState !== WebSocketClient.OPEN) {
                try {
                    socket.terminate();
                } catch {
                    // ignored
                }
                return;
            }
            if (socket.isAlive === false) {
                console.warn('VRChat Pipeline heartbeat timed out; reconnecting.');
                try {
                    socket.terminate();
                } catch {
                    // ignored
                }
                return;
            }
            socket.isAlive = false;
            try {
                socket.ping();
            } catch {
                try {
                    socket.terminate();
                } catch {
                    // ignored
                }
            }
        }, 30000);
        this.pipelineHeartbeatTimer.unref?.();
    }

    stopPipelineHeartbeat(socket = null) {
        if (socket && this.pipelineSocket === socket && this.websocketConnected) {
            return;
        }
        if (this.pipelineHeartbeatTimer) {
            clearInterval(this.pipelineHeartbeatTimer);
            this.pipelineHeartbeatTimer = null;
        }
    }

    schedulePipelineReconnect() {
        if (!this.loggedIn || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectPipeline();
        }, 5000);
        this.reconnectTimer.unref?.();
    }

    startPipelineRecoveryLoop() {
        if (this.pipelineRecoveryTimer) return;
        this.pipelineRecoveryTimer = setInterval(() => {
            if (!this.loggedIn) return;
            if (!this.pipelineSocket || !this.websocketConnected) {
                this.connectPipeline().catch((err) => {
                    console.warn('Pipeline recovery failed:', err.message || err);
                });
            }
        }, 60000);
        this.pipelineRecoveryTimer.unref?.();
    }

    stopPipelineRecoveryLoop() {
        if (this.pipelineRecoveryTimer) {
            clearInterval(this.pipelineRecoveryTimer);
            this.pipelineRecoveryTimer = null;
        }
    }

    async handlePipelineMessage(raw) {
        try {
            this.websocketMessageCount++;
            if (this.lastPipelineMessage === raw) return;
            this.lastPipelineMessage = raw;
            const json = JSON.parse(raw);
            if (typeof json.content === 'string') {
                json.content = JSON.parse(json.content);
            }
            const receivedAt = new Date().toJSON();
            await this.persistPipelineEvent(json, receivedAt);
            const feedChanged = await this.applyPipelineEvent(json, receivedAt);
            this.augmentPipelineEvent(json);
            this.broadcast({ type: 'pipeline', event: json });
            if (feedChanged) {
                this.broadcast({ type: 'feed-refresh' });
            }
        } catch (err) {
            console.error('Failed to handle Pipeline event:', err);
        }
    }

    async persistPipelineEvent(event, createdAt = new Date().toJSON()) {
        const content = event.content || {};
        const userId = content.userId || content.user?.id || '';
        const data = JSON.stringify(event);
        await this.sqliteNonQuery(
            'INSERT OR IGNORE INTO headless_pipeline_events (created_at, type, user_id, data) VALUES (@created_at, @type, @user_id, @data)',
            {
                '@created_at': createdAt,
                '@type': event.type || '',
                '@user_id': userId,
                '@data': data
            }
        );
    }

    async applyPipelineEvent(event, createdAt = new Date().toJSON()) {
        const content = event.content || {};
        switch (event.type) {
            case 'notification':
                await this.addNotification(content);
                break;
            case 'notification-v2':
                await this.addNotificationV2(content);
                break;
            case 'notification-v2-delete':
                for (const id of content.ids || []) {
                    await this.expireNotificationV2(id);
                }
                break;
            case 'notification-v2-update':
                await this.patchNotificationV2(content.id, content.updates || {});
                break;
            case 'see-notification':
            case 'hide-notification':
                await this.seeNotification(content);
                await this.seeNotificationV2(content);
                break;
            case 'response-notification':
                await this.seeNotification(content.notificationId);
                await this.seeNotificationV2(content.notificationId);
                break;
            case 'friend-add':
                if (content.user) {
                    const user = {
                        ...content.user,
                        id: content.userId || content.user.id
                    };
                    this.addCurrentUserFriend(user.id);
                    await this.recordFriendAdded(user);
                    return await this.mergeUser(user, { state: user.state || 'offline' });
                }
                break;
            case 'friend-delete':
                await this.recordFriendDeleted(content.userId);
                this.removeCurrentUserFriend(content.userId);
                this.friends.delete(content.userId);
                return true;
            case 'friend-online':
                return await this.mergeUser(
                    {
                        id: content.userId,
                        platform: content.platform,
                        state: 'online',
                        location: content.location,
                        worldId: content.worldId,
                        travelingToLocation: content.travelingToLocation,
                        ...(content.user || {})
                    },
                    { state: 'online' }
                );
            case 'friend-active':
                return await this.mergeUser(
                    {
                        id: content.userId,
                        platform: content.platform,
                        state: 'active',
                        location: 'offline',
                        worldId: 'offline',
                        instanceId: 'offline',
                        travelingToLocation: 'offline',
                        ...(content.user || {})
                    },
                    { state: 'active' }
                );
            case 'friend-offline':
                return await this.mergeUser(
                    {
                        id: content.userId,
                        platform: content.platform,
                        state: 'offline',
                        location: 'offline',
                        worldId: 'offline',
                        instanceId: 'offline',
                        travelingToLocation: 'offline'
                    },
                    { state: 'offline' }
                );
            case 'friend-location':
                return await this.mergeUser(
                    {
                        id: content.userId,
                        location: content.location,
                        worldId: content.worldId,
                        travelingToLocation: content.travelingToLocation,
                        ...(content.user || {}),
                        state: 'online'
                    },
                    { state: 'online' }
                );
            case 'friend-update':
                if (content.user) {
                    await this.updateFriendLogForUser(content.user);
                    return await this.mergeUser(content.user);
                }
                break;
            case 'user-update':
                if (content.user) {
                    this.currentUser = {
                        ...(this.currentUser || {}),
                        ...content.user
                    };
                    await this.saveCredential(this.currentUser);
                }
                break;
            case 'user-location':
                if (content.userId === this.currentUser?.id) {
                    const gameLogChanged = await this.applyPipelineSelfLocation(
                        content,
                        createdAt
                    );
                    this.currentUser = {
                        ...this.currentUser,
                        location: content.location,
                        travelingToLocation: content.travelingToLocation
                    };
                    await this.saveCredential(this.currentUser);
                    if (gameLogChanged) {
                        this.broadcast({ type: 'game-log-refresh' });
                    }
                }
                break;
            default:
                break;
        }
        return false;
    }

    addCurrentUserFriend(userId) {
        if (!this.currentUser || !userId) return;
        const friends = new Set(Array.isArray(this.currentUser.friends) ? this.currentUser.friends : []);
        friends.add(userId);
        this.currentUser.friends = Array.from(friends);
    }

    removeCurrentUserFriend(userId) {
        if (!this.currentUser || !userId) return;
        const removeFrom = (field) => {
            if (Array.isArray(this.currentUser[field])) {
                this.currentUser[field] = this.currentUser[field].filter((id) => id !== userId);
            }
        };
        removeFrom('friends');
        removeFrom('onlineFriends');
        removeFrom('activeFriends');
        removeFrom('offlineFriends');
    }

    pipelineEventToFriendUser(event) {
        const content = event.content || {};
        switch (event.type) {
            case 'friend-add':
                if (!content.user) return null;
                return {
                    user: {
                        ...content.user,
                        id: content.userId || content.user.id
                    },
                    state: content.user.state || 'offline'
                };
            case 'friend-online':
                return {
                    user: {
                        id: content.userId,
                        platform: content.platform,
                        state: 'online',
                        location: content.location,
                        worldId: content.worldId,
                        instanceId: parseLocation(content.location).instanceId,
                        travelingToLocation: content.travelingToLocation,
                        travelingToWorld: parseLocation(content.travelingToLocation)
                            .worldId,
                        travelingToInstance: parseLocation(content.travelingToLocation)
                            .instanceId,
                        ...(content.user || {})
                    },
                    state: 'online'
                };
            case 'friend-active':
                return {
                    user: {
                        id: content.userId,
                        platform: content.platform,
                        state: 'active',
                        location: 'offline',
                        worldId: 'offline',
                        instanceId: 'offline',
                        travelingToLocation: 'offline',
                        travelingToWorld: 'offline',
                        travelingToInstance: 'offline',
                        ...(content.user || {})
                    },
                    state: 'active'
                };
            case 'friend-offline':
                return {
                    user: {
                        id: content.userId,
                        platform: content.platform,
                        state: 'offline',
                        location: 'offline',
                        worldId: 'offline',
                        instanceId: 'offline',
                        travelingToLocation: 'offline',
                        travelingToWorld: 'offline',
                        travelingToInstance: 'offline'
                    },
                    state: 'offline'
                };
            case 'friend-location':
                return {
                    user: {
                        id: content.userId,
                        location: content.location,
                        worldId: content.worldId,
                        instanceId: parseLocation(content.location).instanceId,
                        travelingToLocation: content.travelingToLocation,
                        travelingToWorld: parseLocation(content.travelingToLocation)
                            .worldId,
                        travelingToInstance: parseLocation(content.travelingToLocation)
                            .instanceId,
                        ...(content.user || {}),
                        state: 'online'
                    },
                    state: 'online'
                };
            case 'friend-update':
                if (!content.user) return null;
                return {
                    user: content.user,
                    state: content.user.state
                };
            default:
                return null;
        }
    }

    async backfillFeedFromPipelineEvents() {
        if (!this.currentUser?.id) return;
        const rows = await this.sqliteExecute(
            'SELECT created_at, data FROM headless_pipeline_events ORDER BY id ASC'
        );
        const replayFriends = new Map();
        for (const row of rows || []) {
            try {
                const createdAt = row[0] || new Date().toJSON();
                const event = parseMaybeJson(row[1]);
                if (!event || typeof event !== 'object') continue;
                if (typeof event.content === 'string') {
                    event.content = JSON.parse(event.content);
                }
                const normalized = this.pipelineEventToFriendUser(event);
                if (!normalized) {
                    if (event.type === 'friend-delete') {
                        replayFriends.delete(event.content?.userId);
                    }
                    continue;
                }
                const now = Date.parse(createdAt) || Date.now();
                const diff = this.mergeFriendRecord(replayFriends, normalized.user, {
                    state: normalized.state,
                    now
                });
                if (!diff) continue;
                await this.applyFeedDiff({
                    ...diff,
                    createdAt,
                    includePresence: false
                });
            } catch (err) {
                console.warn('Failed to replay Pipeline event:', err.message || err);
            }
        }
    }

    mergeFriendRecord(targetMap, user, { state = user.state, now = Date.now() } = {}) {
        if (!user?.id) return;
        const initialState = state || user.state || 'offline';
        const previousExisted = targetMap.has(user.id);
        const previous = targetMap.get(user.id) || {
            id: user.id,
            displayName: user.displayName || user.username || user.id,
            state: initialState,
            location: 'offline',
            locationAt: now,
            previousLocation: '',
            previousLocationAt: 0,
            travelingToTime: now,
            onlineFor: initialState === 'online' ? now : '',
            offlineFor: '',
            activeFor: initialState === 'active' ? now : '',
            status: '',
            statusDescription: '',
            bio: '',
            currentAvatarImageUrl: '',
            currentAvatarThumbnailImageUrl: '',
            currentAvatarTags: []
        };
        const incoming = {
            ...user,
            state: state || user.state || previous.state || 'offline'
        };
        const next = {
            ...previous,
            ...user,
            state: incoming.state
        };
        if (!next.displayName) {
            next.displayName = previous.displayName || user.username || user.id;
        }
        if (!next.location) {
            next.location = previous.location || 'offline';
        }
        const stateChanged = previous.state !== next.state;
        const locationChanged = previous.location !== next.location;
        if (stateChanged || !previousExisted) {
            if (next.state === 'online') {
                next.onlineFor = now;
                next.offlineFor = '';
                next.activeFor = '';
            } else if (next.state === 'active') {
                next.onlineFor = '';
                next.offlineFor = '';
                next.activeFor = now;
            } else if (stateChanged) {
                next.onlineFor = '';
                next.offlineFor = now;
                next.activeFor = '';
            } else {
                next.onlineFor = '';
                next.offlineFor = '';
                next.activeFor = '';
            }
        }
        if (locationChanged && next.location === 'traveling') {
            next.previousLocation =
                previous.location === 'traveling'
                    ? previous.previousLocation || ''
                    : previous.location || '';
            next.previousLocationAt =
                previous.location === 'traveling'
                    ? previous.previousLocationAt || previous.locationAt || now
                    : previous.locationAt || now;
            next.travelingToTime = now;
            next.locationAt = previous.locationAt || now;
        } else if (locationChanged) {
            next.locationAt = now;
            if (previous.location !== 'traveling') {
                next.previousLocation = '';
                next.previousLocationAt = 0;
            }
            next.travelingToTime = now;
        } else {
            next.locationAt = previous.locationAt || now;
        }
        targetMap.set(user.id, next);
        return {
            previous,
            next,
            incoming,
            previousExisted,
            stateChanged,
            locationChanged,
            now
        };
    }

    createGpsFeedEntry(previous, next, now, createdAt) {
        if (!next.location || next.location === 'offline' || next.location === 'traveling') {
            return null;
        }
        let previousLocation = previous.location || '';
        let time = now - (previous.locationAt || now);
        if (previous.location === 'traveling') {
            previousLocation = previous.previousLocation || '';
            if (previousLocation === next.location) return null;
            if (previous.previousLocationAt && previous.travelingToTime) {
                time = previous.travelingToTime - previous.previousLocationAt;
            } else {
                time -= now - (previous.travelingToTime || now);
            }
        }
        if (!previousLocation || previousLocation === 'offline') return null;
        if (previousLocation === next.location) return null;
        return {
            created_at: createdAt,
            userId: next.id,
            displayName: next.displayName || '',
            location: next.location,
            previousLocation,
            time: Math.max(0, time || 0)
        };
    }

    async applyFeedDiff({
        previous,
        next,
        incoming,
        previousExisted,
        stateChanged,
        locationChanged,
        now,
        createdAt = new Date(now).toJSON(),
        includePresence = true
    }) {
        if (!previousExisted || !this.currentUser?.id) return false;
        let feedChanged = false;

        if (includePresence && stateChanged) {
            feedChanged =
                (await this.persistPresenceTransition(previous, next)) || feedChanged;
        }

        if (!stateChanged && locationChanged) {
            const gpsEntry = this.createGpsFeedEntry(previous, next, now, createdAt);
            if (gpsEntry) {
                await this.addGpsFeed(gpsEntry);
                feedChanged = true;
            }
        }

        const statusChanged =
            hasOwn(incoming, 'status') && previous.status !== next.status;
        const statusDescriptionChanged =
            hasOwn(incoming, 'statusDescription') &&
            previous.statusDescription !== next.statusDescription;
        if (
            (statusChanged &&
                next.status !== 'offline' &&
                previous.status !== 'offline') ||
            (!statusChanged && statusDescriptionChanged)
        ) {
            await this.addStatusFeed({
                created_at: createdAt,
                userId: next.id,
                displayName: next.displayName || '',
                status: next.status || '',
                statusDescription: next.statusDescription || '',
                previousStatus: previous.status || '',
                previousStatusDescription: previous.statusDescription || ''
            });
            feedChanged = true;
        }

        if (hasOwn(incoming, 'bio') && previous.bio && next.bio && previous.bio !== next.bio) {
            await this.addBioFeed({
                created_at: createdAt,
                userId: next.id,
                displayName: next.displayName || '',
                bio: next.bio || '',
                previousBio: previous.bio || ''
            });
            feedChanged = true;
        }

        const avatarImageChanged =
            hasOwn(incoming, 'currentAvatarImageUrl') &&
            previous.currentAvatarImageUrl !== next.currentAvatarImageUrl;
        const avatarThumbnailChanged =
            hasOwn(incoming, 'currentAvatarThumbnailImageUrl') &&
            previous.currentAvatarThumbnailImageUrl !==
                next.currentAvatarThumbnailImageUrl;
        const avatarTagsChanged =
            hasOwn(incoming, 'currentAvatarTags') &&
            JSON.stringify(previous.currentAvatarTags || []) !==
                JSON.stringify(next.currentAvatarTags || []);
        if (
            (avatarImageChanged || avatarThumbnailChanged || avatarTagsChanged) &&
            !next.profilePicOverride &&
            (next.currentAvatarImageUrl || next.currentAvatarThumbnailImageUrl)
        ) {
            await this.addAvatarFeed({
                created_at: createdAt,
                userId: next.id,
                displayName: next.displayName || '',
                currentAvatarImageUrl: next.currentAvatarImageUrl || '',
                currentAvatarThumbnailImageUrl:
                    next.currentAvatarThumbnailImageUrl || '',
                previousCurrentAvatarImageUrl: previous.currentAvatarImageUrl || '',
                previousCurrentAvatarThumbnailImageUrl:
                    previous.currentAvatarThumbnailImageUrl || '',
                fallbackAvatarName: next.currentAvatar || ''
            });
            feedChanged = true;
        }
        return feedChanged;
    }

    async mergeUser(user, { state = user.state, persist = true } = {}) {
        const diff = this.mergeFriendRecord(this.friends, user, { state });
        if (!diff || !persist) return false;
        return await this.applyFeedDiff(diff);
    }

    apiEndpointFromUrl(value) {
        try {
            const requestUrl = new URL(value);
            const endpointUrl = new URL(this.endpointDomain);
            if (requestUrl.origin !== endpointUrl.origin) return '';
            const prefix = endpointUrl.pathname.replace(/\/$/, '');
            if (!requestUrl.pathname.startsWith(`${prefix}/`)) return '';
            return requestUrl.pathname.slice(prefix.length + 1);
        } catch {
            return '';
        }
    }

    sessionFieldsForUser(userId) {
        const ref = this.friends.get(userId);
        if (!ref) return {};
        return {
            state: ref.state || 'offline',
            $location_at: ref.locationAt || Date.now(),
            $travelingToTime: ref.travelingToTime || Date.now(),
            $online_for: ref.onlineFor || '',
            $offline_for: ref.offlineFor || '',
            $active_for: ref.activeFor || ''
        };
    }

    isKnownFriend(userId) {
        return (
            this.friends.has(userId) ||
            this.currentUser?.friends?.includes?.(userId) ||
            this.currentUser?.onlineFriends?.includes?.(userId) ||
            this.currentUser?.activeFriends?.includes?.(userId) ||
            this.currentUser?.offlineFriends?.includes?.(userId)
        );
    }

    applySessionFields(user, fallbackState = '') {
        if (!user?.id) return user;
        const knownState = this.friends.get(user.id)?.state;
        const state =
            fallbackState || user.state || knownState || this.stateForUserId(user.id);
        this.mergeFriendRecord(this.friends, user, { state });
        return {
            ...user,
            ...this.sessionFieldsForUser(user.id)
        };
    }

    currentUserWithSessionFriendLists(user) {
        const ids = new Set([...(Array.isArray(user.friends) ? user.friends : [])]);
        const onlineFriends = new Set(
            Array.isArray(user.onlineFriends) ? user.onlineFriends : []
        );
        const activeFriends = new Set(
            Array.isArray(user.activeFriends) ? user.activeFriends : []
        );
        const offlineFriends = new Set(
            Array.isArray(user.offlineFriends) ? user.offlineFriends : []
        );
        for (const [id, ref] of this.friends.entries()) {
            ids.add(id);
            onlineFriends.delete(id);
            activeFriends.delete(id);
            offlineFriends.delete(id);
            if (ref.state === 'online') {
                onlineFriends.add(id);
            } else if (ref.state === 'active') {
                activeFriends.add(id);
            } else {
                offlineFriends.add(id);
            }
        }
        return {
            ...user,
            friends: Array.from(ids),
            onlineFriends: Array.from(onlineFriends),
            activeFriends: Array.from(activeFriends),
            offlineFriends: Array.from(offlineFriends)
        };
    }

    augmentApiResponse(url, data) {
        const endpoint = this.apiEndpointFromUrl(url);
        if (!endpoint) return data;
        const payload = parseMaybeJson(data);
        if (!payload || typeof payload !== 'object') return data;
        try {
            if (endpoint === 'auth/user' && !Array.isArray(payload)) {
                return JSON.stringify(this.currentUserWithSessionFriendLists(payload));
            }
            if (endpoint === 'auth/user/friends' && Array.isArray(payload)) {
                const requestUrl = new URL(url);
                const offline = requestUrl.searchParams.get('offline') === 'true';
                return JSON.stringify(
                    payload.map((user) =>
                        this.applySessionFields(
                            user,
                            this.stateForUserId(user.id, offline ? 'offline' : user.state)
                        )
                    )
                );
            }
            const userMatch = endpoint.match(/^users\/(usr_[^/]+)$/);
            if (userMatch && !Array.isArray(payload)) {
                if (!this.isKnownFriend(payload.id)) {
                    return data;
                }
                return JSON.stringify(
                    this.applySessionFields(
                        payload,
                        payload.state || this.friends.get(payload.id)?.state || ''
                    )
                );
            }
        } catch (err) {
            console.warn('Failed to augment API response:', err.message || err);
        }
        return data;
    }

    augmentPipelineEvent(event) {
        const content = event.content || {};
        const userId = content.userId || content.user?.id;
        if (!userId) return;
        const fields = this.sessionFieldsForUser(userId);
        Object.assign(content, fields);
        if (content.user) {
            Object.assign(content.user, fields);
        }
    }

    async locationNames(location) {
        const parsed = parseLocation(location);
        const [worldName, groupName] = await Promise.all([
            this.getWorldName(parsed.worldId),
            this.getGroupName(parsed.groupId)
        ]);
        return { worldName, groupName };
    }

    async getWorldName(worldId) {
        if (!worldId) return '';
        if (this.worldNameCache.has(worldId)) return this.worldNameCache.get(worldId);
        try {
            const world = await this.vrchatRequest(`worlds/${worldId}`);
            const name = world?.name || '';
            this.worldNameCache.set(worldId, name);
            return name;
        } catch {
            this.worldNameCache.set(worldId, '');
            return '';
        }
    }

    async getGroupName(groupId) {
        if (!groupId) return '';
        if (this.groupNameCache.has(groupId)) return this.groupNameCache.get(groupId);
        try {
            const group = await this.vrchatRequest(`groups/${groupId}`);
            const name = group?.name || group?.shortCode || '';
            this.groupNameCache.set(groupId, name);
            return name;
        } catch {
            this.groupNameCache.set(groupId, '');
            return '';
        }
    }

    async persistPresenceTransition(previous, next) {
        const wasOnline = previous.state === 'online';
        const isOnline = next.state === 'online';
        if (!wasOnline && isOnline) {
            const { worldName, groupName } = await this.locationNames(next.location);
            await this.addOnlineOfflineFeed({
                type: 'Online',
                userId: next.id,
                displayName: next.displayName,
                location: next.location,
                worldName,
                groupName,
                time: ''
            });
            return true;
        } else if (wasOnline && !isOnline) {
            const { worldName, groupName } = await this.locationNames(previous.location);
            await this.addOnlineOfflineFeed({
                type: 'Offline',
                userId: next.id,
                displayName: next.displayName,
                location: previous.location,
                worldName,
                groupName,
                time: Date.now() - (previous.locationAt || Date.now())
            });
            return true;
        }
        return false;
    }

    async addOnlineOfflineFeed(entry) {
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT OR IGNORE INTO ${prefix}_feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (@created_at, @user_id, @display_name, @type, @location, @world_name, @time, @group_name)`,
            {
                '@created_at': new Date().toJSON(),
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@type': entry.type,
                '@location': entry.location || '',
                '@world_name': entry.worldName || '',
                '@time': entry.time || '',
                '@group_name': entry.groupName || ''
            }
        );
    }

    async addGpsFeed(entry) {
        const prefix = userPrefix(this.currentUser.id);
        const { worldName, groupName } = await this.locationNames(entry.location);
        await this.sqliteNonQuery(
            `INSERT INTO ${prefix}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name)
             SELECT @created_at, @user_id, @display_name, @location, @world_name, @previous_location, @time, @group_name
             WHERE NOT EXISTS (
                 SELECT 1 FROM ${prefix}_feed_gps
                 WHERE created_at = @created_at AND user_id = @user_id AND location = @location AND previous_location = @previous_location
             )`,
            {
                '@created_at': entry.created_at || new Date().toJSON(),
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@location': entry.location || '',
                '@world_name': worldName,
                '@previous_location': entry.previousLocation || '',
                '@time': entry.time || 0,
                '@group_name': groupName
            }
        );
    }

    async addStatusFeed(entry) {
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT INTO ${prefix}_feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description)
             SELECT @created_at, @user_id, @display_name, @status, @status_description, @previous_status, @previous_status_description
             WHERE NOT EXISTS (
                 SELECT 1 FROM ${prefix}_feed_status
                 WHERE created_at = @created_at AND user_id = @user_id AND status = @status AND status_description = @status_description
             )`,
            {
                '@created_at': entry.created_at || new Date().toJSON(),
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@status': entry.status || '',
                '@status_description': entry.statusDescription || '',
                '@previous_status': entry.previousStatus || '',
                '@previous_status_description': entry.previousStatusDescription || ''
            }
        );
    }

    async addBioFeed(entry) {
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT INTO ${prefix}_feed_bio (created_at, user_id, display_name, bio, previous_bio)
             SELECT @created_at, @user_id, @display_name, @bio, @previous_bio
             WHERE NOT EXISTS (
                 SELECT 1 FROM ${prefix}_feed_bio
                 WHERE created_at = @created_at AND user_id = @user_id AND bio = @bio
             )`,
            {
                '@created_at': entry.created_at || new Date().toJSON(),
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@bio': entry.bio || '',
                '@previous_bio': entry.previousBio || ''
            }
        );
    }

    async getAvatarInfo(imageUrl, fallbackAvatarName = '') {
        const fileId = extractFileId(imageUrl);
        if (!fileId) {
            return {
                ownerId: '',
                avatarName: fallbackAvatarName || '-'
            };
        }
        if (this.avatarNameCache.has(fileId)) {
            return this.avatarNameCache.get(fileId);
        }
        try {
            const file = await this.vrchatRequest(`file/${fileId}`);
            const info = {
                ownerId: file?.ownerId || '',
                avatarName: parseAvatarName(file) || fallbackAvatarName || '-'
            };
            this.avatarNameCache.set(fileId, info);
            return info;
        } catch (err) {
            const info = {
                ownerId: '',
                avatarName: fallbackAvatarName || '-'
            };
            this.avatarNameCache.set(fileId, info);
            return info;
        }
    }

    async addAvatarFeed(entry) {
        const prefix = userPrefix(this.currentUser.id);
        const avatarInfo = await this.getAvatarInfo(
            entry.currentAvatarImageUrl || entry.currentAvatarThumbnailImageUrl,
            entry.fallbackAvatarName || ''
        );
        await this.sqliteNonQuery(
            `INSERT INTO ${prefix}_feed_avatar (created_at, user_id, display_name, owner_id, avatar_name, current_avatar_image_url, current_avatar_thumbnail_image_url, previous_current_avatar_image_url, previous_current_avatar_thumbnail_image_url)
             SELECT @created_at, @user_id, @display_name, @owner_id, @avatar_name, @current_avatar_image_url, @current_avatar_thumbnail_image_url, @previous_current_avatar_image_url, @previous_current_avatar_thumbnail_image_url
             WHERE NOT EXISTS (
                 SELECT 1 FROM ${prefix}_feed_avatar
                 WHERE created_at = @created_at AND user_id = @user_id AND current_avatar_image_url = @current_avatar_image_url
             )`,
            {
                '@created_at': entry.created_at || new Date().toJSON(),
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@owner_id': avatarInfo.ownerId || '',
                '@avatar_name': avatarInfo.avatarName || '',
                '@current_avatar_image_url': entry.currentAvatarImageUrl || '',
                '@current_avatar_thumbnail_image_url':
                    entry.currentAvatarThumbnailImageUrl || '',
                '@previous_current_avatar_image_url':
                    entry.previousCurrentAvatarImageUrl || '',
                '@previous_current_avatar_thumbnail_image_url':
                    entry.previousCurrentAvatarThumbnailImageUrl || ''
            }
        );
    }

    async getFriendLogCurrentMap() {
        const map = new Map();
        if (!this.currentUser?.id) return map;
        const prefix = userPrefix(this.currentUser.id);
        const rows = await this.sqliteExecute(
            `SELECT user_id, display_name, trust_level, friend_number FROM ${prefix}_friend_log_current`
        );
        for (const row of rows || []) {
            map.set(row[0], {
                userId: row[0],
                displayName: row[1] || '',
                rawTrustLevel: row[2] || '',
                trustLevel: normalizeTrustLevel(row[2]),
                friendNumber: Number(row[3]) || 0
            });
        }
        return map;
    }

    async setFriendLogCurrent(entry) {
        if (!this.currentUser?.id || !entry?.userId) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT OR REPLACE INTO ${prefix}_friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (@user_id, @display_name, @trust_level, @friend_number)`,
            {
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@trust_level': normalizeTrustLevel(entry.trustLevel),
                '@friend_number': Number(entry.friendNumber) || 0
            }
        );
    }

    async deleteFriendLogCurrent(userId) {
        if (!this.currentUser?.id || !userId) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `DELETE FROM ${prefix}_friend_log_current WHERE user_id = @user_id`,
            {
                '@user_id': userId
            }
        );
    }

    async addFriendLogHistory(entry) {
        if (!this.currentUser?.id || !entry?.userId || !entry?.type) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT INTO ${prefix}_friend_log_history (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES (@created_at, @type, @user_id, @display_name, @previous_display_name, @trust_level, @previous_trust_level, @friend_number)`,
            {
                '@created_at': entry.created_at || new Date().toJSON(),
                '@type': entry.type,
                '@user_id': entry.userId,
                '@display_name': entry.displayName || '',
                '@previous_display_name': entry.previousDisplayName || null,
                '@trust_level': entry.trustLevel
                    ? normalizeTrustLevel(entry.trustLevel)
                    : null,
                '@previous_trust_level': entry.previousTrustLevel
                    ? normalizeTrustLevel(entry.previousTrustLevel)
                    : null,
                '@friend_number': Number(entry.friendNumber) || null
            }
        );
    }

    friendLogEntryFromUser(user, friendNumber = 0) {
        return {
            userId: user.id,
            displayName: user.displayName || user.username || user.id,
            trustLevel: trustLevelFromTags(user.tags),
            friendNumber
        };
    }

    nextFriendNumber(existing, fallbackSize = 0) {
        let max = 0;
        for (const row of existing.values()) {
            max = Math.max(max, Number(row.friendNumber) || 0);
        }
        return max || fallbackSize;
    }

    async recordFriendAdded(user, { createdAt = new Date().toJSON() } = {}) {
        if (!this.currentUser?.id || !user?.id) return false;
        const existing = await this.getFriendLogCurrentMap();
        if (existing.has(user.id)) {
            await this.updateFriendLogForUser(user, { existing, createdAt });
            return false;
        }
        const entry = this.friendLogEntryFromUser(
            user,
            this.nextFriendNumber(existing, existing.size) + 1
        );
        await this.addFriendLogHistory({
            created_at: createdAt,
            type: 'Friend',
            userId: entry.userId,
            displayName: entry.displayName,
            friendNumber: entry.friendNumber
        });
        await this.setFriendLogCurrent(entry);
        return true;
    }

    async recordFriendDeleted(userId, { createdAt = new Date().toJSON() } = {}) {
        if (!this.currentUser?.id || !userId) return false;
        const existing = await this.getFriendLogCurrentMap();
        const previous = existing.get(userId);
        if (!previous) return false;
        await this.addFriendLogHistory({
            created_at: createdAt,
            type: 'Unfriend',
            userId,
            displayName: previous.displayName || userId,
            friendNumber: previous.friendNumber
        });
        await this.deleteFriendLogCurrent(userId);
        return true;
    }

    async updateFriendLogForUser(
        user,
        { existing = null, createdAt = new Date().toJSON() } = {}
    ) {
        if (!this.currentUser?.id || !user?.id) return false;
        const current = existing || (await this.getFriendLogCurrentMap());
        const previous = current.get(user.id);
        if (!previous) return false;
        const next = this.friendLogEntryFromUser(user, previous.friendNumber);
        let changed = false;
        if (previous.displayName && previous.displayName !== next.displayName) {
            await this.addFriendLogHistory({
                created_at: createdAt,
                type: 'DisplayName',
                userId: next.userId,
                displayName: next.displayName,
                previousDisplayName: previous.displayName,
                friendNumber: next.friendNumber
            });
            changed = true;
        }
        if (
            previous.trustLevel &&
            next.trustLevel &&
            normalizeTrustLevel(previous.trustLevel) !== normalizeTrustLevel(next.trustLevel)
        ) {
            await this.addFriendLogHistory({
                created_at: createdAt,
                type: 'TrustLevel',
                userId: next.userId,
                displayName: next.displayName,
                trustLevel: next.trustLevel,
                previousTrustLevel: previous.trustLevel,
                friendNumber: next.friendNumber
            });
            changed = true;
        }
        if (
            changed ||
            previous.displayName !== next.displayName ||
            previous.rawTrustLevel !== previous.trustLevel ||
            normalizeTrustLevel(previous.trustLevel) !== normalizeTrustLevel(next.trustLevel)
        ) {
            await this.setFriendLogCurrent(next);
        }
        return changed;
    }

    async reconcileFriendLogSnapshot(friends) {
        if (!this.currentUser?.id || !Array.isArray(friends) || !friends.length) {
            return false;
        }
        const userId = this.currentUser.id;
        const initialized =
            (await this.configGet(`friendLogInit_${userId}`, 'false')) === 'true';
        const existing = await this.getFriendLogCurrentMap();
        const seen = new Set();
        let changed = false;
        let nextNumber = this.nextFriendNumber(existing, existing.size);

        for (const friend of friends) {
            if (!friend?.id) continue;
            seen.add(friend.id);
            const previous = existing.get(friend.id);
            if (!previous) {
                const entry = this.friendLogEntryFromUser(friend, initialized ? ++nextNumber : 0);
                if (initialized) {
                    await this.addFriendLogHistory({
                        type: 'Friend',
                        userId: entry.userId,
                        displayName: entry.displayName,
                        friendNumber: entry.friendNumber
                    });
                    changed = true;
                }
                await this.setFriendLogCurrent(entry);
                continue;
            }
            changed =
                (await this.updateFriendLogForUser(friend, { existing })) || changed;
        }

        if (initialized) {
            for (const [userIdToDelete, previous] of existing.entries()) {
                if (seen.has(userIdToDelete) || userIdToDelete === userId) continue;
                await this.addFriendLogHistory({
                    type: 'Unfriend',
                    userId: userIdToDelete,
                    displayName: previous.displayName || userIdToDelete,
                    friendNumber: previous.friendNumber
                });
                await this.deleteFriendLogCurrent(userIdToDelete);
                changed = true;
            }
        }

        await this.configSet(`friendLogInit_${userId}`, 'true');
        return changed;
    }

    async addNotification(row) {
        if (!this.currentUser?.id || !row?.id) return;
        const prefix = userPrefix(this.currentUser.id);
        const details = row.details || {};
        await this.sqliteNonQuery(
            `INSERT OR IGNORE INTO ${prefix}_notifications (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired) VALUES (@id, @created_at, @type, @sender_user_id, @sender_username, @receiver_user_id, @message, @world_id, @world_name, @image_url, @invite_message, @request_message, @response_message, @expired)`,
            {
                '@id': row.id,
                '@created_at': row.created_at || row.createdAt || new Date().toJSON(),
                '@type': row.type || '',
                '@sender_user_id': row.senderUserId || '',
                '@sender_username': row.senderUsername || '',
                '@receiver_user_id': row.receiverUserId || '',
                '@message': row.message || '',
                '@world_id': details.worldId || '',
                '@world_name': details.worldName || '',
                '@image_url': details.imageUrl || row.imageUrl || '',
                '@invite_message': details.inviteMessage || '',
                '@request_message': details.requestMessage || '',
                '@response_message': details.responseMessage || '',
                '@expired': row.$isExpired ? 1 : 0
            }
        );
    }

    async seeNotification(id) {
        if (!this.currentUser?.id || !id) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `UPDATE ${prefix}_notifications SET expired = 1 WHERE id = @id`,
            {
                '@id': id
            }
        );
    }

    async addNotificationV2(entry) {
        if (!this.currentUser?.id || !entry?.id) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `INSERT OR REPLACE INTO ${prefix}_notifications_v2 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details) VALUES (@id, @created_at, @updated_at, @expires_at, @type, @link, @link_text, @message, @title, @image_url, @seen, @sender_user_id, @sender_username, @data, @responses, @details)`,
            {
                '@id': entry.id,
                '@created_at': entry.createdAt || new Date().toJSON(),
                '@updated_at': entry.updatedAt || '',
                '@expires_at': entry.expiresAt || '',
                '@type': entry.type || '',
                '@link': entry.link || '',
                '@link_text': entry.linkText || '',
                '@message': entry.message || '',
                '@title': entry.title || '',
                '@image_url': entry.imageUrl || '',
                '@seen': entry.seen ? 1 : 0,
                '@sender_user_id': entry.senderUserId || '',
                '@sender_username': entry.senderUsername || '',
                '@data': JSON.stringify(entry.data || {}),
                '@responses': JSON.stringify(entry.responses || []),
                '@details': JSON.stringify(entry.details || {})
            }
        );
    }

    async expireNotificationV2(id) {
        if (!this.currentUser?.id || !id) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `UPDATE ${prefix}_notifications_v2 SET expires_at = @expires_at, seen = 1 WHERE id = @id`,
            {
                '@id': id,
                '@expires_at': new Date().toJSON()
            }
        );
    }

    async seeNotificationV2(id) {
        if (!this.currentUser?.id || !id) return;
        const prefix = userPrefix(this.currentUser.id);
        await this.sqliteNonQuery(
            `UPDATE ${prefix}_notifications_v2 SET seen = 1 WHERE id = @id`,
            {
                '@id': id
            }
        );
    }

    async patchNotificationV2(id, updates) {
        if (!this.currentUser?.id || !id) return;
        const prefix = userPrefix(this.currentUser.id);
        const rows = await this.sqliteExecute(
            `SELECT data FROM ${prefix}_notifications_v2 WHERE id = @id`,
            {
                '@id': id
            }
        );
        const existing = parseMaybeJson(rows?.[0]?.[0]) || {};
        await this.sqliteNonQuery(
            `UPDATE ${prefix}_notifications_v2 SET updated_at = @updated_at, data = @data WHERE id = @id`,
            {
                '@id': id,
                '@updated_at': new Date().toJSON(),
                '@data': JSON.stringify({ ...existing, ...updates })
            }
        );
    }

    async getLogStreamToken() {
        if (this.logStreamToken) return this.logStreamToken;
        const existing = await this.configGet('logStreamToken', '');
        if (existing) {
            this.logStreamToken = existing;
            return existing;
        }
        const token = crypto.randomBytes(32).toString('base64url');
        await this.configSet('logStreamToken', token);
        this.logStreamToken = token;
        return token;
    }

    async isLogStreamAuthorized(req, body = null, url = null) {
        const token = await this.getLogStreamToken();
        const auth = String(req.headers.authorization || '');
        const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || '';
        const queryToken = url?.searchParams?.get('token') || '';
        const bodyToken = body?.token || '';
        return !!token && [bearer, queryToken, bodyToken].includes(token);
    }

    getLogStreamClient(machineId) {
        const key = String(machineId || 'default').trim() || 'default';
        if (!this.logStreamClients.has(key)) {
            this.logStreamClients.set(key, {
                machineId: key,
                connected: false,
                currentFile: '',
                fileOffset: 0,
                lastSeenAt: '',
                lastEventAt: '',
                acceptedCount: 0,
                duplicateCount: 0,
                failedCount: 0,
                lastError: '',
                currentLocation: '',
                currentLocationAt: 0,
                currentLocationCreatedAt: '',
                currentWorldName: '',
                destinationLocation: '',
                players: new Map()
            });
        }
        return this.logStreamClients.get(key);
    }

    async persistLogStreamClient(client) {
        await this.sqliteNonQuery(
            `INSERT OR REPLACE INTO headless_log_stream_clients
             (machine_id, last_seen_at, last_event_at, current_file, file_offset, connected, accepted_count, duplicate_count, failed_count, last_error)
             VALUES (@machine_id, @last_seen_at, @last_event_at, @current_file, @file_offset, @connected, @accepted_count, @duplicate_count, @failed_count, @last_error)`,
            {
                '@machine_id': client.machineId,
                '@last_seen_at': client.lastSeenAt || '',
                '@last_event_at': client.lastEventAt || '',
                '@current_file': client.currentFile || '',
                '@file_offset': client.fileOffset || 0,
                '@connected': client.connected ? 1 : 0,
                '@accepted_count': client.acceptedCount || 0,
                '@duplicate_count': client.duplicateCount || 0,
                '@failed_count': client.failedCount || 0,
                '@last_error': client.lastError || ''
            }
        );
    }

    async updateLogStreamClient(machineId, patch = {}) {
        const client = this.getLogStreamClient(machineId);
        Object.assign(client, patch);
        client.lastSeenAt = patch.lastSeenAt || new Date().toJSON();
        await this.persistLogStreamClient(client);
        this.broadcast({ type: 'state', state: this.state() });
        return client;
    }

    async handleLogStreamConnection(socket, req, url) {
        if (!(await this.isLogStreamAuthorized(req, null, url))) {
            socket.close(1008, 'Unauthorized');
            return;
        }

        let machineId = url.searchParams.get('machineId') || 'default';
        await this.updateLogStreamClient(machineId, { connected: true });

        socket.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString('utf8'));
                if (message.machineId) machineId = String(message.machineId);
                const client = this.getLogStreamClient(machineId);
                if (message.type === 'hello' || message.type === 'heartbeat') {
                    client.connected = true;
                    client.currentFile = message.currentFile || client.currentFile || '';
                    client.fileOffset = Number(message.fileOffset || client.fileOffset || 0);
                    client.lastSeenAt = new Date().toJSON();
                    client.lastError = '';
                    await this.persistLogStreamClient(client);
                    socket.send(
                        JSON.stringify({
                            type: 'hello-ack',
                            serverTime: new Date().toJSON()
                        })
                    );
                    this.broadcast({ type: 'state', state: this.state() });
                    return;
                }

                if (message.type === 'events') {
                    const result = await this.handleLogStreamEvents(
                        machineId,
                        Array.isArray(message.events) ? message.events : []
                    );
                    socket.send(
                        JSON.stringify({
                            type: 'ack',
                            batchId: message.batchId || '',
                            ...result
                        })
                    );
                    return;
                }
            } catch (err) {
                const client = this.getLogStreamClient(machineId);
                client.failedCount++;
                client.lastError = err.message || String(err);
                await this.persistLogStreamClient(client);
                socket.send(
                    JSON.stringify({
                        type: 'error',
                        error: client.lastError
                    })
                );
            }
        });

        socket.on('close', async () => {
            await this.updateLogStreamClient(machineId, { connected: false });
        });
    }

    async handleLogStreamEvents(machineId, events) {
        const client = this.getLogStreamClient(machineId);
        const checkpoints = {};
        let accepted = 0;
        let duplicate = 0;
        let failed = 0;
        let changed = false;

        for (const event of events) {
            try {
                const inserted = await this.persistLogStreamEvent(machineId, event);
                const fileName = event.file || event.fileName || '';
                const fileOffset = Number(event.offset || event.fileOffset || 0);
                if (fileName && fileOffset > (checkpoints[fileName] || 0)) {
                    checkpoints[fileName] = fileOffset;
                }
                client.currentFile = fileName || client.currentFile || '';
                client.fileOffset = Math.max(client.fileOffset || 0, fileOffset || 0);
                client.lastEventAt = event.loggedAt || event.dt || new Date().toJSON();
                if (!inserted) {
                    duplicate++;
                    continue;
                }
                accepted++;
                if (await this.applyLogStreamEvent(machineId, event)) {
                    changed = true;
                }
            } catch (err) {
                failed++;
                client.lastError = err.message || String(err);
                console.warn('Failed to ingest log stream event:', err.message || err);
            }
        }

        client.acceptedCount += accepted;
        client.duplicateCount += duplicate;
        client.failedCount += failed;
        client.connected = true;
        client.lastSeenAt = new Date().toJSON();
        await this.persistLogStreamClient(client);
        this.broadcast({ type: 'state', state: this.state() });
        if (changed) {
            this.broadcast({ type: 'game-log-refresh' });
        }
        return { accepted, duplicate, failed, checkpoints };
    }

    async persistLogStreamEvent(machineId, event) {
        const clientEventId =
            event.clientEventId ||
            event.id ||
            crypto
                .createHash('sha256')
                .update(
                    JSON.stringify([
                        machineId,
                        event.file || event.fileName || '',
                        event.offset || event.fileOffset || 0,
                        event.raw || event.rawLine || ''
                    ])
                )
                .digest('hex');
        const existing = await this.sqliteExecute(
            'SELECT client_event_id FROM headless_log_stream_events WHERE client_event_id = @client_event_id',
            {
                '@client_event_id': clientEventId
            }
        );
        if (existing.length) return false;

        const rawLog = Array.isArray(event.rawLog) ? event.rawLog : [];
        const eventType = event.parsed?.type || rawLog[2] || '';
        await this.sqliteNonQuery(
            `INSERT INTO headless_log_stream_events
             (client_event_id, received_at, machine_id, file_name, file_offset, logged_at, event_type, raw_line, data)
             VALUES (@client_event_id, @received_at, @machine_id, @file_name, @file_offset, @logged_at, @event_type, @raw_line, @data)`,
            {
                '@client_event_id': clientEventId,
                '@received_at': new Date().toJSON(),
                '@machine_id': machineId,
                '@file_name': event.file || event.fileName || '',
                '@file_offset': Number(event.offset || event.fileOffset || 0),
                '@logged_at': event.loggedAt || event.dt || '',
                '@event_type': eventType,
                '@raw_line': event.raw || event.rawLine || '',
                '@data': JSON.stringify({ ...event, clientEventId })
            }
        );
        return true;
    }

    // Raw source tables stay source-specific. gamelog_* is the normalized UI
    // activity layer, so self instance boundaries share one writer for de-dupe.
    selfDisplayName() {
        const userId = this.currentUser?.id || '';
        return this.currentUser?.displayName || this.currentUser?.username || userId;
    }

    async findNearbyLocationSegment(createdAt, location, windowSeconds = 30) {
        const rows = await this.sqliteExecute(
            `SELECT created_at, time
             FROM gamelog_location
             WHERE location = @location
               AND ABS((julianday(created_at) - julianday(@created_at)) * 86400.0) <= @window_seconds
             ORDER BY ABS((julianday(created_at) - julianday(@created_at)) * 86400.0) ASC
             LIMIT 1`,
            {
                '@created_at': createdAt,
                '@location': location,
                '@window_seconds': windowSeconds
            }
        );
        return rows[0] || null;
    }

    async findNearbySelfJoinLeave(type, createdAt, location, windowSeconds = 30) {
        if (!this.currentUser?.id) return null;
        const rows = await this.sqliteExecute(
            `SELECT id, created_at, time
             FROM gamelog_join_leave
             WHERE user_id = @user_id
               AND type = @type
               AND location = @location
               AND ABS((julianday(created_at) - julianday(@created_at)) * 86400.0) <= @window_seconds
             ORDER BY ABS((julianday(created_at) - julianday(@created_at)) * 86400.0) ASC
             LIMIT 1`,
            {
                '@user_id': this.currentUser.id,
                '@type': type,
                '@created_at': createdAt,
                '@location': location,
                '@window_seconds': windowSeconds
            }
        );
        return rows[0] || null;
    }

    async recordSelfInstanceJoin({ createdAt, location, worldName = '' }) {
        if (!this.currentUser?.id || !isRealInstance(location)) return '';
        const existingSegment = await this.findNearbyLocationSegment(createdAt, location);
        const locationCreatedAt = existingSegment?.created_at || createdAt;
        if (!existingSegment) {
            const parsedLocation = parseLocation(location);
            const names = await this.locationNames(location);
            await this.sqliteNonQuery(
                'INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (@created_at, @location, @world_id, @world_name, @time, @group_name)',
                {
                    '@created_at': createdAt,
                    '@location': location,
                    '@world_id': parsedLocation.worldId,
                    '@world_name': worldName || names.worldName || '',
                    '@time': 0,
                    '@group_name': names.groupName || ''
                }
            );
        }

        const existingJoin = await this.findNearbySelfJoinLeave(
            'OnPlayerJoined',
            createdAt,
            location
        );
        if (!existingJoin) {
            await this.sqliteNonQuery(
                'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (@created_at, @type, @display_name, @location, @user_id, @time)',
                {
                    '@created_at': createdAt,
                    '@type': 'OnPlayerJoined',
                    '@display_name': this.selfDisplayName(),
                    '@location': location,
                    '@user_id': this.currentUser.id,
                    '@time': 0
                }
            );
        }
        return locationCreatedAt;
    }

    async recordSelfInstanceLeave({
        createdAt,
        location,
        locationCreatedAt = '',
        locationAt = 0,
        time = null
    }) {
        if (!this.currentUser?.id || !isRealInstance(location)) return false;
        const leaveTime = Date.parse(createdAt) || Date.now();
        const joinedAt =
            Date.parse(locationCreatedAt) || Number(locationAt || 0) || leaveTime;
        const duration = Math.max(
            0,
            Number.isFinite(time) && time !== null ? time : leaveTime - joinedAt
        );

        if (locationCreatedAt) {
            await this.sqliteNonQuery(
                `UPDATE gamelog_location
                 SET time = CASE WHEN time IS NULL OR time < @time THEN @time ELSE time END
                 WHERE created_at = @created_at AND location = @location`,
                {
                    '@created_at': locationCreatedAt,
                    '@location': location,
                    '@time': duration
                }
            );
        }

        const existingLeave = await this.findNearbySelfJoinLeave(
            'OnPlayerLeft',
            createdAt,
            location
        );
        if (existingLeave) return false;
        await this.sqliteNonQuery(
            'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (@created_at, @type, @display_name, @location, @user_id, @time)',
            {
                '@created_at': createdAt,
                '@type': 'OnPlayerLeft',
                '@display_name': this.selfDisplayName(),
                '@location': location,
                '@user_id': this.currentUser.id,
                '@time': duration
            }
        );
        return true;
    }

    async applyPipelineSelfLocation(content, createdAt) {
        const nextLocation = content.location || '';
        const current = this.pipelineSelfInstance;
        let changed = false;

        if (current.location && current.location !== nextLocation) {
            await this.recordSelfInstanceLeave({
                createdAt,
                location: current.location,
                locationCreatedAt: current.locationCreatedAt,
                locationAt: current.locationAt
            });
            changed = true;
        }

        if (isRealInstance(nextLocation)) {
            if (current.location !== nextLocation) {
                const locationCreatedAt = await this.recordSelfInstanceJoin({
                    createdAt,
                    location: nextLocation,
                    worldName: content.worldName || ''
                });
                this.pipelineSelfInstance = {
                    location: nextLocation,
                    locationAt:
                        Date.parse(locationCreatedAt) ||
                        Date.parse(createdAt) ||
                        Date.now(),
                    locationCreatedAt: locationCreatedAt || createdAt,
                    worldName: content.worldName || ''
                };
                changed = true;
            }
        } else if (current.location) {
            this.pipelineSelfInstance = {
                location: '',
                locationAt: 0,
                locationCreatedAt: '',
                worldName: ''
            };
        }

        return changed;
    }

    async applyLogStreamEvent(machineId, event) {
        const rawLog = Array.isArray(event.rawLog) ? event.rawLog : [];
        const parsed = event.parsed || {};
        const type = parsed.type || rawLog[2] || '';
        const args = Array.isArray(parsed.args) ? parsed.args : rawLog.slice(3);
        const createdAt = event.loggedAt || event.dt || rawLog[1] || new Date().toJSON();
        const client = this.getLogStreamClient(machineId);

        switch (type) {
            case 'location': {
                const location = args[0] || '';
                const worldName = args[1] || '';
                if (!location) return false;
                await this.closePreviousStreamLocation(client, createdAt);
                const locationCreatedAt = isRealInstance(location)
                    ? await this.addStreamSelfJoin(client, createdAt, location, worldName)
                    : createdAt;
                if (!isRealInstance(location)) {
                    const parsedLocation = parseLocation(location);
                    const { groupName } = await this.locationNames(location);
                    await this.sqliteNonQuery(
                        'INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (@created_at, @location, @world_id, @world_name, @time, @group_name)',
                        {
                            '@created_at': createdAt,
                            '@location': location,
                            '@world_id': parsedLocation.worldId,
                            '@world_name': worldName || '',
                            '@time': 0,
                            '@group_name': groupName || ''
                        }
                    );
                }
                client.currentLocation = location;
                client.currentWorldName = worldName || '';
                client.currentLocationCreatedAt = locationCreatedAt || createdAt;
                client.currentLocationAt =
                    Date.parse(client.currentLocationCreatedAt) ||
                    Date.parse(createdAt) ||
                    Date.now();
                client.players.clear();
                return true;
            }
            case 'location-destination':
                client.destinationLocation = args[0] || '';
                await this.closePreviousStreamLocation(client, createdAt);
                client.currentLocation = '';
                client.currentLocationAt = 0;
                client.currentLocationCreatedAt = '';
                client.currentWorldName = '';
                client.players.clear();
                return true;
            case 'player-joined':
                return await this.addStreamJoinLeave(client, createdAt, 'OnPlayerJoined', args);
            case 'player-left':
                return await this.addStreamJoinLeave(client, createdAt, 'OnPlayerLeft', args);
            case 'portal-spawn':
                await this.sqliteNonQuery(
                    'INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES (@created_at, @display_name, @location, @user_id, @instance_id, @world_name)',
                    {
                        '@created_at': createdAt,
                        '@display_name': '',
                        '@location': client.currentLocation || '',
                        '@user_id': '',
                        '@instance_id': '',
                        '@world_name': client.currentWorldName || ''
                    }
                );
                return true;
            case 'event':
                await this.sqliteNonQuery(
                    'INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (@created_at, @data)',
                    {
                        '@created_at': createdAt,
                        '@data': args[0] || event.raw || ''
                    }
                );
                return true;
            default:
                return false;
        }
    }

    async closePreviousStreamLocation(client, nextCreatedAt) {
        if (!client.currentLocation || !client.currentLocationAt) return;
        const nextTime = Date.parse(nextCreatedAt) || Date.now();
        const time = Math.max(0, nextTime - client.currentLocationAt);
        if (isRealInstance(client.currentLocation)) {
            await this.addStreamSelfLeft(client, nextCreatedAt, time);
        } else {
            await this.sqliteNonQuery(
                'UPDATE gamelog_location SET time = @time WHERE created_at = @created_at AND location = @location',
                {
                    '@created_at': client.currentLocationCreatedAt || nextCreatedAt,
                    '@location': client.currentLocation,
                    '@time': time
                }
            );
        }
    }

    async addStreamJoinLeave(client, createdAt, type, args) {
        const displayName = args[0] || '';
        const userId = args[1] || '';
        const key = userId || displayName;
        const now = Date.parse(createdAt) || Date.now();
        let time = 0;
        if (type === 'OnPlayerJoined') {
            client.players.set(key, {
                displayName,
                userId,
                joinTime: now
            });
            this.updateFriendSameInstanceTimer(userId, displayName, now, client.currentLocation);
        } else {
            const joined = client.players.get(key);
            if (joined?.joinTime) time = Math.max(0, now - joined.joinTime);
            client.players.delete(key);
        }
        await this.sqliteNonQuery(
            'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (@created_at, @type, @display_name, @location, @user_id, @time)',
            {
                '@created_at': createdAt,
                '@type': type,
                '@display_name': displayName,
                '@location': client.currentLocation || '',
                '@user_id': userId,
                '@time': time
            }
        );
        return true;
    }

    async addStreamSelfJoin(client, createdAt, location, worldName = '') {
        if (!this.currentUser?.id || !isRealInstance(location)) return createdAt;
        const key = this.currentUser.id;
        const locationCreatedAt = await this.recordSelfInstanceJoin({
            createdAt,
            location,
            worldName
        });
        const now = Date.parse(locationCreatedAt) || Date.parse(createdAt) || Date.now();
        client.players.set(key, {
            displayName: this.currentUser.displayName || this.currentUser.username || key,
            userId: key,
            joinTime: now
        });
        return locationCreatedAt || createdAt;
    }

    async addStreamSelfLeft(client, createdAt, time) {
        if (!this.currentUser?.id || !client.currentLocation) return;
        const key = this.currentUser.id;
        await this.recordSelfInstanceLeave({
            createdAt,
            location: client.currentLocation,
            locationCreatedAt: client.currentLocationCreatedAt,
            locationAt: client.currentLocationAt,
            time
        });
        client.players.delete(key);
    }

    updateFriendSameInstanceTimer(userId, displayName, joinedAt, location) {
        if (!userId || !location || !isRealInstance(location)) return;
        const previous = this.friends.get(userId);
        if (!previous) return;
        this.mergeFriendRecord(
            this.friends,
            {
                ...previous,
                id: userId,
                displayName: displayName || previous.displayName,
                state: 'online',
                location
            },
            {
                state: 'online',
                now: joinedAt
            }
        );
    }

    addSseClient(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('\n');
        const client = { res };
        this.clients.add(client);
        this.sendSse(client, { type: 'state', state: this.state() });
        const interval = setInterval(() => {
            this.sendSse(client, { type: 'ping', time: new Date().toJSON() });
        }, 25000);
        req.on('close', () => {
            clearInterval(interval);
            this.clients.delete(client);
        });
    }

    sendSse(client, payload) {
        try {
            client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
            this.clients.delete(client);
        }
    }

    broadcast(payload) {
        for (const client of this.clients) {
            this.sendSse(client, payload);
        }
    }
}

async function handleHeadlessRoute(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, { ok: true, state: session.state() });
        return true;
    }

    if (url.pathname === '/headless/events') {
        session.addSseClient(req, res);
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/headless/state') {
        jsonResponse(res, 200, session.state());
        return true;
    }

    if (
        req.method === 'GET' &&
        url.pathname === '/headless/session/current-user'
    ) {
        if (!session.loggedIn || !session.currentUser) {
            jsonResponse(res, 401, {
                error: { message: 'The backend is not logged in.' },
                state: session.state()
            });
        } else {
            jsonResponse(res, 200, session.currentUser);
        }
        return true;
    }

    if (!url.pathname.startsWith('/headless/')) return false;

    try {
        const body = await readJsonBody(req);

        if (req.method === 'POST' && url.pathname === '/headless/session/login') {
            jsonResponse(res, 200, await session.login(body));
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/session/logout') {
            await session.logout();
            jsonResponse(res, 200, { ok: true });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/session/recover') {
            await session.ensureAuthenticated();
            if (session.loggedIn && session.currentUser) {
                jsonResponse(res, 200, session.currentUser);
            } else {
                jsonResponse(res, 409, {
                    error: {
                        message:
                            session.authStateReason ||
                            (session.authState === 'awaiting_2fa'
                                ? 'Two-factor authentication is required.'
                                : 'No reusable VRChat session is available.')
                    },
                    state: session.state()
                });
            }
            return true;
        }
        const twoFactorMatch = url.pathname.match(
            /^\/headless\/session\/2fa\/([^/]+)$/
        );
        if (req.method === 'POST' && twoFactorMatch) {
            jsonResponse(
                res,
                200,
                await session.verifyTwoFactor(twoFactorMatch[1], body.code)
            );
            return true;
        }
        if (
            req.method === 'POST' &&
            url.pathname === '/headless/session/2fa/email/resend'
        ) {
            jsonResponse(res, 200, await session.resendEmailTwoFactor());
            return true;
        }
        if (
            req.method === 'POST' &&
            url.pathname === '/headless/session/reconnect-pipeline'
        ) {
            session.closePipeline();
            await session.connectPipeline();
            jsonResponse(res, 200, session.state());
            return true;
        }

        if (req.method === 'GET' && url.pathname === '/headless/log-stream/token') {
            if (process.env.VRCX_LOG_STREAM_ALLOW_TOKEN_READ === '0') {
                jsonResponse(res, 403, {
                    error: {
                        message:
                            'Token readback is disabled. Set VRCX_LOG_STREAM_TOKEN in the backend environment.'
                    }
                });
                return true;
            }
            jsonResponse(res, 200, {
                token: await session.getLogStreamToken()
            });
            return true;
        }
        if (
            req.method === 'POST' &&
            url.pathname === '/headless/log-stream/session'
        ) {
            if (!(await session.isLogStreamAuthorized(req, body, url))) {
                jsonResponse(res, 401, { error: { message: 'Unauthorized' } });
                return true;
            }
            const machineId = body.machineId || 'default';
            await session.updateLogStreamClient(machineId, {
                connected: false,
                currentFile: body.currentFile || '',
                fileOffset: Number(body.fileOffset || 0)
            });
            jsonResponse(res, 200, {
                ok: true,
                serverTime: new Date().toJSON(),
                machineId
            });
            return true;
        }

        if (req.method === 'POST' && url.pathname === '/headless/webapi/execute') {
            jsonResponse(res, 200, await session.webApiExecute(body.options || body));
            return true;
        }
        if (
            req.method === 'POST' &&
            url.pathname === '/headless/webapi/clearCookies'
        ) {
            jsonResponse(res, 409, {
                error: {
                    message:
                        'Cookie ownership belongs to the headless backend. Use the session login or logout endpoint.'
                }
            });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/webapi/getCookies') {
            jsonResponse(res, 200, {
                value: await session.getCookies()
            });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/webapi/setCookies') {
            jsonResponse(res, 409, {
                error: {
                    message:
                        'Cookie ownership belongs to the headless backend. Browser cookie restore is disabled.'
                }
            });
            return true;
        }

        if (req.method === 'POST' && url.pathname === '/headless/sqlite/execute') {
            jsonResponse(
                res,
                200,
                await session.sqliteExecute(body.sql, body.args || null)
            );
            return true;
        }
        if (
            req.method === 'POST' &&
            url.pathname === '/headless/sqlite/executeNonQuery'
        ) {
            jsonResponse(res, 200, {
                value: await session.sqliteNonQuery(body.sql, body.args || null)
            });
            return true;
        }

        if (req.method === 'POST' && url.pathname === '/headless/storage/get') {
            jsonResponse(res, 200, {
                value: await session.storageGet(body.key)
            });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/storage/set') {
            await session.storageSet(body.key, body.value);
            jsonResponse(res, 200, { ok: true });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/storage/remove') {
            jsonResponse(res, 200, {
                value: await session.call('VRCXStorage', 'Remove', [body.key])
            });
            return true;
        }
        if (req.method === 'POST' && url.pathname === '/headless/storage/getAll') {
            jsonResponse(res, 200, {
                value: await session.call('VRCXStorage', 'GetAll', [])
            });
            return true;
        }

        const dotnetMatch = url.pathname.match(
            /^\/headless\/dotnet\/([^/]+)\/([^/]+)$/
        );
        if (req.method === 'POST' && dotnetMatch) {
            jsonResponse(res, 200, {
                value: await session.call(dotnetMatch[1], dotnetMatch[2], body.args || [])
            });
            return true;
        }

        jsonResponse(res, 404, { error: 'Unknown headless route' });
        return true;
    } catch (err) {
        jsonResponse(res, err.status || 500, { error: safeError(err) });
        return true;
    }
}

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const candidate = path.normalize(path.join(staticDir, pathname));
    if (!candidate.startsWith(staticDir)) {
        textResponse(res, 403, 'Forbidden');
        return;
    }
    const filePath = fs.existsSync(candidate)
        ? candidate
        : path.join(staticDir, 'index.html');
    fs.readFile(filePath, (err, content) => {
        if (err) {
            textResponse(res, 404, 'Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Cache-Control':
                ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
        });
        res.end(content);
    });
}

async function bootstrap() {
    fs.mkdirSync(dataDir, { recursive: true });
    bridge = new DotNetBridge();
    const version = readVersion();
    const args = [`--config=${dataDir}`];
    bridge.getObject('ProgramElectron').PreInit(`VRCX ${version}`, args);
    bridge.getObject('VRCXStorage').Load();
    bridge.getObject('ProgramElectron').InitHeadless();
    bridge.getObject('SQLite').Init();
    bridge.getObject('AppApiElectron').Init();
    if (process.env.VRCX_ENABLE_LOG_WATCHER === '1') {
        try {
            bridge.getObject('LogWatcher').Init();
        } catch (err) {
            console.warn('LogWatcher disabled:', err.message || err);
        }
    }

    session = new HeadlessSession(bridge);
    await session.init({ restoreSession: false });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const handled = await handleHeadlessRoute(req, res, url);
        if (handled) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            textResponse(res, 405, 'Method not allowed');
            return;
        }
        serveStatic(req, res, url);
    });
    const logStreamServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== '/headless/log-stream/ws') {
            socket.destroy();
            return;
        }
        logStreamServer.handleUpgrade(req, socket, head, (ws) => {
            session.handleLogStreamConnection(ws, req, url).catch((err) => {
                console.warn('Failed to handle log stream connection:', err.message || err);
                ws.close(1011, 'Server error');
            });
        });
    });

    server.listen(port, host, () => {
        console.log(`VRCX headless backend listening on http://${host}:${port}`);
        console.log(`VRCX data directory: ${dataDir}`);
    });

    session.ensureAuthenticated().catch((err) => {
        console.warn('Background session restore failed:', err.message || err);
    });
    session.startAuthRecoveryLoop();
    session.startPipelineRecoveryLoop();

    const shutdown = async () => {
        try {
            session.stopAuthRecoveryLoop();
            session.stopPipelineRecoveryLoop();
            session.closePipeline();
            await bridge.getObject('VRCXStorage').Save();
            await bridge.getObject('SQLite').Exit();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

if (require.main === module) {
    bootstrap().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    CookieJar,
    HeadlessSession
};
