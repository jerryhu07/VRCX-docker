#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TAIL_BYTES = 1024 * 1024;
const DEFAULT_HISTORY_MAX_DAYS = 14;
const DEFAULT_HISTORY_MAX_FILES = 20;
const DEFAULT_VRCHAT_STEAM_APP_ID = '438100';

function parseArgs(argv) {
    const args = {
        configFile: process.env.VRCX_LOG_STREAM_CONFIG || '',
        server: process.env.VRCX_HEADLESS_URL || '',
        token: process.env.VRCX_LOG_STREAM_TOKEN || '',
        logDir: process.env.VRCX_LOG_DIR || '',
        machineId: process.env.VRCX_LOG_STREAM_MACHINE_ID || os.hostname(),
        stateFile: process.env.VRCX_LOG_STREAM_STATE || '',
        batchSize: DEFAULT_BATCH_SIZE,
        pollMs: DEFAULT_POLL_MS,
        tailBytes: DEFAULT_TAIL_BYTES,
        historyMode: process.env.VRCX_LOG_STREAM_HISTORY || 'ask',
        historyMaxDays: DEFAULT_HISTORY_MAX_DAYS,
        historyMaxFiles: DEFAULT_HISTORY_MAX_FILES,
        launchVrchat: process.env.VRCX_LOG_STREAM_NO_LAUNCH !== '1',
        vrchatExe: process.env.VRCX_VRCHAT_EXE || '',
        steamAppId: process.env.VRCX_VRCHAT_STEAM_APP_ID || DEFAULT_VRCHAT_STEAM_APP_ID,
        exitWithVrchat: process.env.VRCX_LOG_STREAM_EXIT_WITH_VRCHAT !== '0',
        vrchatExitGraceMs: 30000,
        singleInstance: process.env.VRCX_LOG_STREAM_SINGLE_INSTANCE !== '0',
        _explicit: new Set()
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const readValue = () => {
            if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
            i += 1;
            return argv[i] || '';
        };
        const setArg = (key, value) => {
            args[key] = value;
            args._explicit.add(key);
        };
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg.startsWith('--config')) setArg('configFile', readValue());
        else if (arg.startsWith('--server')) setArg('server', readValue());
        else if (arg.startsWith('--token')) setArg('token', readValue());
        else if (arg.startsWith('--log-dir')) setArg('logDir', readValue());
        else if (arg.startsWith('--machine-id')) setArg('machineId', readValue());
        else if (arg.startsWith('--state-file')) setArg('stateFile', readValue());
        else if (arg.startsWith('--batch-size')) setArg('batchSize', Number(readValue()));
        else if (arg.startsWith('--poll-ms')) setArg('pollMs', Number(readValue()));
        else if (arg.startsWith('--tail-bytes')) setArg('tailBytes', Number(readValue()));
        else if (arg.startsWith('--history-mode')) setArg('historyMode', readValue());
        else if (arg.startsWith('--history-max-days')) setArg('historyMaxDays', Number(readValue()));
        else if (arg.startsWith('--history-max-files')) setArg('historyMaxFiles', Number(readValue()));
        else if (arg === '--from-start') setArg('historyMode', 'backfill');
        else if (arg === '--skip-history') setArg('historyMode', 'skip');
        else if (arg === '--no-launch-vrchat') setArg('launchVrchat', false);
        else if (arg.startsWith('--vrchat-exe')) setArg('vrchatExe', readValue());
        else if (arg.startsWith('--steam-app-id')) setArg('steamAppId', readValue());
        else if (arg === '--no-exit-with-vrchat') setArg('exitWithVrchat', false);
        else if (arg.startsWith('--exit-grace-ms')) setArg('vrchatExitGraceMs', Number(readValue()));
        else if (arg === '--no-single-instance') setArg('singleInstance', false);
    }
    return args;
}

