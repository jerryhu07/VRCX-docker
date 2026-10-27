const { test, expect } = require('@playwright/test');

test('production stylesheet URLs change with their content', async ({ request }) => {
    const response = await request.get('/');
    expect(response.ok()).toBeTruthy();
    const html = await response.text();
    test.skip(html.includes('/@vite/client'), 'Vite development serves unbundled styles');
    expect(response.headers()['cache-control']).toBe('no-store');
    const stylesheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const href of stylesheets) {
        expect(href).toMatch(/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.css$/);
        const css = await request.get(new URL(href, response.url()).href);
        expect(css.ok()).toBeTruthy();
        expect(css.headers()['content-type']).toContain('text/css');
    }
});
