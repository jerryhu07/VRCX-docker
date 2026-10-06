const assert = require('node:assert/strict');

const test = require('node:test');

const { DatabaseSync } = require('node:sqlite');

const { HeadlessSession } = require('./server');

const { EventEmitter } = require('node:events');

async function setup(t, db = new DatabaseSync(':memory:')) {
    const session = new HeadlessSession({});
    session.currentUser = { id: 'usr_me' };
    session.loggedIn = true;
    session.broadcast = () => {};
    session.sqliteExecute = async (sql, args) => {
        const stmt = db.prepare(sql);
        return (args ? stmt.all(args) : stmt.all()).map(Object.values);
    };
    session.sqliteNonQuery = async (sql, args) => {
        const stmt = db.prepare(sql);
        return (args ? stmt.run(args) : stmt.run()).changes;
    };
    await session.initUserTables('usr_me');
    session.friends.set('usr_alice', { id: 'usr_alice', displayName: 'Alice' });
    t.after(() => db.close());
    return { session, db };
}

test('existing bio records survive the idempotent links schema upgrade', async (t) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE usrme_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT,
        display_name TEXT, bio TEXT, previous_bio TEXT);
        INSERT INTO usrme_feed_bio VALUES (1,'2026-01-01','usr_alice','Alice','existing','old');`);
    const { session } = await setup(t, db);
    await session.initUserTables('usr_me');
    const rows = db.prepare('SELECT * FROM usrme_feed_bio').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bio, 'existing');
    assert.equal(rows[0].bio_links, '[]');
    assert.equal(rows[0].previous_bio_links, '[]');
});

test('persistent bio cache records clearing, links-only changes and deduplicates concurrent observations', async (t) => {
    const { session, db } = await setup(t);
    const profile = { id: 'usr_alice', displayName: 'Alice', bio: 'old', bioLinks: ['https://old.example'] };
    await session.recordPublicProfile(profile, { fetched: true });
    assert.equal(db.prepare('SELECT count(*) n FROM usrme_feed_bio').get().n, 0);
    const cleared = { ...profile, bio: '' };
    await Promise.all([session.recordPublicProfile(cleared), session.recordPublicProfile(cleared)]);
    const next = { ...cleared, bioLinks: [] };
    await session.recordPublicProfile(next);
    const rows = db.prepare('SELECT * FROM usrme_feed_bio ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].previous_bio, 'old');
    assert.equal(rows[0].bio, '');
    assert.deepEqual(JSON.parse(rows[1].previous_bio_links), ['https://old.example']);
    assert.deepEqual(JSON.parse(rows[1].bio_links), []);
    const restarted = new HeadlessSession({});
    Object.assign(restarted, { currentUser: session.currentUser, friends: session.friends,
        sqliteExecute: session.sqliteExecute, sqliteNonQuery: session.sqliteNonQuery, broadcast: () => {} });
    await restarted.recordPublicProfile(next);
    assert.equal(db.prepare('SELECT count(*) n FROM usrme_feed_bio').get().n, 2);
    await restarted.recordPublicProfile({ id: profile.id, iconUrl: '' });
    assert.equal((await restarted.getCachedProfile(profile.id)).profile.bio, '');
});

test('avatar feed distinguishes icons from avatar banners and avoids duplicate representations', async (t) => {
    const { session, db } = await setup(t);
    const image = (id) => `https://api.vrchat.cloud/api/1/file/file_${id}/1/file`;
    session.vrchatRequest = async (endpoint) => endpoint === 'file/file_icon'
        ? { tags: ['icon'], ownerId: 'usr_creator', name: 'Avatar - Icon - Image - 1' }
        : { tags: [], ownerId: 'usr_creator', name: 'Avatar - Model - Image - 1' };
    await session.recordPublicProfile({ id: 'usr_alice', iconUrl: image('a'), bannerType: 'color', bannerUrl: '' });
    await session.recordPublicProfile({ id: 'usr_alice', iconUrl: image('icon') });
    assert.equal(db.prepare('SELECT count(*) n FROM usrme_feed_avatar').get().n, 0);
    await session.recordPublicProfile({ id: 'usr_alice', iconUrl: image('b'), bannerType: 'avatarBanner', bannerUrl: image('b') });
    const rows = db.prepare('SELECT * FROM usrme_feed_avatar').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].avatar_name, 'Model');
    await session.recordPublicProfile({ id: 'usr_alice', bannerType: 'customImage', bannerUrl: image('c') });
    assert.equal(db.prepare('SELECT count(*) n FROM usrme_feed_avatar').get().n, 1);
});

test('temporary avatar lookup failures preserve the baseline and retry without negative caching', async (t) => {
    const { session, db } = await setup(t);
    const old = 'https://api.vrchat.cloud/api/1/file/file_old/1/file';
    const next = 'https://api.vrchat.cloud/api/1/file/file_new/1/file';
    await session.recordPublicProfile({ id: 'usr_alice', iconUrl: old });
    session.vrchatRequest = async () => { throw new Error('network'); };
    await assert.rejects(session.recordPublicProfile({ id: 'usr_alice', iconUrl: next }), /temporarily unavailable/);
    assert.equal((await session.getCachedProfile('usr_alice')).profile.iconUrl, old);
    session.vrchatRequest = async () => ({ ownerId: 'usr_creator', name: 'Avatar - Model - Image - 1' });
    await session.recordPublicProfile({ id: 'usr_alice', iconUrl: next });
    assert.equal(db.prepare('SELECT count(*) n FROM usrme_feed_avatar').get().n, 1);
});

test('profile refresh runs without browsers and skips fresh profiles and recent failed attempts', async (t) => {
    const { session } = await setup(t);
    await session.recordPublicProfile({ id: 'usr_alice', bio: 'cached' }, { fetched: true });
    session.friends.set('usr_stale', { id: 'usr_stale' });
    const calls = [];
    session.fetchPublicProfile = async (id) => { calls.push(id); throw new Error('network'); };
    await session.refreshStaleProfiles();
    await session.refreshStaleProfiles();
    assert.deepEqual(calls, ['usr_stale']);
});

test('friend list responses include cached public data while keeping current presence authoritative', async (t) => {
    const { session } = await setup(t);
    await session.recordPublicProfile({ id: 'usr_alice', bio: 'cached bio', bioLinks: ['https://example.com'] });
    session.cookieJar.save = async () => {};
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
        { id: 'usr_alice', displayName: 'Alice', state: 'offline', location: 'offline' }
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const users = await session.vrchatRequest('auth/user/friends');
    assert.equal(users[0].bio, 'cached bio');
    assert.deepEqual(users[0].bioLinks, ['https://example.com']);
    assert.equal(users[0].state, 'offline');
});
