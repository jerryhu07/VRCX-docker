const assert = require('node:assert/strict');
const test = require('node:test');
const { RoomData } = require('./roomData.cjs');
const id = (n) => `usr_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hidden = 'usr_00000000-0000-0000-0000-000000000000';

function setup() {
    let now = 1000;
    let room = { ownerId: id(1), machineId: 'test', location: 'wrld_room:1', date: 1,
        players: [{ userId: id(1), displayName: 'Me' }, { userId: id(2), displayName: 'In-room friend' },
            { userId: id(3), displayName: 'Visitor' }, { userId: '', displayName: 'Name only' }] };
    const friends = new Map([[id(2), { displayName: 'In-room friend' }], [id(4), { displayName: 'Outside friend' }],
        [id(5), { displayName: 'Isolated friend' }], [hidden, { displayName: 'Hidden' }]]);
    const profiles = [], mutuals = [], updates = [];
    const service = new RoomData({ getRoster: () => room, getFriends: () => friends, now: () => now, delayMs: 0,
        fetchProfile: async (uid) => { profiles.push(uid); return { id: uid, displayName: `Profile ${uid}`, tags: ['system_trust_known'], email: 'private', state: 'offline' }; },
        fetchMutuals: async (uid) => { mutuals.push(uid); return uid === id(3) ? [id(2), id(4), id(4), hidden, id(9), uid] : [id(4)]; },
        notify: (data) => updates.push(data) });
    return { service, profiles, mutuals, updates, friends, get room() { return room; }, setRoom: (value) => { room = value; }, advance: (ms) => { now += ms; } };
}

test('profiles and mutual friends load together without a browser and share one job', async () => {
    const f = setup();
    await Promise.all([f.service.sync(), f.service.sync()]);
    assert.deepEqual(f.profiles, [id(2), id(3)]);
    assert.deepEqual(f.mutuals, [id(2), id(3)]);
    const player = f.service.decorate(f.room).players[1];
    assert.equal(player.profile.tags[0], 'system_trust_known');
    assert.equal(player.profile.email, undefined);
    assert.equal(player.profile.state, undefined);
    await f.service.sync();
    assert.equal(f.profiles.length, 2);
    f.room.players.push({ userId: id(6), displayName: 'New arrival' });
    await f.service.sync();
    assert.deepEqual(f.profiles, [id(2), id(3), id(6)]);
    assert.deepEqual(f.mutuals, [id(2), id(3), id(6)]);
});

test('tab visits and room changes reuse both caches for 12 hours; manual refresh bypasses them', async () => {
    const f = setup();
    const operations = [];
    const profile = f.service.fetchProfile, mutual = f.service.fetchMutuals;
    f.service.fetchProfile = async (id) => { operations.push('profile:' + id); return profile(id); };
    f.service.fetchMutuals = async (id) => { operations.push('mutual:' + id); return mutual(id); };
    await f.service.sync();
    assert.deepEqual(operations, ['profile:' + id(2), 'mutual:' + id(2), 'profile:' + id(3), 'mutual:' + id(3)]);
    f.advance(12 * 60 * 60 * 1000 - 1);
    f.room.location = 'wrld_other:2';
    f.service.requestNetwork();
    f.service.requestNetwork();
    await f.service.sync();
    assert.equal(f.profiles.length, 2);
    assert.equal(f.mutuals.length, 2);
    f.advance(2);
    await f.service.sync();
    assert.equal(f.profiles.length, 4);
    assert.equal(f.mutuals.length, 4);
    f.service.requestNetwork(true);
    await f.service.sync();
    assert.equal(f.profiles.length, 6);
    assert.equal(f.mutuals.length, 6);
});

test('only connected outside friends remain, and room friends do not link to outside friends', async () => {
    const f = setup();
    f.service.requestNetwork();
    await f.service.sync();
    const graph = f.service.network();
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.nodes.find((n) => n.id === id(4)).inRoom, false);
    assert(!graph.nodes.some((n) => n.id === id(5)));
    assert(!graph.nodes.some((n) => n.id === hidden || n.id === id(1)));
    assert.equal(graph.edges.length, 2);
    assert(!graph.edges.some((edge) => edge.source === id(2) && edge.target === id(4)));
    assert(graph.edges.some((edge) => edge.source === id(3) && edge.target === id(4)));
    assert.deepEqual(f.mutuals, [id(2), id(3)]);
    assert.equal(graph.fetched, 2);
    f.room.players = f.room.players.filter((p) => p.userId !== id(3));
    assert(!f.service.network().nodes.some((n) => n.id === id(3)));
    assert.equal(f.service.network().edges.length, 0);
    assert.deepEqual(f.service.network().nodes.map((n) => n.id), [id(2)]);
});

test('failed refresh preserves known connections and backs off all requests after a 429', async () => {
    const f = setup();
    f.service.requestNetwork();
    await f.service.sync();
    let calls = 0;
    f.service.fetchMutuals = async () => { calls++; throw Object.assign(new Error('Rate limited'), { status: 429 }); };
    f.service.requestNetwork(true);
    await f.service.sync();
    assert.equal(f.service.network().edges.length, 2);
    assert.equal(f.service.network().failed, 1);
    await f.service.sync();
    assert.equal(calls, 1);
    f.advance(60001);
    await f.service.sync();
    assert.equal(calls, 2);
});

test('friend-to-friend links remain visible when both friends are in the room', async () => {
    const f = setup();
    f.room.players.push({ userId: id(5), displayName: 'Another room friend' });
    f.service.fetchMutuals = async (uid) => uid === id(2) ? [id(4), id(5)] : uid === id(5) ? [id(2)] : [];
    f.service.requestNetwork();
    await f.service.sync();
    assert.deepEqual(f.service.network().edges, [{ source: id(2), target: id(5) }]);
    assert(!f.service.network().nodes.some((n) => n.id === id(4)));
});

test('a delayed response cannot populate another account or bring back a departed room', async () => {
    const f = setup();
    let resolve;
    f.service.fetchProfile = () => new Promise((done) => { resolve = done; });
    const pending = f.service.sync();
    await Promise.resolve();
    f.setRoom(null);
    resolve({ id: id(2), displayName: 'Late result' });
    await pending;
    assert.equal(f.service.network(), null);
    assert.equal(f.service.profiles.size, 0);
    assert.equal(f.updates.at(-1).playerList, null);
});
