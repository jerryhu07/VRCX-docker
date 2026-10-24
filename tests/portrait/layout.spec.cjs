const { test, expect, request: requestFactory } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const routes = ['feed', 'friends-locations', 'game-log', 'player-list', 'search',
    'favorites/friends', 'favorites/worlds', 'favorites/avatars', 'social/friend-log',
    'social/moderation', 'my-avatars', 'notification', 'social/friend-list',
    'charts/instance', 'charts/mutual', 'charts/hot-worlds', 'tools', 'tools/gallery',
    'tools/screenshot-metadata', 'settings', 'watch-list', 'dashboard/portrait-preview'];

let bootstrap;
let apiRequest;
const apiReadCache = new Map();
test.beforeAll(async ({ baseURL }) => {
    apiRequest = await requestFactory.newContext({ baseURL });
    const response = await apiRequest.get('/headless/bootstrap');
    expect(response.ok()).toBeTruthy();
    bootstrap = await response.json();
    expect(bootstrap.state.loggedIn, 'Preview requires the existing authenticated backend').toBe(true);
});
test.afterAll(async () => {
    await Promise.allSettled([...apiReadCache.values()]);
    await apiRequest?.dispose();
});

test.beforeEach(async ({ page }) => {
    // Browser verification must not write settings, credentials or business actions to production.
    await page.route('**/headless/**', async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/headless/events') return route.fulfill({ contentType: 'text/event-stream',
            body: `data: ${JSON.stringify({ type: 'state', state: bootstrap.state })}\n\n` });
        if (pathname === '/headless/bootstrap') {
            const fixture = structuredClone(bootstrap);
            fixture.config['config:vrcx_dashboardconfigs'] = JSON.stringify({ dashboards: [{ id: 'portrait-preview',
                name: 'Portrait preview', rows: [{ panels: ['feed', 'game-log'], direction: 'horizontal' }] }] });
            return route.fulfill({ json: fixture });
        }
        if (pathname === '/headless/session/recover') return route.fulfill({ json: bootstrap.currentUser });
        if (request.method() !== 'POST') return route.continue();
        const body = request.postDataJSON() || {};
        const options = body.options || body;
        if (pathname === '/headless/sqlite/execute' && /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(body.sql)) return route.continue();
        if (pathname === '/headless/storage/get' || pathname === '/headless/storage/getAll') return route.continue();
        if (pathname === '/headless/webapi/execute' && (!options.method || options.method === 'GET')) {
            if (/\/users\/[^/]+\/instances\/groups(?:\?|$)/.test(options.url || '')) {
                return route.fulfill({ json: { status: 200, data: '{"instances":[]}' } });
            }
            const key = JSON.stringify(body);
            if (!apiReadCache.has(key)) apiReadCache.set(key, (async () => {
                const response = await apiRequest.post('/headless/webapi/execute', { data: body });
                return { status: response.status(), headers: response.headers(), body: await response.body() };
            })());
            const cached = await apiReadCache.get(key);
            if (page.isClosed()) return;
            return route.fulfill(cached);
        }
        if (/\/headless\/dotnet\/[^/]+\/(Get|Is|Check)/.test(pathname)) return route.continue();
        return route.fulfill({ json: { ok: true, value: null } });
    });
});