function printHelp() {
    console.log(`VRCX log streamer

Usage:
  vrcx-log-streamer.exe --server http://192.168.10.209:18080 --token TOKEN

Options:
  --server URL       Headless backend URL, for example http://192.168.10.209:18080
  --token TOKEN      Log stream token from /headless/log-stream/token
  --config PATH      JSON config file. Defaults to vrcx-log-streamer.config.json next to the exe
  --log-dir PATH     VRChat log directory. Defaults to %USERPROFILE%\\AppData\\LocalLow\\VRChat\\VRChat
  --machine-id ID    Stable client id. Defaults to hostname
  --state-file PATH  Checkpoint file path
  --history-mode M   ask, skip, backfill, or tail. Defaults to ask
  --from-start       Alias for --history-mode backfill
  --skip-history     Alias for --history-mode skip
  --no-launch-vrchat Do not launch VRChat; only run the streamer
  --vrchat-exe PATH  Launch this VRChat.exe instead of Steam URI
  --steam-app-id ID  Steam app id to launch. Defaults to 438100
  --no-exit-with-vrchat Keep streamer running after VRChat exits
  --exit-grace-ms N  Milliseconds to wait before exiting after VRChat closes
  --no-single-instance Allow multiple streamer processes
`);
}

function defaultConfigFile() {
    const exeDir = path.dirname(process.execPath || process.argv[1] || process.cwd());
    const exeConfig = path.join(exeDir, 'vrcx-log-streamer.config.json');
    if (fs.existsSync(exeConfig)) return exeConfig;
    const cwdConfig = path.join(process.cwd(), 'vrcx-log-streamer.config.json');
    if (fs.existsSync(cwdConfig)) return cwdConfig;
    return exeConfig;
}

function loadConfig(file) {
    if (!file || !fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to read config file ${file}: ${err.message}`);
    }
}

function applyConfig(args, config) {
    const aliases = {
        headlessUrl: 'server',
        url: 'server',
        authToken: 'token',
        streamerToken: 'token',
        vrchatPath: 'vrchatExe',
        exitGraceMs: 'vrchatExitGraceMs'
    };
    for (const [rawKey, value] of Object.entries(config || {})) {
        const key = aliases[rawKey] || rawKey;
        if (key === '_explicit' || args._explicit.has(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
        args[key] = value;
    }
}

function acquireSingleInstanceLock(machineId) {
    const lockPath = path.join(os.tmpdir(), `vrcx-log-streamer-${machineId}.lock`);
    let fd;
    try {
        fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, String(process.pid));
    } catch {
        try {
            const pid = Number(fs.readFileSync(lockPath, 'utf8'));
            if (pid > 0) {
                process.kill(pid, 0);
                return null;
            }
        } catch {
            // stale lock
        }
        try {
            fs.unlinkSync(lockPath);
            fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, String(process.pid));
        } catch {
            return null;
        }
    }
    return () => {
        try {
            if (fd !== undefined) fs.closeSync(fd);
        } catch {
            // ignored
        }
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // ignored
        }
    };
}

function defaultLogDir() {
    if (process.platform === 'win32') {
        const profile = process.env.USERPROFILE || os.homedir();
        return path.join(profile, 'AppData', 'LocalLow', 'VRChat', 'VRChat');
    }
    if (process.platform === 'darwin') {
        return path.join(
            os.homedir(),
            'Library',
            'Application Support',
            'com.vrchat.VRChat'
        );
    }
    return path.join(os.homedir(), '.config', 'unity3d', 'VRChat', 'VRChat');
}

function defaultStateFile(machineId) {
    const dir =
        process.platform === 'win32'
            ? path.join(process.env.APPDATA || os.homedir(), 'VRCX-LogStreamer')
            : path.join(os.homedir(), '.vrcx-log-streamer');
    return path.join(dir, `${machineId}.json`);
}

function loadState(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { files: {} };
    }
}

function saveState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function normalizeServer(server) {
    if (!server) throw new Error('--server is required');
    const url = new URL(server);
    url.search = '';
    url.hash = '';
    const basePath = url.pathname.replace(/\/+$/, '');
    const httpBase = `${url.origin}${basePath}`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${basePath}/headless/log-stream/ws`;
    return {
        httpBase,
        wsBase: url.toString()
    };
}

function postJson(url, token, body) {
    const payload = JSON.stringify(body || {});
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request(
            parsed,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        return;
                    }
                    resolve(data ? JSON.parse(data) : {});
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(String(answer || '').trim());
        });
    });
}

