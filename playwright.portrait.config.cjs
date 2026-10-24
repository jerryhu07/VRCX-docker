const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/portrait',
    outputDir: './build/portrait-test-results',
    timeout: 60000,
    expect: { timeout: 20000 },
    workers: 2,
    reporter: [['list'], ['html', { outputFolder: 'build/portrait-report', open: 'never' }]],
    use: { baseURL: process.env.PORTRAIT_BASE_URL || 'http://127.0.0.1:9000',
        hasTouch: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: process.env.PORTRAIT_CHROME_CHANNEL || undefined } },
        { name: 'webkit', use: { browserName: 'webkit' } }]
});