async function open(page, route, size) {
    await page.setViewportSize(size);
    await page.goto(`/#/${route}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.main-page-panel')).toBeVisible();
    await expect(page.locator('.main-page-panel')).toHaveAttribute('data-route', `/${route}`);
}

async function navigate(page, route) {
    // Exercise hash routing without a document navigation that cancels WebKit's pending reads.
    await page.evaluate((value) => { window.location.hash = `/${value}`; }, route);
    await expect(page.locator('.main-page-panel')).toHaveAttribute('data-route', `/${route}`);
}

for (const size of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 },
    { width: 900, height: 1200 }, { width: 600, height: 400 }, { width: 600, height: 600 }, { width: 1440, height: 900 }]) {
    test(`all routes fit ${size.width}x${size.height}`, async ({ page }, testInfo) => {
        test.setTimeout(240000);
        const errors = [];
        page.on('pageerror', (error) => {
            // WebKit reports this benign asynchronous resize diagnostic as a page error.
            if (/^ResizeObserver loop (completed|limit exceeded)/.test(error.message)) return;
            errors.push(error.message);
        });
        await open(page, 'feed', size);
        for (const route of routes) {
            await navigate(page, route);
            await expect(page.locator('.main-page-panel')).toBeVisible();
            await expect(page.locator('.main-page-panel')).toHaveAttribute('data-route', `/${route}`);
            await expect(page.locator('.main-page-panel [aria-busy="true"]')).toHaveCount(0);
            const layout = size.height > size.width ? 'portrait' : 'landscape';
            await expect(page.locator('html')).toHaveAttribute('data-layout', layout);
            if (layout === 'portrait') {
                await expect(page.locator('.portrait-header')).toBeVisible();
                const bounds = await page.locator('.main-page-panel').boundingBox();
                expect(bounds.width).toBeGreaterThan(size.width - 20);
            }
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow, `${route}: document overflow`).toBeLessThanOrEqual(1);
            const panelOverflow = await page.locator('.main-page-panel').evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(panelOverflow, `${route}: page overflow`).toBeLessThanOrEqual(2);
            const dir = path.join('build', 'portrait-qa', testInfo.project.name, `${size.width}x${size.height}`);
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `${route.replaceAll('/', '-')}.png`) });
        }
        expect(errors).toEqual([]);
    });
}

test('ratio gate, drawers and rotation preserve table rows and desktop settings', async ({ page }) => {
    await open(page, 'feed', { width: 390, height: 844 });
    const desktopSettings = { collapsed: bootstrap.config['config:vrcx_naviscollapsed'] === 'true',
        width: Number(bootstrap.config['config:vrcx_navpanelwidth'] || 240) };
    await expect.poll(() => page.evaluate(() => ({ collapsed: window.$pinia.appearanceSettings.isNavCollapsed,
        width: window.$pinia.appearanceSettings.navWidth }))).toEqual(desktopSettings);
    await page.locator('.portrait-header button').first().tap();
    await expect(page.locator('[data-mobile="true"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.portrait-header button').last().click();
    await expect(page.locator('.portrait-friends-sheet')).toBeVisible();
    await expect(page.locator('.portrait-friends-sheet .x-aside-container')).toBeVisible();
    await page.keyboard.press('Escape');
    const first = page.locator('.data-table tbody tr[data-row-id]').first();
    const id = await first.getAttribute('data-row-id');
    for (const size of [{ width: 600, height: 400 }, { width: 600, height: 600 },
        { width: 1000, height: 1400 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(size);
        await expect(page.locator('html')).toHaveAttribute('data-layout', size.height > size.width ? 'portrait' : 'landscape');
    }
    await expect(first).toHaveAttribute('data-row-id', id);
    expect(await page.evaluate(() => ({ collapsed: window.$pinia.appearanceSettings.isNavCollapsed,
        width: window.$pinia.appearanceSettings.navWidth }))).toEqual(desktopSettings);
});

test('portrait tables keep single rows and scroll locally; search uses two toolbar lines', async ({ page }) => {
    await open(page, 'feed', { width: 390, height: 844 });
    for (const route of ['feed', 'social/friend-log']) {
        await navigate(page, route);
        const table = page.locator('.main-page-panel .data-table table').first();
        await expect(table).toBeVisible();
        await expect(page.locator('[data-portrait-list]')).toHaveCount(0);
        const row = table.locator('tbody tr[data-row-id]').first();
        await expect(row).toBeVisible();
        expect((await row.boundingBox()).height).toBeLessThan(65);
        expect(await row.locator('td').first().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');
        const scroller = table.locator('xpath=../..');
        expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
        await scroller.evaluate((el) => { el.scrollLeft = 100; });
        expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await navigate(page, 'search');
    const toolbar = page.locator('.portrait-search-toolbar');
    const tabs = await toolbar.locator('[data-slot="tabs-list"]').boundingBox();
    const input = await toolbar.locator('input').boundingBox();
    expect(input.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    expect(input.width).toBeGreaterThan(280);
});

test('compact portrait chrome leaves most height for records in both themes', async ({ page }, testInfo) => {
    await open(page, 'feed', { width: 390, height: 844 });
    const table = page.locator('.main-page-panel .data-table').first();
    await expect(table).toHaveAttribute('aria-busy', 'false');
    const frame = table.locator('.dt-frame');
    const bounds = await frame.boundingBox();
    expect(bounds.x).toBeLessThanOrEqual(1);
    expect(bounds.width).toBeGreaterThanOrEqual(388);
    expect(bounds.y).toBeLessThanOrEqual(150);
    expect(bounds.height).toBeGreaterThan(620);
    expect((await table.locator('.dt-pagination').boundingBox()).height).toBeLessThanOrEqual(50);
    expect((await table.locator('tbody tr[data-row-id]').first().boundingBox()).height).toBeLessThanOrEqual(36);
    const filters = page.locator('.feed .portrait-toolbar > [data-slot="toggle-group"]');
    expect((await filters.boundingBox()).height).toBeLessThanOrEqual(48);
    await filters.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(filters.getByRole('button', { name: 'Bio', exact: true })).toBeInViewport();
    for (const dark of [false, true]) {
        await page.evaluate((value) => window.$pinia.appearanceSettings.setThemeMode(value ? 'dark' : 'light'), dark);
        await page.waitForLoadState('networkidle');
        await expect(table).toHaveAttribute('aria-busy', 'false');
        await expect.poll(() => table.locator('tbody tr[data-row-id]').first().evaluate((el) =>
            getComputedStyle(el).color === getComputedStyle(el.parentElement).color)).toBe(true);
        await page.locator('.noty_bar').evaluateAll((elements) => elements.forEach((el) => el.remove()));
        await page.screenshot({ animations: 'disabled', path: `build/portrait-qa/${testInfo.project.name}/compact-feed-${dark ? 'dark' : 'light'}.png` });
    }
});

test('settings selector and single-month calendar remain touch-accessible', async ({ page }) => {
    await open(page, 'settings', { width: 360, height: 800 });
    const selector = page.locator('.portrait-settings select').first();
    await expect(selector).toBeVisible();
    await selector.selectOption('interface');
    await expect(selector).toHaveValue('interface');
    for (const category of ['social', 'notifications', 'vr', 'media', 'integrations', 'advanced']) {
        await selector.selectOption(category);
        expect(await page.locator('.portrait-settings').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    }
    await navigate(page, 'feed');
    await page.locator('.portrait-toolbar [data-slot="popover-trigger"]').first().click();
    await expect(page.locator('[data-slot="popover-content"]')).toBeVisible();
    const bounds = await page.locator('[data-slot="popover-content"]').boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(344);
});

test('row actions and user/world details fit the portrait viewport', async ({ page }, testInfo) => {
    await open(page, 'feed', { width: 390, height: 844 });
    const row = page.locator('.data-table tbody tr[data-row-id]').first();
    await expect(row).toBeVisible();
    await row.locator('td [class*="pr-2.5"].cursor-pointer').first().click({ button: 'right' });
    await expect(page.locator('[data-slot="context-menu-content"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await row.locator('td [class*="pr-2.5"].cursor-pointer').first().click();
    const dialog = page.locator('[data-slot="dialog-content"]').last();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(374);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `build/portrait-qa/${testInfo.project.name}/user-dialog.png` });
    await dialog.locator('[data-slot="dialog-close"]').click();
    await expect(dialog).not.toBeVisible();
    await navigate(page, 'game-log');
    const world = page.locator('.main-page-panel .x-location.cursor-pointer').first();
    await expect(world).toBeVisible();
    await world.click();
    const worldDialog = page.locator('[data-slot="dialog-content"]').last();
    await expect(worldDialog).toBeVisible();
    const worldBounds = await worldDialog.boundingBox();
    expect(worldBounds.width).toBeLessThanOrEqual(374);
    expect(await worldDialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `build/portrait-qa/${testInfo.project.name}/world-dialog.png` });
});

test('logged-out login and soft keyboard stay inside portrait viewport', async ({ page }, testInfo) => {
    const state = { ...bootstrap.state, loggedIn: false, currentUser: null, authState: 'logged_out', pendingTwoFactor: [] };
    await page.route('**/headless/bootstrap', (route) => route.fulfill({ json: { ...bootstrap, state, currentUser: null } }));
    await page.route('**/headless/events', (route) => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'state', state })}\n\n` }));
    await page.route('**/headless/session/recover', (route) => route.fulfill({ status: 409, json: { state, error: { message: 'Preview login fixture' } } }));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/#/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#login-form-username')).toBeVisible();
    const login = page.locator('.x-login');
    expect(await login.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
    await page.locator('#login-form-username').fill('portrait-preview');
    await page.setViewportSize({ width: 360, height: 300 });
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'portrait');
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: `build/portrait-qa/${testInfo.project.name}/login.png` });
});