function startDetached(command, args, options = {}) {
    const child = childProcess.spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...options
    });
    child.unref();
}

function launchVrchat(args) {
    if (!args.launchVrchat) return;
    if (args.vrchatExe) {
        console.log(`Launching VRChat: ${args.vrchatExe}`);
        startDetached(args.vrchatExe, []);
        return;
    }
    const steamUri = `steam://rungameid/${args.steamAppId || DEFAULT_VRCHAT_STEAM_APP_ID}`;
    console.log(`Launching VRChat through Steam: ${steamUri}`);
    if (process.platform === 'win32') {
        startDetached('cmd.exe', ['/c', 'start', '""', steamUri]);
        return;
    }
    if (process.platform === 'darwin') {
        startDetached('open', [steamUri]);
        return;
    }
    startDetached('xdg-open', [steamUri]);
}

function isVrchatRunning() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            childProcess.exec(
                'tasklist /FI "IMAGENAME eq VRChat.exe" /NH',
                { windowsHide: true, timeout: 5000 },
                (err, stdout) => {
                    if (err) {
                        resolve(false);
                        return;
                    }
                    resolve(/\bVRChat\.exe\b/i.test(stdout));
                }
            );
            return;
        }
        childProcess.exec('pgrep -f VRChat', { timeout: 5000 }, (err, stdout) => {
            resolve(!err && !!String(stdout || '').trim());
        });
    });
}

function logFiles(logDir) {
    try {
        return fs
            .readdirSync(logDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^output_log_.*\.txt$/i.test(entry.name))
            .map((entry) => {
                const filePath = path.join(logDir, entry.name);
                const stat = fs.statSync(filePath);
                return {
                    name: entry.name,
                    path: filePath,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    birthtimeMs: stat.birthtimeMs || stat.mtimeMs
                };
            })
            .sort((a, b) => a.birthtimeMs - b.birthtimeMs || a.name.localeCompare(b.name));
    } catch (err) {
        throw new Error(`Cannot read VRChat log directory: ${logDir}: ${err.message}`);
    }
}

function eligibleHistoryFiles(files, args) {
    const now = Date.now();
    let result = files;
    if (Number.isFinite(args.historyMaxDays) && args.historyMaxDays > 0) {
        const cutoff = now - args.historyMaxDays * 24 * 60 * 60 * 1000;
        result = result.filter((file) => file.mtimeMs >= cutoff);
    }
    if (Number.isFinite(args.historyMaxFiles) && args.historyMaxFiles > 0) {
        result = result.slice(-args.historyMaxFiles);
    }
    return new Set(result.map((file) => file.name));
}

function logTimeToIso(line) {
    const value = line.slice(0, 19);
    const match = value.match(
        /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
    );
    if (!match) return '';
    const [, year, month, day, hour, minute, second] = match;
    const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        0
    );
    return date.toISOString();
}

function parseUserInfo(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(.*)\s+\((usr_[0-9a-f-]+)\)$/i);
    if (match) {
        return {
            displayName: match[1].trim(),
            userId: match[2]
        };
    }
    return {
        displayName: text,
        userId: ''
    };
}

