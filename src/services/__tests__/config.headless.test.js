import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), executeNonQuery: vi.fn() }));
vi.mock('../sqlite.js', () => ({ default: mocks }));
let repo;
let config;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks();
    window.__VRCX_HEADLESS__ = true;
    config = { 'config:vrcx_test': 'old' };
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (url === '/headless/bootstrap') return { ok: true, json: async () => ({ config, storage: {}, colours: {} }) };
        const body = JSON.parse(options.body);
        if (body.remove) delete config['config:' + body.key.toLowerCase()];
        else config['config:' + body.key.toLowerCase()] = String(body.value);
        return { ok: true };
    }));
    repo = (await import('../config')).default;
});
afterEach(() => { delete window.__VRCX_HEADLESS__; vi.unstubAllGlobals(); });
test('parallel settings reads share one request, including missing settings', async () => {
    const values = await Promise.all(Array.from({ length: 50 }, () => repo.getString('VRCX_missing', 'default')));
    expect(values.every((value) => value === 'default')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    await repo.init();
    expect(mocks.executeNonQuery).not.toHaveBeenCalled();
});
test('settings changes update cache and duplicate writes are skipped', async () => {
    await repo.setString('VRCX_test', 'new');
    await repo.setString('VRCX_test', 'new');
    expect(await repo.getString('VRCX_test')).toBe('new');
    expect(fetch).toHaveBeenCalledTimes(2);
    await repo.remove('VRCX_test');
    expect(await repo.getString('VRCX_test', 'missing')).toBe('missing');
});
