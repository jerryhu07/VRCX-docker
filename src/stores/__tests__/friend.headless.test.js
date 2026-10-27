import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive, ref } from 'vue';

const mocks = vi.hoisted(() => ({ user: null, apply: vi.fn() }));
vi.mock('../index', () => ({}));
vi.mock('../user', () => ({ useUserStore: () => mocks.user }));
vi.mock('vue-router', () => ({ useRouter: () => ({ currentRoute: ref({ name: 'feed', params: {} }) }) }));
vi.mock('../settings/appearance', () => ({ useAppearanceSettingsStore: () => ({ sidebarSortMethods: [] }) }));
vi.mock('../settings/general', () => ({ useGeneralSettingsStore: () => ({}) }));
vi.mock('../favorite', () => ({ useFavoriteStore: () => ({ cachedFavorites: new Map(), localFriendFavorites: {} }) }));
vi.mock('../group', () => ({ useGroupStore: () => ({ clearGroupInstances: vi.fn() }) }));
vi.mock('../location', () => ({ useLocationStore: () => ({ lastLocation: { friendList: new Map(), location: 'world:1' } }) }));
vi.mock('../dashboard', () => ({ useDashboardStore: () => ({ dashboards: [] }) }));
vi.mock('../feed', () => ({ useFeedStore: () => ({}) }));
vi.mock('../notification', () => ({ useNotificationStore: () => ({}) }));
vi.mock('../sharedFeed', () => ({ useSharedFeedStore: () => ({}) }));
vi.mock('../../coordinators/userCoordinator', () => ({ applyUser: mocks.apply }));
vi.mock('../../coordinators/searchIndexCoordinator', () => ({ syncFriendSearchIndex: vi.fn() }));
vi.mock('../../coordinators/memoCoordinator', () => ({ getUserMemo: vi.fn() }));
vi.mock('../../coordinators/friendSyncCoordinator', () => ({ runInitFriendsListFlow: vi.fn() }));
vi.mock('../../coordinators/friendRelationshipCoordinator', () => ({ updateFriendship: vi.fn(), runUpdateFriendshipsFlow: vi.fn() }));
vi.mock('../../api', () => ({ friendRequest: {}, userRequest: {} }));
vi.mock('../../services/database', () => ({ database: {} }));
vi.mock('../../services/config', () => ({ default: { getString: async () => 'false' } }));
vi.mock('../../shared/utils', () => ({ getFriendsSortFunction: () => (a, b) => a.id.localeCompare(b.id),
    compareByCreatedAtAscending: () => 0, createRateLimiter: vi.fn(), executeWithBackoff: vi.fn(),
    isRealInstance: (value) => value?.startsWith('world:'), getGroupName: vi.fn(), getWorldName: vi.fn() }));

import { useFriendStore } from '../friend';
import { watchState } from '../../services/watchState';
let store;
beforeEach(() => {
    setActivePinia(createPinia());
    window.__VRCX_HEADLESS__ = true;
    watchState.isLoggedIn = true;
    watchState.isFriendsLoaded = false;
    mocks.user = { currentUser: { id: 'usr_me' }, cachedUsers: reactive(new Map()) };
    mocks.apply.mockImplementation((user) => {
        const existing = mocks.user.cachedUsers.get(user.id);
        const next = { ...user, $location: { tag: user.location, isRealInstance: user.location?.startsWith('world:') } };
        if (existing) Object.assign(existing, next);
        else mocks.user.cachedUsers.set(user.id, next);
    });
    store = useFriendStore();
});
afterEach(() => { delete window.__VRCX_HEADLESS__; vi.unstubAllGlobals(); vi.clearAllMocks(); });

function push(revision, state, location = 'offline') {
    store.applyHeadlessFriendState({ ownerId: 'usr_me', generation: '2026-10-07T00:00:00Z', revision,
        user: { id: 'usr_friend', displayName: 'Friend', state, location } });
}
test('SSE directly updates online, active, offline lists and count without profile-side callbacks', () => {
    push(1, 'online', 'world:1');
    expect(store.onlineFriends.map((friend) => friend.id)).toEqual(['usr_friend']);
    expect(store.onlineFriendCount).toBe(1);
    push(2, 'active');
    expect(store.onlineFriends).toHaveLength(0);
    expect(store.activeFriends).toHaveLength(1);
    expect(store.onlineFriendCount).toBe(0);
    push(3, 'offline');
    expect(store.activeFriends).toHaveLength(0);
    expect(store.offlineFriends).toHaveLength(1);
    push(2, 'online', 'world:old');
    expect(store.offlineFriends).toHaveLength(1);
});
test('location changes immediately reach the friend reference and snapshots use the same application path', async () => {
    push(1, 'online', 'world:old');
    push(2, 'online', 'world:new');
    expect(store.onlineFriends[0].ref.$location.tag).toBe('world:new');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ownerId: 'usr_me',
        generation: '2026-10-07T00:00:00Z', revision: 3, users: [{ id: 'usr_friend', state: 'offline', displayName: 'Friend', location: 'offline' }] }) }));
    await store.refreshFriends();
    expect(store.onlineFriends).toHaveLength(0);
    expect(store.offlineFriends).toHaveLength(1);
});