test('dashboard panels stack vertically without overwriting desktop sizes', async ({ page }) => {
    await open(page, 'dashboard/portrait-preview', { width: 390, height: 844 });
    const panels = page.locator('.portrait-dashboard .dashboard-panel');
    await expect(panels).toHaveCount(2);
    const first = await panels.nth(0).boundingBox();
    const second = await panels.nth(1).boundingBox();
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(second.x).toBeCloseTo(first.x, 0);
    expect(second.width).toBeGreaterThan(350);
});

test('closing a loading user dialog cannot be undone by a late profile response', async ({ page }) => {
    await open(page, 'feed', { width: 390, height: 844 });
    let release;
    let notify;
    let finished;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { notify = resolve; });
    const delivered = new Promise((resolve) => { finished = resolve; });
    let delayed = false;
    await page.route('**/headless/webapi/execute', async (route) => {
        const body = route.request().postDataJSON();
        const id = (body.options || body).url?.match(/\/users\/(usr_[\da-f-]+)(?:\?|$)/)?.[1];
        if (!id || delayed) return route.fallback();
        delayed = true;
        notify();
        await gate;
        await route.fulfill({ json: { status: 200, data: JSON.stringify({ ...bootstrap.currentUser, id, displayName: 'Delayed profile fixture' }) } });
        finished();
    });
    await page.locator('.data-table tbody tr[data-row-id]').first().locator('td [class*="pr-2.5"].cursor-pointer').first().click();
    await started;
    const dialog = page.locator('[data-slot="dialog-content"]').last();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-slot="dialog-close"]').click();
    await expect(dialog).not.toBeVisible();
    release();
    await delivered;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
});

