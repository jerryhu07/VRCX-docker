const assert = require('node:assert/strict');
const test = require('node:test');
const { HeadlessSession } = require('./server');
const { DatabaseSync } = require('node:sqlite');

test('live player snapshots hydrate joins/leaves, reject history rewinds and clear while traveling/offline', async () => {
    const session = new HeadlessSession({});
    session.currentUser = { id: 'usr_me', displayName: 'Me' };
    const client = session.getLogStreamClient('pc');
    client.connected = true;
    client.vrchatRunning = true;
    client.lastSeenAt = new Date().toISOString();
    client.currentFile = 'live.txt';
    session.persistLogStreamEvent = async () => false;
    session.persistLogStreamClient = async () => {};
    session.broadcast = () => {};
    const event = (seconds, type, args, file = 'live.txt') => ({
        file, loggedAt: new Date(Date.now() - 100000 + seconds * 1000).toISOString(), parsed: { type, args }
    });
    await session.handleLogStreamEvents('pc', [event(1, 'location', ['wrld_room:1', 'Room']),
        event(2, 'player-joined', ['Alice', 'usr_alice'])]);
    assert.equal(session.playerListSnapshot().location, 'wrld_room:1');
    assert.deepEqual(session.playerListSnapshot().players.map((p) => p.userId), ['usr_alice', 'usr_me']);
    await session.handleLogStreamEvents('pc', [event(0, 'location', ['wrld_old:1', 'Old'], 'old.txt')]);
    assert.equal(session.playerListSnapshot().location, 'wrld_room:1');
    await session.handleLogStreamEvents('pc', [event(3, 'player-left', ['Alice', 'usr_alice'])]);
    assert.deepEqual(session.playerListSnapshot().players.map((p) => p.userId), ['usr_me']);
    const other = session.getLogStreamClient('old-pc');
    other.lastSeenAt = '2000-01-01T00:00:00Z';
    other.connected = true;
    await session.handleLogStreamEvents('pc', [event(4, 'location-destination', ['wrld_next:1'])]);
    assert.equal(session.playerListSnapshot(), null);
    await session.handleLogStreamEvents('pc', [event(5, 'location', ['wrld_next:1', 'Next'])]);
    client.currentFile = 'another-process.txt';
    assert.equal(session.playerListSnapshot(), null);
    client.currentFile = 'live.txt';
    client.vrchatRunning = false;
    assert.equal(session.playerListSnapshot(), null);
    client.vrchatRunning = true;
    assert.equal(session.playerListSnapshot(Date.now() + 46000), null);
    await session.handleLogStreamEvents('pc', [event(6, 'player-left', ['Me', 'usr_me'])]);
    assert.equal(session.playerListSnapshot(), null);
});

test('historical backfill and duplicate boundaries cannot change the room of the next live write', async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const session = new HeadlessSession({});
    session.currentUser = { id: 'usr_me', displayName: 'Me' };
    session.loggedIn = true;
    session.broadcast = () => {};
    session.locationNames = async () => ({ worldName: 'Room', groupName: '' });
    session.sqliteExecute = async (sql, args) => {
        const statement = db.prepare(sql);
        return (args ? statement.all(args) : statement.all()).map(Object.values);
    };
    session.sqliteNonQuery = async (sql, args) => {
        const statement = db.prepare(sql);
        return (args ? statement.run(args) : statement.run()).changes;
    };
    await session.initGlobalTables();
    await session.initUserTables('usr_me');
    const event = (offset, type, args, file = 'live.txt') => ({ file, offset, raw: `${file}:${offset}`,
        loggedAt: new Date(Date.UTC(2026, 9, 24, 12, 0, offset)).toISOString(), parsed: { type, args } });
    const location = event(30, 'location', ['wrld_live:1', 'Live']);
    await session.handleLogStreamEvents('pc', [location, event(31, 'player-joined', ['Alice', 'usr_alice'])]);
    await session.handleLogStreamEvents('pc', [event(1, 'location', ['wrld_old:1', 'Old']),
        event(2, 'player-joined', ['Bob', 'usr_bob']), location]);
    await session.handleLogStreamEvents('pc', [event(32, 'player-joined', ['Carol', 'usr_carol'])]);
    const rows = db.prepare('SELECT display_name,location FROM gamelog_join_leave WHERE user_id != ? ORDER BY created_at').all('usr_me');
    assert.deepEqual(rows.map((r) => [r.display_name, r.location]), [
        ['Bob', 'wrld_old:1'], ['Alice', 'wrld_live:1'], ['Carol', 'wrld_live:1']]);
    assert.equal(session.getLogStreamClient('pc').currentLocation, 'wrld_live:1');
    assert.equal(db.prepare("SELECT count(*) n FROM gamelog_join_leave WHERE type='OnPlayerLeft' AND location='wrld_live:1'").get().n, 0);
    await session.handleLogStreamEvents('pc', [event(33, 'location-destination', ['wrld_next:1']), event(34, 'player-left', ['Me', 'usr_me'])]);
    assert.equal(db.prepare("SELECT location FROM gamelog_join_leave WHERE type='OnPlayerLeft' AND created_at=?").get(event(34).loggedAt).location, 'wrld_live:1');
    await session.handleLogStreamEvents('pc', [event(33, 'player-joined', ['No room', 'usr_unknown'], 'new.txt')]);
    assert.equal(db.prepare("SELECT location FROM gamelog_join_leave WHERE user_id='usr_unknown'").get().location, '');
});

test('accepted historical writes cannot overwrite the live roster', async () => {
    const session = new HeadlessSession({});
    const client = session.getLogStreamClient('pc');
    session.persistLogStreamEvent = async () => true;
    session.persistLogStreamClient = async () => {};
    session.broadcast = () => {};
    session.applyLogStreamEvent = async () => { client.players.clear(); return true; };
    const event = (date, type, args) => ({ file: 'live.txt', loggedAt: date, parsed: { type, args } });
    await session.handleLogStreamEvents('pc', [event('2026-10-24T12:00:00Z', 'location', ['wrld_live:1', 'Live']),
        event('2026-10-24T12:01:00Z', 'player-joined', ['Alice', 'usr_alice']),
        event('2026-10-20T12:00:00Z', 'location', ['wrld_history:1', 'History'])]);
    assert.equal(session.playerListSnapshot().location, 'wrld_live:1');
    assert.equal(session.playerListSnapshot().players[0].userId, 'usr_alice');
    await session.handleLogStreamEvents('pc', [{ ...event('2026-10-24T12:02:00Z', 'player-joined', ['Bob', 'usr_bob']), file: 'new-file.txt' }]);
    assert.equal(session.playerListSnapshot(), null);
});
