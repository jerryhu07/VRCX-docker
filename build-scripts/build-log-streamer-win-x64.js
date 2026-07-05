#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'build', 'log-streamer');
const nodeVersion = process.versions.node;
const nodeZipName = `node-v${nodeVersion}-win-x64.zip`;
const nodeZipUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeZipName}`;
const nodeZipPath = path.join(buildDir, nodeZipName);
const nodeExeInZip = `node-v${nodeVersion}-win-x64/node.exe`;
const nodeExePath = path.join(buildDir, 'node-win-x64.exe');
const bundlePath = path.join(buildDir, 'log-streamer.bundle.cjs');
const seaConfigPath = path.join(buildDir, 'sea-config.json');
const seaBlobPath = path.join(buildDir, 'log-streamer.blob');
const outputPath = path.join(rootDir, 'build', 'vrcx-log-streamer-win-x64.exe');
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const binExt = process.platform === 'win32' ? '.cmd' : '';
const esbuildBin = path.join(rootDir, 'node_modules', '.bin', `esbuild${binExt}`);
const postjectBin = path.join(rootDir, 'node_modules', '.bin', `postject${binExt}`);

function run(command, args, options = {}) {
    console.log(`> ${command} ${args.join(' ')}`);
    childProcess.execFileSync(command, args, {
        stdio: 'inherit',
        cwd: rootDir,
        ...options
    });
}

function download(url, destination) {
    if (fs.existsSync(destination)) return Promise.resolve();
    console.log(`Downloading ${url}`);
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
            ) {
                download(response.headers.location, destination)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(destination);
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
            file.on('error', reject);
        });
        request.on('error', reject);
    });
}

async function main() {
    fs.mkdirSync(buildDir, { recursive: true });
    run(esbuildBin, [
        'tools/log-streamer/log-streamer.js',
        '--bundle',
        '--platform=node',
        '--format=cjs',
        `--outfile=${bundlePath}`
    ]);

    fs.writeFileSync(
        seaConfigPath,
        JSON.stringify(
            {
                main: bundlePath,
                output: seaBlobPath,
                disableExperimentalSEAWarning: true,
                useSnapshot: false,
                useCodeCache: false
            },
            null,
            2
        )
    );
    run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

    await download(nodeZipUrl, nodeZipPath);
    const nodeExe = childProcess.execFileSync(
        'unzip',
        ['-p', nodeZipPath, nodeExeInZip],
        {
            maxBuffer: 128 * 1024 * 1024
        }
    );
    fs.writeFileSync(nodeExePath, nodeExe);
    fs.copyFileSync(nodeExePath, outputPath);

    run(postjectBin, [
        outputPath,
        'NODE_SEA_BLOB',
        seaBlobPath,
        '--sentinel-fuse',
        seaFuse,
        '--overwrite'
    ]);
    console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
