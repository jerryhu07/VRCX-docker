const assert = require('node:assert/strict');
const test = require('node:test');

const { CookieJar, HeadlessSession } = require('./server');

function createSession() {
    const session = new HeadlessSession({});
    session.broadcast = () => {};
    session.persistPendingLogin = async () => {};
    session.cookieJar.save = async () => {};
    return session;
}

test('a fresh login stops an old authenticated session before awaiting 2FA', async () => {
    const session = createSession();
    let pipelineClosed = false;
    session.loggedIn = true;
    session.authState = 'authenticated';
    session.currentUser = { id: 'usr_old' };
    session.closePipeline = () => {
        pipelineClosed = true;
        session.pipelineSocket = null;
        session.websocketConnected = false;
    };
    session.vrchatRequest = async (endpoint) => {
        if (endpoint === 'config') return {};
        return { requiresTwoFactorAuth: ['totp', 'otp'] };
    };

    const result = await session.login({
        username: 'user@example.com',
        password: 'secret',
        endpoint: '',
        websocket: ''
    });

    assert.equal(pipelineClosed, true);
    assert.equal(session.loggedIn, false);
    assert.equal(session.currentUser, null);
    assert.equal(session.authState, 'awaiting_2fa');
    assert.deepEqual(result.requiresTwoFactorAuth, ['totp', 'otp']);
    assert.equal(session.pendingLoginParams.username, 'user@example.com');
});

test('a rejected 2FA code preserves the pending login context for retry', async () => {
    const session = createSession();
    session.authState = 'awaiting_2fa';
    session.pendingTwoFactor = ['totp'];
    session.pendingLoginParams = {
        username: 'user@example.com',
        password: 'secret',
        endpoint: '',
        websocket: ''
    };
    session.vrchatRequest = async () => {
        const error = new Error('Invalid code');
        error.status = 401;
        throw error;
    };

    await assert.rejects(session.verifyTwoFactor('totp', '123456'), /Invalid code/);

    assert.equal(session.authState, 'awaiting_2fa');
    assert.equal(session.pendingLoginParams.password, 'secret');
    assert.deepEqual(session.pendingTwoFactor, ['totp']);
});

test('accepted cookies remain reusable until the server explicitly deletes them', () => {
    const jar = new CookieJar({});
    const url = 'https://api.vrchat.cloud/api/1/auth/user';

    jar.storeCookie(
        url,
        'auth=token; Path=/; Expires=Tue, 16 Jul 2030 00:00:00 GMT; Secure; HttpOnly'
    );
    assert.equal(jar.cookies.length, 1);
    assert.equal(jar.cookies[0].expires, 'Fri, 31 Dec 9999 23:59:59 GMT');
    assert.equal(jar.headerFor(url), 'auth=token');

    jar.storeCookie(url, 'auth=; Path=/; Max-Age=0; Secure; HttpOnly');
    assert.equal(jar.cookies.length, 0);
});

test('password recovery preserves the trusted 2FA cookie while clearing stale auth', async () => {
    const session = createSession();
    const url = 'https://api.vrchat.cloud/api/1/auth/user';
    const savedJar = new CookieJar({});
    savedJar.storeCookie(url, 'auth=stale-auth; Path=/; Secure; HttpOnly');
    savedJar.storeCookie(
        url,
        'twoFactorAuth=trusted-device; Path=/; Secure; HttpOnly'
    );
    const saved = {
        cookies: savedJar.exportBase64(),
        loginParams: {
            username: 'user@example.com',
            password: 'secret',
            endpoint: '',
            websocket: ''
        }
    };
    session.configGet = async (_key, fallback) => fallback;
    session.completeLogin = async (user) => {
        session.currentUser = user;
        session.loggedIn = true;
        session.authState = 'authenticated';
    };
    session.vrchatRequest = async (endpoint) => {
        if (endpoint === 'config') return {};
        assert.equal(session.cookieJar.headerFor(url), 'twoFactorAuth=trusted-device');
        return { id: 'usr_me', displayName: 'Tester' };
    };

    assert.equal(await session.trySavedPasswordLogin(saved), true);
    assert.equal(session.authState, 'authenticated');
});

test('an authentication 401 cannot delete the trusted 2FA cookie', async () => {
    const session = createSession();
    const url = 'https://api.vrchat.cloud/api/1/auth/user';
    session.cookieJar.storeCookie(url, 'auth=stale-auth; Path=/; Secure; HttpOnly');
    session.cookieJar.storeCookie(
        url,
        'twoFactorAuth=trusted-device; Path=/; Secure; HttpOnly'
    );
    session.loggedIn = true;
    session.authState = 'authenticated';
    session.currentUser = { id: 'usr_me' };
    session.markAuthenticationLost = async () => {
        session.loggedIn = false;
        session.authState = 'recovering';
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: 'Missing Credentials' } }), {
            status: 401,
            headers: {
                'content-type': 'application/json',
                'set-cookie':
                    'auth=; Path=/; Max-Age=0, twoFactorAuth=; Path=/; Max-Age=0'
            }
        });

    try {
        await session.webApiExecute({ url, method: 'GET' });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(session.authState, 'recovering');
    assert.match(session.cookieJar.headerFor(url), /twoFactorAuth=trusted-device/);
});

