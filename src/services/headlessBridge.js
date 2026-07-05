const headlessBase = '';

function shouldUseHeadlessBridge() {
    if (typeof window === 'undefined') return false;
    if (window.interopApi || window.CefSharp) return false;
    return true;
}

async function postJson(path, body = {}) {
    const response = await fetch(`${headlessBase}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || response.statusText);
    }
    return payload;
}

function normalizeSqlArgs(args, sql = '') {
    const normalized = args instanceof Map ? Object.fromEntries(args.entries()) : args;
    if (!normalized) {
        return null;
    }
    for (const match of String(sql || '').matchAll(/@[\w]+/g)) {
        if (!Object.prototype.hasOwnProperty.call(normalized, match[0])) {
            normalized[match[0]] = null;
        }
    }
    for (const key of Object.keys(normalized)) {
        if (normalized[key] === undefined) {
            normalized[key] = null;
        }
    }
    return normalized;
}

function createDotNetProxy(className) {
    return new Proxy(
        {},
        {
            get(_, methodName) {
                if (typeof methodName !== 'string') return undefined;
                return async (...args) => {
                    const payload = await postJson(
                        `/headless/dotnet/${className}/${methodName}`,
                        { args }
                    );
                    return payload.value;
                };
            }
        }
    );
}

const appApiFallbacks = {
    ShowDevTools: () => {},
    SetVR: () => {},
    ExecuteVrOverlayFunction: () => {},
    FocusWindow: () => {},
    ChangeTheme: () => {},
    DoFunny: () => {},
    SetStartup: () => {},
    CopyImageToClipboard: () => {},
    FlashWindow: () => {},
    SetTrayIconNotification: () => {},
    RestartApplication: () => {},
    DesktopNotification: () => {},
    IPCAnnounceStart: () => {},
    SetUserAgent: () => {},
    SetZoom: () => {},
    GetZoom: async () => 1,
    GetClipboard: async () => '',
    GetLaunchCommand: async () => '',
    OpenLink: (url) => {
        if (typeof url === 'string' && /^https?:\/\//.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    },
    OpenDiscordProfile: () => {},
    OpenFolderSelectorDialog: async () => '',
    OpenFileSelectorDialog: async () => '',
    OpenFolderAndSelectItem: () => {},
    OpenShortcutFolder: () => {},
    OpenCalendarFile: () => {},
    CheckForUpdateExe: async () => false,
    CheckGameRunning: () => {},
    IsGameRunning: async () => false,
    IsSteamVRRunning: async () => false,
    QuitGame: async () => 0,
    StartGame: async () => false,
    StartGameFromPath: async () => false
};

function createAppApiBridge() {
    const proxy = createDotNetProxy('AppApiElectron');
    return new Proxy(
        {},
        {
            get(_, methodName) {
                if (typeof methodName !== 'string') return undefined;
                if (appApiFallbacks[methodName]) return appApiFallbacks[methodName];
                return proxy[methodName];
            }
        }
    );
}

function createWebApiBridge() {
    return {
        async ClearCookies() {
            await postJson('/headless/webapi/clearCookies');
        },
        async GetCookies() {
            const { value } = await postJson('/headless/webapi/getCookies');
            return value;
        },
        async SetCookies(cookies) {
            await postJson('/headless/webapi/setCookies', { cookies });
        },
        async ExecuteJson(optionsJson) {
            const options =
                typeof optionsJson === 'string'
                    ? JSON.parse(optionsJson)
                    : optionsJson;
            const result = await postJson('/headless/webapi/execute', {
                options
            });
            return JSON.stringify({
                status: result.status,
                message: result.data
            });
        },
        async Execute(options) {
            const result = await postJson('/headless/webapi/execute', {
                options
            });
            return {
                Item1: result.status,
                Item2: result.data
            };
        }
    };
}

function createSQLiteBridge() {
    return {
        async ExecuteJson(sql, args = null) {
            const rows = await postJson('/headless/sqlite/execute', {
                sql,
                args: normalizeSqlArgs(args, sql)
            });
            return JSON.stringify(rows);
        },
        async Execute(sql, args = null) {
            return await postJson('/headless/sqlite/execute', {
                sql,
                args: normalizeSqlArgs(args, sql)
            });
        },
        async ExecuteNonQuery(sql, args = null) {
            const { value } = await postJson('/headless/sqlite/executeNonQuery', {
                sql,
                args: normalizeSqlArgs(args, sql)
            });
            return value;
        }
    };
}

function createStorageBridge() {
    return {
        async Get(key) {
            const { value } = await postJson('/headless/storage/get', { key });
            return value || '';
        },
        async Set(key, value) {
            await postJson('/headless/storage/set', { key, value });
        },
        async Remove(key) {
            const { value } = await postJson('/headless/storage/remove', { key });
            return value;
        },
        async GetAll() {
            const { value } = await postJson('/headless/storage/getAll');
            return value || '{}';
        }
    };
}

function createLogWatcherBridge() {
    return {
        async Get() {
            return [];
        },
        async GetLogLines() {
            return [];
        },
        async SetDateTill() {},
        async Reset() {}
    };
}

function installElectronStub() {
    window.electron = {
        getArch: async () => 'x64',
        getClipboardText: async () => '',
        getNoUpdater: async () => true,
        setTrayIconNotification: async () => {},
        openFileDialog: async () => null,
        openDirectoryDialog: async () => null,
        onWindowPositionChanged: () => () => {},
        onWindowSizeChanged: () => () => {},
        onWindowStateChange: () => () => {},
        onBrowserFocus: () => () => {},
        desktopNotification: async () => {},
        restartApp: async () => {},
        getOverlayWindow: async () => false,
        updateVr: async () => {},
        ipcRenderer: {
            on: () => () => {}
        }
    };
}

export function installHeadlessBridge() {
    if (typeof window === 'undefined') {
        return false;
    }
    if (!shouldUseHeadlessBridge()) {
        window.__VRCX_HEADLESS__ = false;
        return false;
    }

    window.__VRCX_HEADLESS__ = true;
    installElectronStub();
    window.AppApi = createAppApiBridge();
    window.WebApi = createWebApiBridge();
    window.VRCXStorage = createStorageBridge();
    window.SQLite = createSQLiteBridge();
    window.LogWatcher = createLogWatcherBridge();
    window.Discord = createDotNetProxy('Discord');
    window.AssetBundleManager = createDotNetProxy('AssetBundleManager');
    window.AppApiVr = createDotNetProxy('AppApiVrElectron');
    window.AppApiVrElectron = window.AppApiVr;
    return true;
}

export function isHeadlessBridgeActive() {
    return typeof window !== 'undefined' && !!window.__VRCX_HEADLESS__;
}
