const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
    buildJsonDiff,
    buildMutualNetworkDiff,
    canonicalizeJson,
    canonicalizeWatchSnapshot,
    countMutualNetworkEdges,
    CookieJar,
    HeadlessSession,
    normalizeMutualNetworkSnapshot,
    normalizeWatchInterval,
    validateWatchUserId
} = require('./server');

test('mutual network snapshots normalize edges and record additions and removals', () => {
    const alice = 'usr_11111111-1111-1111-1111-111111111111';
    const bob = 'usr_22222222-2222-2222-2222-222222222222';
    const carol = 'usr_33333333-3333-3333-3333-333333333333';
    const before = { [alice]: [carol, bob, bob], [bob]: [alice] };
    const after = { [alice]: [carol], [carol]: [alice] };

    assert.deepEqual(normalizeMutualNetworkSnapshot(before), {
        [alice]: [bob, carol],
        [bob]: [alice]
    });
    assert.deepEqual(buildMutualNetworkDiff(before, after), {
        addedFriends: [carol],
        removedFriends: [bob],
        addedEdges: [{ friendId: carol, mutualId: alice }],
        removedEdges: [
            { friendId: alice, mutualId: bob },
            { friendId: bob, mutualId: alice }
        ]
    });
    assert.equal(countMutualNetworkEdges(before), 4);
});

test('mutual network diffs retain the hidden friend placeholder', () => {
    const alice = 'usr_11111111-1111-1111-1111-111111111111';
    const hidden = 'usr_00000000-0000-0000-0000-000000000000';
    const snapshot = { [alice]: [hidden] };

    assert.deepEqual(normalizeMutualNetworkSnapshot(snapshot), snapshot);
    assert.deepEqual(buildMutualNetworkDiff({ [alice]: [] }, snapshot), {
        addedFriends: [],
        removedFriends: [],
        addedEdges: [{ friendId: alice, mutualId: hidden }],
        removedEdges: []
    });
    assert.equal(countMutualNetworkEdges(snapshot), 1);
});

test('watch list JSON diffs retain field-level additions, removals, and replacements', () => {
    const previous = { bio: 'old', displayName: 'Alice', tags: ['a', 'b'] };
    const next = {
        bio: 'new',
        displayName: 'Alice',
        status: 'active',
        tags: ['a']
    };

    assert.deepEqual(buildJsonDiff(previous, next), [
        { op: 'replace', path: '$.bio', before: 'old', after: 'new' },
        { op: 'remove', path: '$.tags[1]', before: 'b' },
        { op: 'add', path: '$.status', after: 'active' }
    ]);
});

test('watch list canonicalization stabilizes object keys and interval limits', () => {
    assert.deepEqual(canonicalizeJson({ z: 1, a: { y: 2, b: 3 } }), {
        a: { b: 3, y: 2 },
        z: 1
    });
    assert.equal(normalizeWatchInterval(1000), 60 * 60 * 1000);
    assert.equal(
        normalizeWatchInterval(8 * 60 * 60 * 1000),
        8 * 60 * 60 * 1000
    );
    assert.throws(
        () => validateWatchUserId('not-a-user'),
        /valid VRChat user ID/
    );
    assert.equal(
        validateWatchUserId('usr_12345678-1234-1234-1234-123456789abc'),
        'usr_12345678-1234-1234-1234-123456789abc'
    );
});

test('watch list profile snapshots keep avatarName as the final JSON field', () => {
    const snapshot = canonicalizeWatchSnapshot(
        { z: 1, avatarName: 'Kipfel', a: 2 },
        'profile'
    );

    assert.deepEqual(snapshot, { a: 2, z: 1, avatarName: 'Kipfel' });
    assert.equal(Object.keys(snapshot).at(-1), 'avatarName');
    assert.equal(
        JSON.stringify(snapshot),
        '{"a":2,"z":1,"avatarName":"Kipfel"}'
    );
});

test('watch list profile fetch appends the parsed avatar name', async () => {
    const session = createSession();
    const profile = {
        id: 'usr_12345678-1234-1234-1234-123456789abc',
        displayName: 'Alice',
        currentAvatarImageUrl:
            'https://api.vrchat.cloud/api/1/file/file_avatar-image/1/file'
    };
    session.vrchatRequest = async (endpoint) => {
        if (endpoint.startsWith('users/')) return profile;
        assert.equal(endpoint, 'file/file_avatar-image');
        return { name: 'Avatar - Kipfel - Image - 2026' };
    };

    const snapshot = await session.fetchWatchProfile(profile.id);

    assert.equal(snapshot.avatarName, 'Kipfel');
    assert.equal(Object.keys(snapshot).at(-1), 'avatarName');
});

