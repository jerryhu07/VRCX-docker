import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../sqlite.js', () => ({ default: { execute: mocks.execute } }));
vi.mock('../index.js', () => ({ dbVars: { userPrefix: 'usrme', maxTableSize: 500, searchTableSize: 500 } }));
import { feed } from '../feed.js';

let db;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE usrme_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT,
        user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT, bio_links TEXT, previous_bio_links TEXT);
        INSERT INTO usrme_feed_bio VALUES (1,'2026-10-06','usr_alice','Alice','','','["https://new.example"]','["https://old.example"]');`);
    mocks.execute.mockImplementation(async (callback, sql, args) => {
        // The native bridge accepts extra named parameters, SQLite's Node API does not.
        const used = Object.fromEntries(Object.entries(args).filter(([key]) => sql.includes(key)));
        db.prepare(sql).all(used).forEach((row) => callback(Object.values(row)));
    });
});
afterEach(() => db.close());

test('feed lookup and searches return current and previous bio links from real SQL', async () => {
    const lookup = await feed.lookupFeedDatabase(['Bio'], []);
    expect(lookup[0].bioLinks).toEqual(['https://new.example']);
    expect(lookup[0].previousBioLinks).toEqual(['https://old.example']);
    expect(await feed.searchFeedDatabase('old.example', ['Bio'], [])).toHaveLength(1);
    db.exec("UPDATE usrme_feed_bio SET bio_links='broken',previous_bio_links=NULL");
    const legacy = await feed.lookupFeedDatabase(['Bio'], []);
    expect(legacy[0].bioLinks).toEqual([]);
    expect(legacy[0].previousBioLinks).toEqual([]);
});
