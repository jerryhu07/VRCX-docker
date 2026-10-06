import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), apply: vi.fn(), feed: vi.fn(), sync: vi.fn(), userApply: vi.fn() }));
vi.mock('../../stores', () => ({
    useAuthStore: () => ({ syncHeadlessSessionState: mocks.sync }),
    useFriendStore: () => ({ refreshFriends: mocks.refresh, applyHeadlessFriendState: mocks.apply, isRefreshFriendsLoading: false }),
    useFeedStore: () => ({ feedTableLookup: mocks.feed }),
    useUserStore: () => ({}), useGalleryStore: () => ({}), useGameLogStore: () => ({}),
    useGroupStore: () => ({}), useInstanceStore: () => ({}), useLocationStore: () => ({}),
    useNotificationStore: () => ({}), useSharedFeedStore: () => ({}), useUiStore: () => ({})
}));
vi.mock('../../coordinators/userCoordinator', () => ({ applyUser: mocks.userApply, applyCurrentUser: vi.fn() }));
vi.mock('../../coordinators/groupCoordinator', () => ({ onGroupLeft: vi.fn(), applyGroup: vi.fn(), getGroupDialogGroup: vi.fn(), handleGroupMember: vi.fn() }));
vi.mock('../../coordinators/friendRelationshipCoordinator', () => ({ handleFriendAdd: vi.fn(), handleFriendDelete: vi.fn() }));
vi.mock('../../coordinators/friendPresenceCoordinator', () => ({ runUpdateFriendFlow: vi.fn() }));
vi.mock('../../coordinators/locationCoordinator', () => ({ runSetCurrentUserLocationFlow: vi.fn() }));
vi.mock('../../shared/utils', () => ({ parseLocation: vi.fn() }));
vi.mock('../appConfig', () => ({ AppDebug: {} }));
vi.mock('../../api', () => ({ groupRequest: {} }));
vi.mock('../request', () => ({ request: vi.fn() }));
vi.mock('worker-timers', () => ({ setTimeout: (...args) => setTimeout(...args), clearTimeout: (id) => clearTimeout(id) }));
import { initWebsocket, closeWebSocket } from '../websocket';
import { watchState } from '../watchState';
let source;
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.refresh.mockResolvedValue([]); mocks.feed.mockResolvedValue([]); mocks.sync.mockResolvedValue();
    window.__VRCX_HEADLESS__ = true;
    watchState.isLoggedIn = true;
    vi.stubGlobal('EventSource', class { constructor() { source = this; } close = vi.fn(); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    initWebsocket();
});
afterEach(() => { closeWebSocket(); vi.useRealTimers(); vi.unstubAllGlobals(); delete window.__VRCX_HEADLESS__; });
test('successful SSE reconnect cancels stale close timer and resynchronizes friends', async () => {
    source.onerror();
    source.onopen();
    await vi.advanceTimersByTimeAsync(5500);
    expect(source.close).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/headless/friends/refresh', { method: 'POST' });
});

test('remote refresh starts only after the cached list has been applied', async () => {
    let release;
    mocks.refresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    source.onopen();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).not.toHaveBeenCalled();
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledWith('/headless/friends/refresh', { method: 'POST' });
});
test('friend state is dispatched immediately and reconnect refresh events are coalesced', async () => {
    const payload = { type: 'friend-state', user: { id: 'usr_a', state: 'online' }, revision: 5, generation: '2026-10-06' };
    source.onmessage({ data: JSON.stringify(payload) });
    expect(mocks.apply).toHaveBeenCalledWith(payload);
    source.onmessage({ data: '{"type":"friends-refresh"}' });
    source.onmessage({ data: '{"type":"friends-refresh"}' });
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
});

test('late raw offline events do not override the newer versioned online state', () => {
    const payload = { type: 'friend-state', user: { id: 'usr_a', state: 'online' }, revision: 6, generation: '2026-10-06' };
    source.onmessage({ data: JSON.stringify(payload) });
    source.onmessage({ data: JSON.stringify({ type: 'pipeline', event: { type: 'friend-offline', content: { userId: 'usr_a' } } }) });
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledWith(payload);
    expect(mocks.userApply).not.toHaveBeenCalled();
});
