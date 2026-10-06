const test = require('node:test');
const assert = require('node:assert/strict');
const { HeadlessSession } = require('./server');
const { validateLogClientSettings } = require('./logClientSettings.cjs');

function sessionWithConfig(store) {
    const session = new HeadlessSession({});
    session.logStreamToken = 'environment-token';
    session.configGet = async (key, fallback) => store.get(key) ?? fallback;
    session.configSet = async (key, value) => store.set(key, value);
    session.broadcast = () => {};
    return session;
}

test('custom settings survive restart and are included in exported configs without replacing the secret', async () => {
    const store = new Map();
    const session = sessionWithConfig(store);
    const settings = { server: 'https://example.com/vrcx', machineId: 'my-pc', logDir: 'C:\\logs', stateFile: 'C:\\state.json',
        historyMode: 'backfill', historyMaxDays: 30, historyMaxFiles: 0, pollMs: 500, singleInstance: false };
    await session.saveLogClientSettings(settings);
    const restored = sessionWithConfig(store);
    const config = await restored.logClientConfig('http://default');
    for (const [key, value] of Object.entries(settings)) assert.equal(config[key], value);
    assert.equal(config.token, 'environment-token');
    assert.equal(config.launchVrchat, false);
    assert.equal(config.batchSize, 100);
    await assert.rejects(session.saveLogClientSettings({ token: 'custom-secret' }), /Invalid/);
});

test('settings reject unknown fields, unsafe destinations and invalid numeric or boolean values', () => {
    for (const settings of [null, [], { pollMs: 0 }, { pollMs: '500' }, { historyMaxFiles: -1 },
        { server: 'file:///tmp' }, { server: 'http://user:secret@host' }, { server: 'http://host?token=secret' },
        { machineId: '../path' }, { stateFile: 'file\nname' }, { singleInstance: 'false' },
        JSON.parse('{"__proto__": "x"}')]) {
        assert.throws(() => validateLogClientSettings(settings), { status: 400 });
    }
    assert.deepEqual(validateLogClientSettings({ historyMaxFiles: 0, historyMaxDays: 0, exitWithVrchat: false }),
        { historyMaxFiles: 0, historyMaxDays: 0, exitWithVrchat: false });
});

test('defaults use account identity and backfill and ignore saved overrides without writing or rotating', async () => {
    const store = new Map([['logStreamClientSettings', JSON.stringify({ machineId: 'custom', historyMode: 'skip', pollMs: 500 })]]);
    const session = sessionWithConfig(store);
    session.currentUser = { id: 'usr_me' };
    const original = await session.logClientConfig('https://browser.example', true);
    assert.equal(original.machineId, 'streamer_usr_me');
    assert.equal(original.server, 'https://browser.example');
    assert.equal(original.historyMode, 'backfill');
    assert.equal(original.pollMs, 1000);
    assert.equal(original.token, 'environment-token');
    const current = await session.logClientConfig('https://browser.example');
    assert.equal(current.machineId, 'custom');
    assert.equal(current.historyMode, 'skip');
    assert.equal(store.size, 1);
});

test('rotation revokes sockets and bearer tokens and overrides environment tokens after restart', async () => {
    const store = new Map();
    const session = sessionWithConfig(store);
    let closed = 0;
    const client = session.getLogStreamClient('pc');
    client.connected = true;
    client.sockets.add({ close: (code) => { assert.equal(code, 1008); closed++; }, terminate: () => {} });
    const cookies = session.cookieJar;
    const token = await session.rotateLogStreamToken();
    assert.notEqual(token, 'environment-token');
    assert.equal(closed, 1);
    assert.equal(client.connected, false);
    assert.equal(session.cookieJar, cookies);
    assert.equal(await session.isLogStreamAuthorized({ headers: { authorization: 'Bearer environment-token' } }), false);
    const restored = sessionWithConfig(store);
    assert.equal(await restored.getLogStreamToken(), token);
    assert.equal(await restored.isLogStreamAuthorized({ headers: { authorization: `Bearer ${token}` } }), true);
});

test('failed persistence does not revoke the active secret or sockets', async () => {
    const session = sessionWithConfig(new Map());
    session.configSet = async () => { throw new Error('disk failure'); };
    session.getLogStreamClient('pc').sockets.add({ close: () => assert.fail('socket revoked before persistence') });
    await assert.rejects(session.rotateLogStreamToken(), /disk failure/);
    assert.equal(await session.getLogStreamToken(), 'environment-token');
    assert.equal(session.logStreamAuthGeneration, 0);
});
