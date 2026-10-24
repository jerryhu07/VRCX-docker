import { beforeEach, expect, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useLocationStore } from '../location';

beforeEach(() => setActivePinia(createPinia()));
test('server snapshots replace the current roster without resetting join times or keeping departed players', () => {
    const store = useLocationStore();
    const alice = { userId: 'usr_alice', displayName: 'Alice', joinTime: 1234 };
    store.applyHeadlessPlayerList({ date: 1000, location: 'wrld_room:1', name: 'Room', players: [alice,
        { userId: '', displayName: 'Unknown', joinTime: 1500 }] }, new Map([['usr_alice', {}]]));
    expect(store.lastLocation.playerList.get('usr_alice').joinTime).toBe(1234);
    expect(store.lastLocation.playerList.has('Unknown')).toBe(true);
    expect(store.lastLocation.friendList.size).toBe(1);
    store.applyHeadlessPlayerList(null, new Map());
    expect(store.lastLocation.location).toBe('');
    expect(store.lastLocation.playerList.size).toBe(0);
});