function cleanLocation(value) {
    return String(value || '').replace(/\//g, '');
}

function parseLine(fileName, line, context) {
    if (!line || line.length <= 36 || line[31] !== '-') return null;
    const loggedAt = logTimeToIso(line);
    if (!loggedAt) return null;

    if (line.includes('[Behaviour] Entering Room: ')) {
        const index = line.lastIndexOf('] Entering Room: ');
        if (index >= 0) context.recentWorldName = line.slice(index + 17);
        return null;
    }

    if (
        line.includes('[Behaviour] Joining ') &&
        !line.includes('] Joining or Creating Room: ') &&
        !line.includes('] Joining friend: ')
    ) {
        const index = line.lastIndexOf('] Joining ');
        if (index < 0) return null;
        const location = cleanLocation(line.slice(index + 10));
        return rawEvent(fileName, loggedAt, 'location', [location, context.recentWorldName || ''], line);
    }

    if (line.includes('[Behaviour] OnLeftRoom')) {
        const destination = context.locationDestination || '';
        context.locationDestination = '';
        return rawEvent(fileName, loggedAt, 'location-destination', [destination], line);
    }

    if (line.includes('[Behaviour] Destination fetching: ')) {
        const index = line.lastIndexOf('] Destination fetching: ');
        if (index >= 0) {
            context.locationDestination = cleanLocation(line.slice(index + 24));
        }
        return null;
    }

    if (
        line.includes('[Behaviour] OnPlayerJoined') &&
        !line.includes('] OnPlayerJoined:')
    ) {
        const index = line.lastIndexOf('] OnPlayerJoined');
        if (index < 0) return null;
        const user = parseUserInfo(line.slice(index + 17));
        if (!user.displayName && !user.userId) return null;
        return rawEvent(
            fileName,
            loggedAt,
            'player-joined',
            [user.displayName, user.userId],
            line
        );
    }

    if (
        line.includes('[Behaviour] OnPlayerLeft') &&
        !line.includes('] OnPlayerLeftRoom') &&
        !line.includes('] OnPlayerLeft:')
    ) {
        const index = line.lastIndexOf('] OnPlayerLeft');
        if (index < 0) return null;
        const user = parseUserInfo(line.slice(index + 15));
        if (!user.displayName && !user.userId) return null;
        return rawEvent(
            fileName,
            loggedAt,
            'player-left',
            [user.displayName, user.userId],
            line
        );
    }

    if (
        line.includes('[Behaviour] Instantiated a (Clone [') &&
        line.includes('] Portals/PortalInternalDynamic)')
    ) {
        return rawEvent(fileName, loggedAt, 'portal-spawn', [], line);
    }

    if (line.includes('Maximum number (384) of shader global keywords exceeded')) {
        if (context.shaderKeywordsLimitReached) return null;
        context.shaderKeywordsLimitReached = true;
        return rawEvent(
            fileName,
            loggedAt,
            'event',
            ['Shader Keyword Limit has been reached'],
            line
        );
    }

    if (line.includes('[VRC Camera] Took screenshot to: ')) {
        const index = line.lastIndexOf('] Took screenshot to: ');
        if (index < 0) return null;
        return rawEvent(fileName, loggedAt, 'screenshot', [line.slice(index + 22)], line);
    }

    return null;
}

function rawEvent(fileName, loggedAt, type, args, rawLine) {
    return {
        loggedAt,
        parsed: {
            type,
            args
        },
        rawLog: [fileName, loggedAt, type, ...args],
        raw: rawLine
    };
}

async function readLines(file, startOffset, onLine) {
    let offset = startOffset;
    const stream = fs.createReadStream(file.path, {
        encoding: 'utf8',
        start: startOffset
    });
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
    });
    for await (const line of rl) {
        const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
        offset += lineBytes;
        await onLine(line, offset);
    }
    return offset;
}

class Streamer {
    constructor(args) {
        this.args = args;
        this.urls = normalizeServer(args.server);
        this.logDir = args.logDir || defaultLogDir();
        this.stateFile = args.stateFile || defaultStateFile(args.machineId);
        this.state = loadState(this.stateFile);
        this.contexts = new Map();
        this.readOffsets = new Map();
        this.pending = [];
        this.inflight = new Map();
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.stopped = false;
        this.lastHeartbeat = 0;
        this.historyMode = String(args.historyMode || 'ask').toLowerCase();
        this.historyEligible = new Set();
        this.vrchatSeenRunning = false;
        this.vrchatLastSeenAt = 0;
    }

    async start() {
        if (!this.args.token) throw new Error('--token is required');
        console.log(`Log directory: ${this.logDir}`);
        console.log(`State file: ${this.stateFile}`);
        await this.resolveHistoryMode();
        launchVrchat(this.args);
        await this.openSession();
        this.connect();
        this.loop();
    }

