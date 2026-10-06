import { afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    friend: { friends: new Map(), localFavoriteFriends: new Set(), pendingOfflineMap: new Map(),
        reindexSortedFriend: vi.fn(), updateOnlineFriendCounter: vi.fn() },
    user: { cachedUsers: new Map() }, getUser: vi.fn()
}));
vi.mock('../../shared/utils', () => ({ getGroupName: vi.fn(), getWorldName: vi.fn(), isRealInstance: () => true }));
vi.mock('../../services/appConfig', () => ({ AppDebug: {} }));
vi.mock('../../services/database', () => ({ database: {} }));
vi.mock('../../stores/feed', () => ({ useFeedStore: () => ({}) }));
vi.mock('../../stores/friend', () => ({ useFriendStore: () => mocks.friend }));
vi.mock('../../stores/notification', () => ({ useNotificationStore: () => ({}) }));
vi.mock('../../stores/sharedFeed', () => ({ useSharedFeedStore: () => ({}) }));
vi.mock('../../stores/user', () => ({ useUserStore: () => mocks.user }));
vi.mock('../../api', () => ({ userRequest: { getUser: mocks.getUser } }));
vi.mock('../searchIndexCoordinator', () => ({ syncFriendSearchIndex: vi.fn() }));
import { runUpdateFriendFlow } from '../friendPresenceCoordinator';
afterEach(() => { delete window.__VRCX_HEADLESS__; vi.clearAllMocks(); });
test('headless presence updates are immediate and never trigger desktop API refetch or debounce', async () => {
    window.__VRCX_HEADLESS__ = true;
    const ref = { id: 'usr_a', displayName: 'Alice', state: 'online', location: 'wrld_a:1', $lastFetch: 0, $online_for: 123 };
    const ctx = { id: ref.id, state: 'online', ref, pendingOffline: true };
    mocks.user.cachedUsers.set(ref.id, ref);
    mocks.friend.friends.set(ref.id, ctx);
    mocks.friend.pendingOfflineMap.set(ref.id, { startTime: 0 });
    await runUpdateFriendFlow(ref.id, 'offline');
    expect(ctx.state).toBe('offline');
    expect(ctx.pendingOffline).toBe(false);
    expect(mocks.friend.pendingOfflineMap.size).toBe(0);
    await runUpdateFriendFlow(ref.id, 'online');
    expect(ctx.state).toBe('online');
    expect(ref.$online_for).toBe(123);
    expect(mocks.getUser).not.toHaveBeenCalled();
});
