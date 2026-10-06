import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { logStreamState } from '../../../services/logStreamClient';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock('../../../stores', () => ({ useModalStore: () => ({ confirm: vi.fn() }) }));
vi.mock('../../../services/headlessBootstrap', () => ({ getHeadlessBootstrap: vi.fn() }));
vi.mock('../../../components/ui/button', () => ({ Button: { template: '<button><slot /></button>' } }));
vi.mock('../../../components/ui/tooltip', () => ({ TooltipWrapper: { template: '<div><slot /></div>' } }));

import LogStreamStatus from '../components/LogStreamStatus.vue';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('log client status', () => {
    it('downloads a formatted complete config only on click without rendering its secret', async () => {
        logStreamState.initialized = true;
        logStreamState.clients = [];
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ server: 'old', token: 'test-secret', historyMode: 'ask' }) });
        vi.stubGlobal('fetch', fetch);
        const createObjectURL = vi.fn(() => 'blob:test');
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const wrapper = mount(LogStreamStatus);
        await wrapper.get('button[aria-label="view.game_log.stream.config"]').trigger('click');
        await flushPromises();
        expect(fetch).toHaveBeenCalledWith('/headless/log-stream/config');
        expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
        expect(click).toHaveBeenCalledOnce();
        expect(wrapper.text()).not.toContain('test-secret');
        wrapper.unmount();
    });
    it('keeps unknown logging distinct from disabled and expires stale clients', async () => {
        vi.useFakeTimers();
        logStreamState.initialized = true;
        logStreamState.clients = [{ machineId: 'windows', connected: true, lastSeenAt: new Date().toISOString(), debugLoggingEnabled: null }];
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const wrapper = mount(LogStreamStatus);
        expect(wrapper.text()).toContain('stream.online');
        expect(wrapper.text()).toContain('stream.debug_unknown');
        expect(wrapper.text()).not.toContain('stream.debug_off');
        expect(fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50000);
        expect(wrapper.text()).toContain('stream.offline');
        wrapper.unmount();
    });
});
