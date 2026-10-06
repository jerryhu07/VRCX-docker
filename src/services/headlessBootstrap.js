let request;

export function isHeadlessUiConfig(key) {
    return /^(vrcx_|friendloginit_|lastuserloggedin$|enableprimarypassword$)/i.test(key) &&
        !/(password|credential|cookie|token|apikey|secret)/i.test(key.replace(/^enableprimarypassword$/i, ''));
}

export function getHeadlessBootstrap() {
    if (!request) {
        request = fetch('/headless/bootstrap').then(async (response) => {
            if (!response.ok) throw new Error(`Bootstrap failed: HTTP ${response.status}`);
            return await response.json();
        }).catch((error) => { request = null; throw error; });
    }
    return request;
}

export function updateHeadlessConfig(event) {
    getHeadlessBootstrap().then((bootstrap) => {
        if (event.remove) delete bootstrap.config[event.key];
        else bootstrap.config[event.key] = event.value;
    }).catch((error) => console.error('Failed to update cached settings:', error));
}