test('player list renders backend snapshot and processes live joins/leaves without database replay', async ({ page }) => {
    const id = 'usr_00000000-0000-4000-8000-000000000001';
    const snapshot = { ownerId: bootstrap.currentUser.id, location: '', name: '', date: 1000,
        players: [{ userId: id, displayName: 'Snapshot Player', joinTime: 1234 }] };
    const state = { ...bootstrap.state, playerList: snapshot };
    await page.route('**/headless/events', (route) => route.fulfill({ contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'state', state })}\n\n` }));
    await page.addInitScript(() => {
        window.EventSource = class {
            constructor() { window.__playerListEvents = this; }
            close() {}
        };
    });
    await open(page, 'player-list', { width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => !!window.__playerListEvents?.onmessage)).toBe(true);
    const send = (value) => page.evaluate((state) => window.__playerListEvents.onmessage({
        data: JSON.stringify({ type: 'state', state })
    }), value);
    await send(state);
    const rows = page.locator('.main-page-panel tbody tr[data-row-id]');
    await expect(rows.filter({ hasText: 'Snapshot Player' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Snapshot Player' })).toHaveAttribute('data-row-id', `${id}:Snapshot Player`);
    await send({ ...state, playerList: { ...snapshot, players: [...snapshot.players,
        { userId: '', displayName: 'Name Only Player', joinTime: 2000 }] } });
    await expect(rows).toHaveCount(2);
    await send({ ...state, playerList: { ...snapshot, players: [] } });
    await expect(rows).toHaveCount(0);
});