test('watch list mutual fetch paginates and sorts snapshots by user ID', async () => {
    const session = createSession();
    const calls = [];
    session.vrchatRequest = async (_endpoint, options) => {
        calls.push(options.params.offset);
        if (options.params.offset === 0) {
            return Array.from({ length: 100 }, (_, index) => ({
                id: `usr_${String(100 - index).padStart(36, '0')}`
            }));
        }
        return [{ id: `usr_${'0'.repeat(36)}`, displayName: 'First' }];
    };

    const mutuals = await session.fetchWatchMutualFriends(
        'usr_12345678-1234-1234-1234-123456789abc'
    );

    assert.deepEqual(calls, [0, 100]);
    assert.equal(mutuals.length, 101);
    assert.deepEqual(mutuals[0], { id: `usr_${'0'.repeat(36)}` });
});

test('mutual snapshots ignore metadata, duplicates and order but retain membership changes', async () => {
    const session = createSession();
    const before = [{ id: 'usr_a', status: 'online', avatar: 'old' }, { id: 'usr_b' }];
    session.sqliteNonQuery = async () => assert.fail('metadata created a history row');
    assert.equal(await session.recordWatchSnapshot('owner', 'user', 'mutuals', JSON.stringify(before),
        [{ id: 'usr_b', status: 'offline' }, { id: 'usr_a', avatar: 'new' }, { id: 'usr_a' }]), false);
    let saved;
    session.sqliteNonQuery = async (_sql, args) => { saved = args; };
    assert.equal(await session.recordWatchSnapshot('owner', 'user', 'mutuals', JSON.stringify(before),
        [{ id: 'usr_c', avatar: 'new' }, { id: 'usr_b' }]), true);
    assert.deepEqual(JSON.parse(saved['@snapshot_json']), [{ id: 'usr_b' }, { id: 'usr_c' }]);
    assert.deepEqual(JSON.parse(saved['@diff_json']), [
        { op: 'remove', path: '$.usr_a', before: { id: 'usr_a' } },
        { op: 'add', path: '$.usr_c', after: { id: 'usr_c' } }
    ]);
    await session.recordWatchSnapshot('owner', 'user', 'mutuals', JSON.stringify(before), []);
    assert.equal(JSON.parse(saved['@diff_json']).length, 2);
});

test('mutual history migration preserves membership history and removes metadata-only rows once', async () => {
    const session = createSession();
    let done = '';
    const writes = [];
    const snapshots = [[{ id: 'usr_a', avatar: 'old' }], [{ id: 'usr_a', avatar: 'new' }], []];
    session.configGet = async () => done;
    session.configSet = async (_key, value) => { done = value; };
    session.sqliteExecute = async (sql) => sql.includes('headless_watch_changes')
        ? snapshots.map((s, i) => [i + 1, 'owner', 'user', JSON.stringify(s)])
        : [['owner', 'user', JSON.stringify(snapshots[1])]];
    session.sqliteNonQuery = async (sql, args) => writes.push([sql, args]);
    await session.migrateWatchMutualHistory();
    assert.equal(writes[0][0], 'BEGIN');
    assert.equal(writes.at(-1)[0], 'COMMIT');
    const removed = writes.filter(([sql]) => sql.startsWith('DELETE'));
    assert.deepEqual(removed.map(([, args]) => args['@id']), [2]);
    const changes = writes.filter(([sql]) => sql.startsWith('UPDATE headless_watch_changes'));
    assert.deepEqual(JSON.parse(changes[0][1]['@snapshot']), [{ id: 'usr_a' }]);
    assert.deepEqual(JSON.parse(changes[1][1]['@diff']), [{ op: 'remove', path: '$.usr_a', before: { id: 'usr_a' } }]);
    const count = writes.length;
    await session.migrateWatchMutualHistory();
    assert.equal(writes.length, count);
});