    async resolveHistoryMode() {
        const files = logFiles(this.logDir);
        const uninitialized = files.filter(
            (file) => !this.state.files[file.name]?.initialized
        );
        this.historyEligible = eligibleHistoryFiles(uninitialized, this.args);
        if (!uninitialized.length) return;

        if (!['ask', 'skip', 'backfill', 'tail'].includes(this.historyMode)) {
            this.historyMode = 'ask';
        }
        if (this.historyMode === 'ask') {
            if (!process.stdin.isTTY) {
                this.historyMode = 'skip';
            } else {
                console.log(
                    `Found ${uninitialized.length} VRChat log file(s) not in streamer checkpoint.`
                );
                console.log(
                    `Backfill is limited defensively to the latest ${this.args.historyMaxFiles} file(s) and ${this.args.historyMaxDays} day(s) unless overridden.`
                );
                const answer = await askQuestion(
                    'Upload historical logs now? [b]ackfill / [t]ail last chunk / [s]kip old logs (default s): '
                );
                if (/^b/i.test(answer)) this.historyMode = 'backfill';
                else if (/^t/i.test(answer)) this.historyMode = 'tail';
                else this.historyMode = 'skip';
            }
        }
        console.log(`History mode: ${this.historyMode}`);
    }

    async openSession() {
        await postJson(
            `${this.urls.httpBase}/headless/log-stream/session`,
            this.args.token,
            {
                machineId: this.args.machineId
            }
        );
    }

    connect() {
        if (this.connecting || this.connected || this.stopped) return;
        this.connecting = true;
        const wsUrl = new URL(this.urls.wsBase);
        wsUrl.searchParams.set('machineId', this.args.machineId);
        wsUrl.searchParams.set('token', this.args.token);
        const ws = new WebSocket(wsUrl.toString(), {
            handshakeTimeout: 15000
        });
        this.ws = ws;
        ws.on('open', () => {
            this.connecting = false;
            this.connected = true;
            console.log('Connected to headless backend');
            this.send({
                type: 'hello',
                machineId: this.args.machineId
            });
            this.flush();
        });
        ws.on('message', (data) => {
            this.handleMessage(data.toString('utf8'));
        });
        ws.on('close', () => {
            if (this.connected) console.log('Disconnected from headless backend');
            this.connected = false;
            this.connecting = false;
            this.ws = null;
            setTimeout(() => this.connect(), 5000).unref?.();
        });
        ws.on('error', (err) => {
            this.connecting = false;
            if (!this.connected) console.error(`Connect failed: ${err.message}`);
        });
    }

    async loop() {
        while (!this.stopped) {
            try {
                const running = await isVrchatRunning();
                if (running) {
                    this.vrchatSeenRunning = true;
                    this.vrchatLastSeenAt = Date.now();
                }
                if (!this.args.launchVrchat || running || this.vrchatSeenRunning) {
                    await this.scan();
                }
                this.flush();
                this.heartbeat();
                if (
                    this.args.exitWithVrchat &&
                    this.vrchatSeenRunning &&
                    !running &&
                    Date.now() - this.vrchatLastSeenAt > this.args.vrchatExitGraceMs
                ) {
                    console.log('VRChat exited; stopping log streamer');
                    this.stopped = true;
                    if (this.ws) this.ws.close();
                    break;
                }
            } catch (err) {
                console.error(err.message || err);
            }
            await new Promise((resolve) => setTimeout(resolve, this.args.pollMs));
        }
    }

