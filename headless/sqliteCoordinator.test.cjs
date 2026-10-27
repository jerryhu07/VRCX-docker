const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteCoordinator, browserTransactionOnly } = require('./sqliteCoordinator.cjs');
const { HeadlessSession } = require('./server');

const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcx-sqlite-'));
    const file = path.join(dir, 'test.sqlite3');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT)');
    t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
    const rows = () => {
        const reader = new DatabaseSync(file, { readOnly: true });
        try { return reader.prepare('SELECT label FROM events ORDER BY id').all().map((r) => r.label); }
        finally { reader.close(); }
    };
    return { db, rows };
}

test('reproduces legacy rollback: the shared connection sees a log row that disappears on close', (t) => {
    const { db, rows } = fixture(t);
    db.exec("BEGIN; INSERT INTO events(label) VALUES ('uncommitted collector event')");
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1);
    assert.deepEqual(rows(), []);
    db.close();
    assert.deepEqual(rows(), []);
});

test('rollback cannot absorb an unrelated queued collector write', async (t) => {
    const { db, rows } = fixture(t);
    const queue = new SqliteCoordinator((sql) => db.exec(sql));
    const entered = deferred(), release = deferred();
    const transaction = queue.transaction(async () => {
        await queue.run(() => db.exec("INSERT INTO events(label) VALUES ('temporary cache')"));
        entered.resolve();
        await release.promise;
        throw new Error('cache failed');
    });
    const rejected = assert.rejects(transaction, /cache failed/);
    await entered.promise;
    const collector = queue.run(() => db.exec("INSERT INTO events(label) VALUES ('durable collector event')"));
    assert.deepEqual(rows(), []);
    release.resolve();
    await rejected;
    await collector;
    await queue.close();
    db.close();
    assert.deepEqual(rows(), ['durable collector event']);
});

test('closing drains the complete transaction and earlier queued writes before SQLite can close', async (t) => {
    const { db, rows } = fixture(t);
    const queue = new SqliteCoordinator((sql) => db.exec(sql));
    const entered = deferred(), release = deferred();
    const transaction = queue.transaction(async () => {
        await queue.run(() => db.exec("INSERT INTO events(label) VALUES ('first')"));
        entered.resolve();
        await release.promise;
        await queue.run(() => db.exec("INSERT INTO events(label) VALUES ('second')"));
    });
    await entered.promise;
    const collector = queue.run(() => db.exec("INSERT INTO events(label) VALUES ('queued')"));
    let drained = false;
    const close = queue.close().then(() => { drained = true; });
    await assert.rejects(queue.run(() => db.exec('DELETE FROM events')), /shutting down/);
    assert.equal(drained, false);
    release.resolve();
    await Promise.all([transaction, collector, close]);
    db.close();
    assert.deepEqual(rows(), ['first', 'second', 'queued']);
});

test('rollback failure blocks writes that were already queued as well as new requests', async () => {
    const entered = deferred(), release = deferred();
    const queue = new SqliteCoordinator((sql) => { if (sql === 'ROLLBACK') throw new Error('disk error'); });
    const transaction = queue.transaction(async () => { entered.resolve(); await release.promise; throw new Error('failure'); });
    const rejected = assert.rejects(transaction, /rollback failed/);
    await entered.promise;
    let wrote = false;
    const queued = assert.rejects(queue.run(() => { wrote = true; }), /rollback failed/);
    release.resolve();
    await Promise.all([rejected, queued]);
    await assert.rejects(queue.close(), /rollback failed/);
    assert.equal(wrote, false);
});

test('browser SQL recognizes comments, reader aliases, mixed statements and quoted text', async (t) => {
    const { db, rows } = fixture(t);
    const session = new HeadlessSession({ call: (name, method, args) => {
        assert.equal(name, 'SQLite');
        if (method === 'ExecuteNonQuery') { db.exec(args[0]); return 0; }
        const result = db.prepare(args[0]).all().map(Object.values);
        return method === 'ExecuteJson' ? JSON.stringify(result) : result;
    } });
    for (const sql of ['BEGIN', '/* cache */ BEGIN IMMEDIATE;', '-- cache\nSAVEPOINT x;', 'COMMIT; ROLLBACK;']) {
        assert.equal(browserTransactionOnly(sql), true);
        await session.browserSqliteCall('ExecuteNonQuery', [sql]);
        await session.browserSqliteCall('ExecuteJson', [sql]);
        await session.browserSqliteCall('Execute', [sql]);
    }
    for (const sql of ['SELECT 1; BEGIN', '/* cache */ BEGIN; INSERT INTO events VALUES(1,\'x\')', 'ROLLBACK; SELECT 1']) {
        await assert.rejects(session.browserSqliteCall('ExecuteNonQuery', [sql]), /cannot mix/);
        await assert.rejects(session.browserSqliteCall('ExecuteJson', [sql]), /cannot mix/);
    }
    assert.equal(browserTransactionOnly("SELECT CASE WHEN 1 THEN ';BEGIN' ELSE 'COMMIT' END, \"END\""), false);
    await assert.rejects(session.browserSqliteCall('Exit'), /owned by the backend/);
    await session.browserSqliteCall('ExecuteNonQuery', ["INSERT INTO events(label) VALUES ('saved')"]);
    assert.deepEqual(rows(), ['saved']);
    await session.browserSqliteCall('ExecuteNonQuery', ['ROLLBACK']);
    await session.sqliteCoordinator.close();
    db.close();
    assert.deepEqual(rows(), ['saved']);
});
