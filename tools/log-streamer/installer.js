/* global require, module, Buffer */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sea = require('node:sea');
const { gunzipSync } = require('node:zlib');
const { readInstallerConfig } = require('../../headless/installerConfig.cjs');

function main() {
    if (process.argv.includes('--check-config')) {
        const config = readInstallerConfig(process.execPath);
        console.log(JSON.stringify({ embedded: !!config, tokenConfigured: !!config?.token }));
        return;
    }
    if (process.argv.includes('--help')) {
        console.log('VRCX log streamer installer (Windows x64). Confirms replacement and preserves configuration/checkpoints.');
        return;
    }
    if (process.platform !== 'win32') throw new Error('This installer requires Windows.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-log-setup-'));
    try {
        fs.writeFileSync(path.join(dir, 'vrcx-log-streamer-win-x64.exe'), gunzipSync(Buffer.from(sea.getAsset('streamer.exe.gz'))));
        fs.writeFileSync(path.join(dir, 'install.ps1'), Buffer.from(sea.getAsset('install.ps1')));
        const config = readInstallerConfig(process.execPath);
        const configSource = config ? path.join(dir, 'embedded-config.json') : path.join(path.dirname(process.execPath), 'vrcx-log-streamer.config.json');
        if (config) fs.writeFileSync(configSource, JSON.stringify(config), { mode: 0o600 });
        execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'install.ps1'),
                '-ConfigSource', configSource],
            { windowsHide: true, stdio: 'inherit' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module || sea.isSea()) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