    async scan() {
        const files = logFiles(this.logDir);
        for (const file of files) {
            const saved = this.state.files[file.name] || {};
            let offset = this.readOffsets.has(file.name)
                ? this.readOffsets.get(file.name)
                : Number(saved.offset || 0);
            if (!saved.initialized) {
                if (this.historyMode === 'backfill' && this.historyEligible.has(file.name)) {
                    offset = 0;
                } else if (this.historyMode === 'tail' && this.historyEligible.has(file.name)) {
                    offset = Math.max(0, file.size - this.args.tailBytes);
                } else {
                    offset = file.size;
                }
                this.state.files[file.name] = {
                    ...saved,
                    offset,
                    initialized: true
                };
                saveState(this.stateFile, this.state);
            }
            if (file.size < offset) offset = 0;
            if (file.size <= offset) continue;
            const context = this.contexts.get(file.name) || {};
            this.contexts.set(file.name, context);
            const finalOffset = await readLines(file, offset, async (line, nextOffset) => {
                const event = parseLine(file.name, line, context);
                if (!event) return;
                event.file = file.name;
                event.offset = nextOffset;
                event.clientEventId = crypto
                    .createHash('sha256')
                    .update(
                        JSON.stringify([
                            this.args.machineId,
                            file.name,
                            nextOffset,
                            event.raw
                        ])
                    )
                    .digest('hex');
                this.pending.push(event);
            });
            this.readOffsets.set(file.name, finalOffset);
        }
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(payload));
        return true;
    }

    flush() {
        if (!this.connected || !this.pending.length) return;
        while (this.pending.length) {
            const events = this.pending.splice(0, this.args.batchSize);
            const batchId = crypto.randomUUID();
            this.inflight.set(batchId, events);
            if (
                !this.send({
                    type: 'events',
                    batchId,
                    machineId: this.args.machineId,
                    events
                })
            ) {
                this.pending.unshift(...events);
                this.inflight.delete(batchId);
                return;
            }
        }
    }

    heartbeat() {
        if (!this.connected || Date.now() - this.lastHeartbeat < 15000) return;
        this.lastHeartbeat = Date.now();
        this.send({
            type: 'heartbeat',
            machineId: this.args.machineId
        });
    }

    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.type === 'ack') {
            const events = this.inflight.get(message.batchId) || [];
            this.inflight.delete(message.batchId);
            for (const [fileName, offset] of Object.entries(message.checkpoints || {})) {
                const fileState = this.state.files[fileName] || {};
                fileState.offset = Math.max(Number(fileState.offset || 0), Number(offset || 0));
                fileState.initialized = true;
                this.state.files[fileName] = fileState;
                this.readOffsets.set(
                    fileName,
                    Math.max(Number(this.readOffsets.get(fileName) || 0), fileState.offset)
                );
            }
            saveState(this.stateFile, this.state);
            console.log(
                `Ack ${message.batchId}: accepted=${message.accepted || 0} duplicate=${message.duplicate || 0} failed=${message.failed || 0} events=${events.length}`
            );
        } else if (message.type === 'error') {
            console.error(`Server error: ${message.error}`);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        return;
    }
    const configFile = args.configFile || defaultConfigFile();
    applyConfig(args, loadConfig(configFile));
    args.configFile = configFile;
    if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
        args.batchSize = DEFAULT_BATCH_SIZE;
    }
    if (!Number.isFinite(args.pollMs) || args.pollMs < 250) {
        args.pollMs = DEFAULT_POLL_MS;
    }
    if (!Number.isFinite(args.tailBytes) || args.tailBytes < 0) {
        args.tailBytes = DEFAULT_TAIL_BYTES;
    }
    if (!Number.isFinite(args.historyMaxDays) || args.historyMaxDays < 0) {
        args.historyMaxDays = DEFAULT_HISTORY_MAX_DAYS;
    }
    if (!Number.isFinite(args.historyMaxFiles) || args.historyMaxFiles < 0) {
        args.historyMaxFiles = DEFAULT_HISTORY_MAX_FILES;
    }
    if (!Number.isFinite(args.vrchatExitGraceMs) || args.vrchatExitGraceMs < 0) {
        args.vrchatExitGraceMs = 30000;
    }
    let releaseLock = null;
    if (args.singleInstance) {
        releaseLock = acquireSingleInstanceLock(args.machineId);
        if (!releaseLock) {
            console.log('Another VRCX log streamer process is already running; exiting.');
            return;
        }
    }
    const streamer = new Streamer(args);
    console.log(`Config file: ${args.configFile}`);
    const shutdown = () => {
        streamer.stopped = true;
        releaseLock?.();
        process.exit(0);
    };
    process.on('SIGINT', () => {
        shutdown();
    });
    process.on('SIGTERM', () => {
        shutdown();
    });
    await streamer.start();
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
