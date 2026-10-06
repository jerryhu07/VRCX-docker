import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key, args) => args?.name ? `${key}:${args.name}` : key }) }));
vi.mock('../../../stores', () => ({ useModalStore: () => ({ confirm: mocks.confirm }) }));
vi.mock('vue-sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../../../components/ui/tooltip', () => ({ TooltipWrapper: { template: '<div><slot /></div>' } }));
vi.mock('../../../components/ui/dialog', () => {
    const div = { template: '<div><slot /></div>' };
    return { Dialog: div, DialogFooter: div, DialogHeader: div, DialogScrollContent: div, DialogTitle: div };
});
import LogStreamSettings from '../components/LogStreamSettings.vue';

const config = { server: 'http://localhost', machineId: 'pc', logDir: '', stateFile: '', historyMode: 'ask',
    historyMaxDays: 14, historyMaxFiles: 20, batchSize: 100, pollMs: 1000, tailBytes: 1048576,
    vrchatExitGraceMs: 30000, exitWithVrchat: true, singleInstance: true, token: 'test-secret' };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('log client settings', () => {
    it('saves custom fields without sending the secret and keeps it masked', async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...config }) });
        vi.stubGlobal('fetch', fetch);
        const wrapper = mount(LogStreamSettings);
        await flushPromises();
        expect(wrapper.get('#log-secret').attributes('type')).toBe('password');
        await wrapper.get('#log-pollMs').setValue('500');
        await wrapper.get('form').trigger('submit');
        await flushPromises();
        const request = JSON.parse(fetch.mock.calls[2][1].body);
        expect(request.pollMs).toBe(500);
        expect(request).not.toHaveProperty('token');
        wrapper.unmount();
    });
    it('does not rotate on cancellation and sends confirmation on explicit approval', async () => {
        const fetch = vi.fn().mockImplementation(async (url) => ({ ok: true, json: async () => url.endsWith('/rotate') ? { token: 'new-secret' } : { ...config } }));
        vi.stubGlobal('fetch', fetch);
        const wrapper = mount(LogStreamSettings);
        await flushPromises();
        const button = wrapper.get('button[aria-label="view.game_log.stream.rotate"]');
        mocks.confirm.mockResolvedValueOnce({ ok: false });
        await button.trigger('click'); await flushPromises();
        expect(fetch).toHaveBeenCalledTimes(2);
        mocks.confirm.mockResolvedValueOnce({ ok: true });
        await button.trigger('click'); await flushPromises();
        expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ confirm: true });
        expect(wrapper.get('#log-secret').element.value).toBe('new-secret');
        expect(wrapper.get('#log-secret').attributes('type')).toBe('password');
        wrapper.unmount();
    });
    it('resets fields independently and resets all to browser/user defaults without changing the secret or saving', async () => {
        const original = { ...config, server: 'http://backend-internal', machineId: 'streamer_usr_me', historyMode: 'backfill' };
        const fetch = vi.fn().mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('defaults=1') ? original : { ...config, pollMs: 500 } }));
        vi.stubGlobal('fetch', fetch);
        const wrapper = mount(LogStreamSettings);
        await flushPromises();
        await wrapper.get('button[aria-label="view.game_log.stream.reset_field:view.game_log.stream.pollMs"]').trigger('click');
        expect(wrapper.get('#log-pollMs').element.value).toBe('1000');
        expect(wrapper.get('#log-machineId').element.value).toBe('pc');
        await wrapper.get('button[aria-label="view.game_log.stream.reset_field:view.game_log.stream.server"]').trigger('click');
        expect(wrapper.get('#log-server').element.value).toBe(window.location.origin);
        const reset = wrapper.findAll('button').find((button) => button.text().includes('stream.reset_all'));
        await reset.trigger('click');
        expect(wrapper.get('#log-machineId').element.value).toBe('streamer_usr_me');
        expect(wrapper.get('#log-secret').element.value).toBe('test-secret');
        expect(fetch).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });
});
