const { AsyncLocalStorage } = require('node:async_hooks');

class SqliteCoordinator {
    constructor(boundary) {
        this.boundary = boundary;
        this.context = new AsyncLocalStorage();
        this.tail = Promise.resolve();
        this.closing = false;
        this.failure = null;
    }

    run(operation) {
        if (this.failure) return Promise.reject(this.failure);
        if (this.context.getStore()?.active) return Promise.resolve().then(operation);
        if (this.closing) return Promise.reject(new Error('Database is shutting down'));
        const next = this.tail.then(() => {
            if (this.failure) throw this.failure;
            return operation();
        });
        this.tail = next.catch(() => {});
        return next;
    }

    transaction(operation) {
        if (this.context.getStore()?.active) return Promise.reject(new Error('Nested SQLite transactions are not supported'));
        return this.run(() => {
            const owner = { active: true };
            return this.context.run(owner, async () => {
                try {
                    await this.boundary('BEGIN');
                    try {
                        const result = await operation();
                        await this.boundary('COMMIT');
                        return result;
                    } catch (error) {
                        try { await this.boundary('ROLLBACK'); }
                        catch (rollbackError) {
                            this.closing = true;
                            this.failure = new AggregateError([error, rollbackError], 'SQLite rollback failed; further database requests are blocked');
                            throw this.failure;
                        }
                        throw error;
                    }
                } finally { owner.active = false; }
            });
        });
    }

    async close() {
        this.closing = true;
        await this.tail;
        if (this.failure) throw this.failure;
    }
}

// Inspect statement boundaries without treating quoted text or SQL comments as commands.
function browserTransactionOnly(sql) {
    if (typeof sql !== 'string') throw Object.assign(new Error('SQL must be a string'), { status: 400 });
    const statements = [];
    let first = null;
    for (let i = 0; i < sql.length;) {
        const c = sql[i];
        if (/\s/.test(c)) { i++; continue; }
        if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
        if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
        if (c === ';') { if (first) statements.push(first); first = null; i++; continue; }
        if (c === "'" || c === '"' || c === '`' || c === '[') {
            first ||= 'QUOTED';
            const end = c === '[' ? ']' : c;
            i++;
            while (i < sql.length) {
                if (sql[i++] !== end) continue;
                if (c !== '[' && sql[i] === end) { i++; continue; }
                break;
            }
            continue;
        }
        const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
        first ||= word ? word.toUpperCase() : 'OTHER';
        i += word?.length || 1;
    }
    if (first) statements.push(first);
    const boundaries = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
    const controls = statements.filter((word) => boundaries.has(word));
    if (controls.length && controls.length !== statements.length) {
        throw Object.assign(new Error('Browser SQL cannot mix transaction commands with database operations'), { status: 400 });
    }
    return controls.length > 0;
}

module.exports = { SqliteCoordinator, browserTransactionOnly };
