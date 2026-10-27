import { afterEach, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';

vi.mock('vue-router', () => ({ useRouter: () => ({ currentRoute: ref({ name: 'test' }) }) }));
vi.mock('../../shared/utils', () => ({ compareGameLogRows: vi.fn(), findUserByDisplayName: vi.fn(),
    formatSeconds: vi.fn(), gameLogSearchFilter: vi.fn(), getGroupName: vi.fn() }));
vi.mock('../../coordinators/gameLogCoordinator', () => ({ tryLoadPlayerList: vi.fn() }));
vi.mock('../../services/config', () => ({ default: {
    getString: async (_key, fallback) => fallback,
    getBool: async (_key, fallback) => fallback
} }));
vi.mock('../../services/database', () => ({ database: {
    getSessionsLocationSegments: async () => [{ id: 1, created_at: '2026-10-09T16:02:02.511Z',
        location: 'room:1', worldName: 'World', time: 3600000 }],
    getSessionsEventsForSegments: async () => []
} }));
vi.mock('../settings/advanced', () => ({ useAdvancedSettingsStore: () => ({}) }));
vi.mock('../friend', () => ({ useFriendStore: () => ({ friends: new Map(), localFavoriteFriends: new Set() }) }));
vi.mock('../notification', () => ({ useNotificationStore: () => ({}) }));
vi.mock('../dashboard', () => ({ useDashboardStore: () => ({ dashboards: [] }) }));
vi.mock('../ui', () => ({ useUiStore: () => ({}) }));
vi.mock('../user', () => ({ useUserStore: () => ({ currentUser: { id: 'self' } }) }));
vi.mock('../vr', () => ({ useVrStore: () => ({}) }));
vi.mock('../vrcx', () => ({ useVrcxStore: () => ({ maxTableSize: 500, searchLimit: 500 }) }));
vi.mock('../../services/watchState', () => ({ watchState: {} }));

import { useGameLogStore } from '../gameLog';
afterEach(() => { delete window.__VRCX_HEADLESS__; });

test('headless Game Log keeps location-only sessions unless an event filter is active', async () => {
    window.__VRCX_HEADLESS__ = true;
    setActivePinia(createPinia());
    const store = useGameLogStore();
    await flushPromises();
    await store.loadSessionsSegments();
    expect(store.sessionsSegments).toHaveLength(1);
    expect(store.sessionsSegments[0].events).toEqual([]);
    await store.handleSessionsEventFilterChange(['OnPlayerJoined']);
    expect(store.sessionsSegments).toHaveLength(0);
});