test('invalid mutual payload is an error rather than an empty membership snapshot', async () => {
    const session = createSession();
    session.vrchatRequest = async () => ({ error: 'temporary failure' });
    await assert.rejects(session.fetchWatchMutualFriends('user'), /Invalid mutual friends response/);
});

test('watch list treats SQLite null placeholders as missing snapshots', async () => {
    const session = createSession();
    let insertedArgs;
    session.sqliteNonQuery = async (_sql, args) => {
        insertedArgs = args;
    };

    assert.equal(
        await session.recordWatchSnapshot(
            'usr_owner',
            'usr_target',
            'mutuals',
            {},
            []
        ),
        true
    );
    assert.equal(insertedArgs['@kind'], 'baseline');
    assert.deepEqual(JSON.parse(insertedArgs['@diff_json']), [
        { op: 'add', path: '$', after: [] }
    ]);
});

test('a successful empty mutual response is recorded as a full edge removal', async () => {
    const session = createSession();
    const friendId = 'usr_11111111-1111-1111-1111-111111111111';
    const mutualId = 'usr_22222222-2222-2222-2222-222222222222';
    session.loggedIn = true;
    session.currentUser = { id: 'usr_owner' };
    session.friends.set(friendId, { id: friendId });
    session.latestMutualNetworkSnapshot = async () => ({
        snapshot: { [friendId]: [mutualId] }
    });
    session.fetchWatchMutualFriends = async () => [];
    let persisted;
    session.persistMutualNetworkSnapshot = async (snapshot, options) => {
        persisted = { snapshot, options };
        return snapshot;
    };

    await session.fetchMutualNetwork();

    assert.deepEqual(persisted.snapshot, { [friendId]: [] });
    assert.deepEqual(persisted.options.failures, []);
});

function createSession() {
    const session = new HeadlessSession({});
    session.broadcast = () => {};
    session.persistPendingLogin = async () => {};
    session.cookieJar.save = async () => {};
    return session;
}

test('user requests combine upstream public profile fields and reject partial fetch failures', async (t) => {
    const session = createSession();
    const id = 'usr_11111111-1111-1111-1111-111111111111';
    const requested = [];
    let profileStatus = 200;
    t.mock.method(globalThis, 'fetch', async (url) => {
        const isProfile = url.includes('/profile/');
        requested.push(url);
        return new Response(JSON.stringify(isProfile
            ? (profileStatus === 200 ? { id, bio: '', bioLinks: ['https://example.com'], iconUrl: 'icon' }
                : { error: { message: 'Temporarily unavailable' } })
            : { id, displayName: 'Alice', location: 'private' }), {
            status: isProfile ? profileStatus : 200,
            headers: { 'content-type': 'application/json' }
        });
    });
    const user = await session.vrchatRequest(`users/${id}`);
    assert.equal(user.bio, '');
    assert.equal(user.location, 'private');
    assert.equal(user.iconUrl, 'icon');
    assert.deepEqual(user.bioLinks, ['https://example.com']);
    assert.equal(requested.length, 2);
    profileStatus = 503;
    await assert.rejects(session.fetchWatchProfile(id), { status: 503 });
});

test('old duplicate log events acknowledge progress without replacing latest activity', async () => {
    const session = createSession();
    session.persistLogStreamClient = async () => {};
    session.persistLogStreamEvent = async (_machineId, event) => event.id !== 'duplicate';
    session.applyLogStreamEvent = async () => false;
    const client = session.getLogStreamClient('test');
    client.currentFile = 'new.txt';
    client.lastEventAt = '2026-09-23T00:00:00.000Z';
    client.fileOffset = 123;
    const result = await session.handleLogStreamEvents('test', [{
        id: 'duplicate', file: 'old.txt', offset: 99999, loggedAt: '2026-08-01T00:00:00.000Z'
    }]);
    assert.equal(result.duplicate, 1);
    assert.equal(result.checkpoints['old.txt'], 99999);
    assert.equal(client.currentFile, 'new.txt');
    assert.equal(client.fileOffset, 123);
    await session.handleLogStreamEvents('test', [{
        id: 'new', file: 'newer.txt', offset: 20, loggedAt: '2026-09-23T00:01:00.000Z'
    }]);
    assert.equal(client.fileOffset, 20);
    assert.equal(client.currentFile, 'newer.txt');
});