test('restoring saved cookies merges them with the active trusted session', async () => {
    const session = createSession();
    const url = 'https://api.vrchat.cloud/api/1/auth/user';
    session.cookieJar.storeCookie(
        url,
        'twoFactorAuth=trusted-device; Path=/; Secure; HttpOnly'
    );
    const savedJar = new CookieJar({});
    savedJar.storeCookie(url, 'auth=saved-auth; Path=/; Secure; HttpOnly');

    await session.setCookies(savedJar.exportBase64());

    const header = session.cookieJar.headerFor(url);
    assert.match(header, /auth=saved-auth/);
    assert.match(header, /twoFactorAuth=trusted-device/);
});

test('recovery mints a new auth session with saved credentials and trusted 2FA', async () => {
    const session = createSession();
    const url = 'https://api.vrchat.cloud/api/1/auth/user';
    const savedJar = new CookieJar({});
    savedJar.storeCookie(url, 'auth=expired-auth; Path=/; Secure; HttpOnly');
    savedJar.storeCookie(
        url,
        'twoFactorAuth=trusted-device; Path=/; Secure; HttpOnly'
    );
    const saved = {
        cookies: savedJar.exportBase64(),
        loginParams: {
            username: 'user@example.com',
            password: 'secret',
            endpoint: '',
            websocket: ''
        }
    };
    session.cookieJar.importBase64(saved.cookies);
    session.authState = 'recovering';
    session.configGet = async (key, fallback) => {
        if (key === 'lastUserLoggedIn') return 'usr_me';
        return fallback;
    };
    session.getSavedCredentials = async () => ({ usr_me: saved });
    session.loadPendingLogin = async () => false;
    session.completeLogin = async (user) => {
        session.currentUser = user;
        session.loggedIn = true;
        session.authState = 'authenticated';
    };
    let cookieRestoreAttempts = 0;
    session.vrchatRequest = async (endpoint, options = {}) => {
        if (endpoint === 'config') return {};
        if (!options.headers?.Authorization) {
            cookieRestoreAttempts++;
            throw new Error('Missing Credentials');
        }
        assert.equal(session.cookieJar.headerFor(url), 'twoFactorAuth=trusted-device');
        return { id: 'usr_me', displayName: 'Tester' };
    };

    assert.equal(await session.ensureAuthenticated(), true);
    assert.equal(cookieRestoreAttempts, 2);
    assert.equal(session.authState, 'authenticated');
    assert.equal(session.pendingTwoFactor.length, 0);
});

test('recovery rebuilds a missing last-user index from one saved account', async () => {
    const session = createSession();
    const saved = {
        user: { id: 'usr_me', displayName: 'Tester' },
        loginParams: {
            username: 'user@example.com',
            password: 'secret',
            endpoint: '',
            websocket: ''
        }
    };
    session.getSavedCredentials = async () => ({ usr_me: saved });
    session.configGet = async (_key, fallback) => fallback;
    const writes = [];
    session.configSet = async (key, value) => writes.push([key, value]);

    const selected = await session.getRecoveryCredential();

    assert.equal(selected.userId, 'usr_me');
    assert.equal(selected.saved, saved);
    assert.deepEqual(writes, [['lastUserLoggedIn', 'usr_me']]);
});

test('an explicit logout disables automatic credential recovery', async () => {
    const session = createSession();
    session.configRemove = async () => {};
    const writes = [];
    session.configSet = async (key, value) => writes.push([key, value]);

    await session.logout();

    assert.equal(session.autoRecoveryDisabled, true);
    assert.deepEqual(writes, [['headlessAutoRecoveryDisabled', 'true']]);
    assert.equal(await session.getRecoveryCredential(), null);
});

test('network failure keeps authentication recoverable for a later retry', async () => {
    const session = createSession();
    session.authState = 'recovering';
    session.configGet = async (_key, fallback) => fallback;
    session.vrchatRequest = async () => {
        throw new TypeError('fetch failed');
    };
    const saved = {
        loginParams: {
            username: 'user@example.com',
            password: 'secret',
            endpoint: '',
            websocket: ''
        }
    };

    assert.equal(await session.trySavedPasswordLogin(saved), false);
    assert.equal(session.authState, 'recovering');
    assert.match(session.authStateReason, /network unavailable/i);
});
