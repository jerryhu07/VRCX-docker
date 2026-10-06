const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installerConfigTrailer, readInstallerConfig } = require('./installerConfig.cjs');

test('personalized installer carries complete config regardless of exe filename or directory', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-config-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'setup (2).exe');
    const config = { server: 'http://localhost:18080', token: 'test-secret', machineId: 'windows', historyMode: 'ask', stateFile: '%CONFIG_DIR%\\streamer-state.json' };
    fs.writeFileSync(file, Buffer.concat([Buffer.from('MZ-test-client'), installerConfigTrailer(config)]));
    assert.deepEqual(readInstallerConfig(file), config);
    fs.writeFileSync(file, 'MZ-plain-installer');
    assert.equal(readInstallerConfig(file), null);
});

test('installer rejects malformed lengths and invalid credential destinations', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-config-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => installerConfigTrailer({ server: 'file:///tmp/config', token: 'secret' }));
    assert.throws(() => installerConfigTrailer({ server: 'http://user:pass@localhost', token: 'secret' }));
    const trailer = installerConfigTrailer({ server: 'http://localhost', token: 'test' });
    trailer.writeUInt32LE(1000000, trailer.length - Buffer.byteLength('VRCX-INSTALL-CONFIG-V1') - 4);
    const file = path.join(dir, 'bad.exe');
    fs.writeFileSync(file, trailer);
    assert.throws(() => readInstallerConfig(file), /length/);
});