test('log stream status restores the latest stored event rather than a replayed summary', async () => {
    const session = createSession();
    session.sqliteExecute = async (sql) => sql.includes('FROM headless_log_stream_clients')
        ? [['test', '', 10, 100, 0]]
        : sql.startsWith('SELECT data FROM headless_log_stream_events')
        ? [[JSON.stringify({ loggedAt: '2026-09-23T00:00:00.000Z', parsed: { type: 'location', args: ['wrld_test:1', 'World'] } })]]
        : [['new.txt', 42, '2026-09-23T00:00:00.000Z']];
    await session.restoreLogStreamClients();
    const client = session.getLogStreamClient('test');
    assert.equal(client.currentFile, 'new.txt');
    assert.equal(client.lastEventAt, '2026-09-23T00:00:00.000Z');
    assert.equal(client.acceptedCount, 10);
    assert.equal(client.currentLocation, 'wrld_test:1');
    assert.equal(client.connected, false);
});

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

    await assert.rejects(
        session.verifyTwoFactor('totp', '123456'),
        /Invalid code/
    );

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
        assert.equal(
            session.cookieJar.headerFor(url),
            'twoFactorAuth=trusted-device'
        );
        return { id: 'usr_me', displayName: 'Tester' };
    };

    assert.equal(await session.trySavedPasswordLogin(saved), true);
    assert.equal(session.authState, 'authenticated');
});

test('an authentication 401 cannot delete the trusted 2FA cookie', async () => {
    const session = createSession();
    const url = 'https://api.vrchat.cloud/api/1/auth/user';
    session.cookieJar.storeCookie(
        url,
        'auth=stale-auth; Path=/; Secure; HttpOnly'
    );
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
        new Response(
            JSON.stringify({ error: { message: 'Missing Credentials' } }),
            {
                status: 401,
                headers: {
                    'content-type': 'application/json',
                    'set-cookie':
                        'auth=; Path=/; Max-Age=0, twoFactorAuth=; Path=/; Max-Age=0'
                }
            }
        );

    try {
        await session.webApiExecute({ url, method: 'GET' });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(session.authState, 'recovering');
    assert.match(
        session.cookieJar.headerFor(url),
        /twoFactorAuth=trusted-device/
    );
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
        assert.equal(
            session.cookieJar.headerFor(url),
            'twoFactorAuth=trusted-device'
        );
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

test('concurrent recovery creates only one Pipeline socket', async () => {
    const session = createSession();
    session.loggedIn = true;
    session.authState = 'authenticated';
    let releaseAuth;
    session.vrchatRequest = async () =>
        await new Promise((resolve) => {
            releaseAuth = () => resolve({ ok: true, token: 'pipeline-token' });
        });
    const sockets = [];
    session.createPipelineSocket = () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        socket.terminate = () => {};
        sockets.push(socket);
        return socket;
    };

    const first = session.connectPipeline();
    const second = session.connectPipeline();
    await new Promise((resolve) => setImmediate(resolve));
    releaseAuth();
    await Promise.all([first, second]);

    assert.equal(sockets.length, 1);
    assert.equal(session.pipelineSocket, sockets[0]);
});

test('a stale Pipeline close cannot mark the active socket disconnected', async () => {
    const session = createSession();
    session.loggedIn = true;
    session.authState = 'authenticated';
    session.vrchatRequest = async () => ({ ok: true, token: 'pipeline-token' });
    const staleSocket = new EventEmitter();
    staleSocket.close = () => {};
    staleSocket.terminate = () => {};
    session.createPipelineSocket = () => staleSocket;
    await session.connectPipeline();

    const activeSocket = new EventEmitter();
    session.pipelineSocket = activeSocket;
    session.websocketConnected = true;
    staleSocket.emit('close', 1006, Buffer.alloc(0));

    assert.equal(session.pipelineSocket, activeSocket);
    assert.equal(session.websocketConnected, true);
});

test('Pipeline string content is retained when it is not JSON', async () => {
    const session = createSession();
    let persisted;
    session.persistPipelineEvent = async (event) => {
        persisted = event;
    };
    session.applyPipelineEvent = async () => false;
    session.augmentPipelineEvent = () => {};

    await session.handlePipelineMessage(
        JSON.stringify({
            type: 'notification-v2-delete',
            content: 'not_example'
        })
    );

    assert.equal(persisted.content, 'not_example');
});
