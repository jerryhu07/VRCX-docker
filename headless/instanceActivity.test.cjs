const assert = require('node:assert/strict');
const test = require('node:test');
const { buildInstanceActivity } = require('./instanceActivity.cjs');
const { HeadlessSession } = require('./server');
const at = (seconds) => new Date(Date.UTC(2026, 9, 14) + seconds * 1000).toISOString();
const location = [1, at(0), 'room:1', 'Room', 1800000, null];
const row = (id, seconds, type, uid, time = 0) => [id, at(seconds), type, uid, 'room:1', uid, time];
const raw = (offset, seconds, type, args) => ['log.txt', offset, at(seconds), JSON.stringify({ parsed: { type, args } })];
function build(options = {}) {
    return buildInstanceActivity({ locations: [location], events: [], rawEvents: [], clients: [],
        user: { id: 'self', displayName: 'Self' }, now: Date.parse(at(2000)), ...options });
}

test('only source-file self joins delimit the initial roster; duplicate joins are not stacked', () => {
    const result = build({
        events: [row(1, 0, 'OnPlayerJoined', 'self'), row(2, 10, 'OnPlayerJoined', 'self'),
            row(3, 15, 'OnPlayerJoined', 'Alice'), row(4, 16, 'OnPlayerJoined', 'Alice'), row(5, 20, 'OnPlayerJoined', 'self')],
        rawEvents: [raw(1, 0, 'location', ['room:1']), raw(2, 10, 'player-joined', ['Self', 'self']),
            raw(3, 15, 'player-joined', ['Alice', 'Alice']), raw(4, 20, 'player-joined', ['Self', 'self'])]
    });
    const alice = result.detailData[0][1].filter((r) => r.user_id === 'Alice');
    assert.equal(alice.length, 1);
    assert.equal(alice[0].time, 1800000);
    assert.equal(alice[0].present_at_self_join, true);
    assert.equal(alice[0].still_present_at_self_leave, true);
});

test('missing self leave distinguishes fresh live, explicit stopped and unknown/disconnected', () => {
    const client = { currentLocation: 'room:1', currentLocationCreatedAt: at(0), connected: true,
        vrchatRunning: true, lastSeenAt: at(2000), lastEventAt: at(100) };
    const options = { locations: [[...location.slice(0, 4), 0, null]], events: [row(1, 10, 'OnPlayerJoined', 'Alice')] };
    const live = build({ ...options, clients: [client] });
    assert.equal(live.currentUserData[0].session_status, 'online');
    assert.equal(live.currentUserData[0].time, 2000000);
    assert.equal(live.detailData[0][1][1].still_present_at_self_leave, false);
    const stopped = build({ ...options, clients: [{ ...client, vrchatRunning: false, gameStoppedAt: at(150) }] });
    assert.equal(stopped.currentUserData[0].time, 150000);
    assert.equal(stopped.currentUserData[0].session_status, 'closed');
    assert.equal(stopped.detailData[0][1][1].still_present_at_self_leave, true);
    const unknown = build({ ...options, clients: [{ ...client, connected: false }] });
    assert.equal(unknown.currentUserData[0].session_status, 'unknown');
    assert.equal(unknown.currentUserData[0].time, 10000);
    const stale = build({ ...options, clients: [{ ...client, lastSeenAt: at(100) }] });
    assert.equal(stale.currentUserData[0].session_status, 'unknown');
});

test('revisits stay separate and actual player departures have no still-present marker', () => {
    const result = build({ locations: [[1, at(0), 'room:1', 'Room', 100000, at(200)],
        [2, at(200), 'room:1', 'Room', 100000, null]],
        events: [row(1, 10, 'OnPlayerJoined', 'Alice'), row(2, 90, 'OnPlayerLeft', 'Alice', 80000),
            row(3, 210, 'OnPlayerJoined', 'Alice')] });
    assert.equal(result.detailData.length, 2);
    assert.equal(result.detailData[0][1][1].time, 80000);
    assert.equal(result.detailData[0][1][1].still_present_at_self_leave, false);
    assert.equal(result.detailData[1][1][1].time, 90000);
    assert.equal(result.detailData[1][1][1].still_present_at_self_leave, true);
});

test('restored real player events rebuild join times after reconnect', () => {
    const session = new HeadlessSession({});
    const client = session.getLogStreamClient('pc');
    session.hydrateLogStreamContext(client, { loggedAt: at(10), parsed: { type: 'player-joined', args: ['Alice', 'alice'] } });
    assert.equal(client.players.get('alice').joinTime, Date.parse(at(10)));
    session.hydrateLogStreamContext(client, { loggedAt: at(20), parsed: { type: 'player-left', args: ['Alice', 'alice'] } });
    assert.equal(client.players.size, 0);
});
