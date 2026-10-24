import { expect, test } from 'vitest';
import { getLoginRedirect } from '../loginRedirect';

test('preserves internal deep links and rejects external destinations and login loops', () => {
    expect(getLoginRedirect('/settings')).toBe('/settings');
    expect(getLoginRedirect('/charts/instance?day=2026-10-19')).toBe('/charts/instance?day=2026-10-19');
    for (const value of [undefined, ['feed'], '//example.com', '/\\example.com', 'https://example.com', '/login', '/login?redirect=/settings']) {
        expect(getLoginRedirect(value)).toBe('/feed');
    }
});
