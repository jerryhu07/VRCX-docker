const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Streamer, readLines, parseArgs } = require('./log-streamer');
const { WebSocketServer } = require('ws');
const { once } = require('node:events');

test('byte checkpoints preserve CRLF, UTF-8 and incomplete final lines across scans', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-stream-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'output_log_test.txt');
    const first = '\u4e2d\u6587\r\nsecond\n';
    fs.writeFileSync(filePath, first + 'partial');
    const file = () => ({ path: filePath, size: fs.statSync(filePath).size });
    const lines = [];
    let offset = await readLines(file(), 0, (line) => lines.push(line));
    assert.equal(offset, Buffer.byteLength(first));
    assert.deepEqual(lines, ['\u4e2d\u6587', 'second']);
    for (let i = 0; i < 3; i++) {
        assert.equal(
            await readLines(file(), offset, () => assert.fail('replayed line')),
            offset
        );
    }
    fs.appendFileSync(filePath, ' complete\r\n');
    offset = await readLines(file(), offset, (line) => lines.push(line));
    assert.equal(offset, file().size);
    assert.equal(lines.at(-1), 'partial complete');
});

test('new logs read from start and checkpoints pass non-events only after acknowledgement', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-stream-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const args = {
        ...parseArgs([]),
        server: 'http://localhost',
        logDir: dir,
        stateFile: path.join(dir, 'state.json'),
        historyMode: 'skip'
    };
    const streamer = new Streamer(args);
    await streamer.resolveHistoryMode();
    const name = 'output_log_new.txt';
    const line =
        '2026.09.23 00:00:00 Debug      -  [Behaviour] OnPlayerJoined Alice (usr_11111111-1111-1111-1111-111111111111)\r\n';
    const content = line + 'uninteresting\r\nunfinished';
    fs.writeFileSync(path.join(dir, name), content);
    await streamer.scan();
    assert.equal(streamer.pending.length, 1);
    assert.equal(streamer.pending[0].offset, Buffer.byteLength(line));
    assert.equal(streamer.state.files[name].offset, 0);
    streamer.inflight.set('batch', streamer.pending.splice(0));
    streamer.handleMessage(
        JSON.stringify({
            type: 'ack',
            batchId: 'batch',
            duplicate: 1,
            checkpoints: { [name]: Buffer.byteLength(line) }
        })
    );
    assert.equal(
        streamer.state.files[name].offset,
        Buffer.byteLength(content) - 'unfinished'.length
    );
    await streamer.scan();
    assert.equal(streamer.pending.length, 0);
    const restarted = new Streamer(args);
    await restarted.scan();
    assert.equal(restarted.pending.length, 0);
});

test('disconnect before ACK resends the same event and keeps only one batch in flight', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-stream-test-'));
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const streamer = new Streamer({
        ...parseArgs([]),
        server: `http://127.0.0.1:${server.address().port}`,
        stateFile: path.join(dir, 'state.json'),
        batchSize: 1
    });
    t.after(() => {
        streamer.stopped = true;
        streamer.ws?.terminate();
        for (const socket of server.clients) socket.terminate();
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    streamer.pending = [
        { file: 'log', offset: 10, clientEventId: 'first' },
        { file: 'log', offset: 20, clientEventId: 'second' }
    ];
    const seen = [];
    const completed = new Promise((resolve) => {
        server.on('connection', (socket) =>
            socket.on('message', (raw) => {
                const message = JSON.parse(raw);
                if (message.type !== 'events') return;
                seen.push(message.events[0].clientEventId);
                assert.equal(streamer.inflight.size, 1);
                if (seen.length === 1) {
                    streamer.ws.once('close', () => streamer.connect());
                    socket.terminate();
                    return;
                }
                socket.send(
                    JSON.stringify({
                        type: 'ack',
                        batchId: message.batchId,
                        checkpoints: { log: message.events[0].offset }
                    })
                );
                if (seen.length === 3) resolve();
            })
        );
    });
    streamer.connect();
    await completed;
    assert.deepEqual(seen, ['first', 'first', 'second']);
});
