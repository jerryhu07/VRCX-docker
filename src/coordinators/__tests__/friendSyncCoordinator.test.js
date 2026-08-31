import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authStore: { handleLogoutEvent: vi.fn() },
    friendStore: {
        friends: new Map(),
        getFriendLog: vi.fn(),
        initFriendLog: vi.fn(),
        resetFriendLog: vi.fn(),
        setIsRefreshFriendsLoading: vi.fn(),
        tryApplyFriendOrder: vi.fn(),
        getAllUserStats: vi.fn(),
        migrateFriendLog: vi.fn()
    },
    userStore: { currentUser: { id: 'usr_me' } },
    configRepository: { getBool: vi.fn() }
}));

vi.mock('vue-sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../services/appConfig', () => ({
    AppDebug: { dontLogMeOut: false }
}));
vi.mock('../memoCoordinator', () => ({ migrateMemos: vi.fn() }));
vi.mock('../searchIndexCoordinator', () => ({
    syncFriendSearchIndex: vi.fn()
}));
vi.mock('../../services/websocket', () => ({ reconnectWebSocket: vi.fn() }));
vi.mock('../../stores/auth', () => ({
    useAuthStore: () => mocks.authStore
}));
vi.mock('../../stores/friend', () => ({
    useFriendStore: () => mocks.friendStore
}));
vi.mock('../../stores/updateLoop', () => ({
    useUpdateLoopStore: () => ({ nextCurrentUserRefresh: 999 })
}));
vi.mock('../../stores/user', () => ({
    useUserStore: () => mocks.userStore
}));
vi.mock('../userCoordinator', () => ({ getCurrentUser: vi.fn() }));
vi.mock('../../services/config', () => ({
    default: mocks.configRepository
}));

import { runInitFriendsListFlow } from '../friendSyncCoordinator';

describe('runInitFriendsListFlow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete window.__VRCX_HEADLESS__;
        mocks.configRepository.getBool.mockResolvedValue(true);
        mocks.friendStore.getFriendLog.mockRejectedValue(
            new Error('temporary network failure')
        );
    });

    test('keeps the browser session during a headless friend sync failure', async () => {
        window.__VRCX_HEADLESS__ = true;

        await expect(runInitFriendsListFlow((key) => key)).rejects.toThrow(
            'temporary network failure'
        );

        expect(mocks.authStore.handleLogoutEvent).not.toHaveBeenCalled();
    });

    test('preserves the desktop logout behavior', async () => {
        await expect(runInitFriendsListFlow((key) => key)).rejects.toThrow(
            'temporary network failure'
        );

        expect(mocks.authStore.handleLogoutEvent).toHaveBeenCalledOnce();
    });
});
