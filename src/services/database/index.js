import schemas from '../../../headless/schema.json';
import { activityV2 } from './activityV2.js';
import { avatarFavorites } from './avatarFavorites.js';
import { avatarTags } from './avatarTags.js';
import { feed } from './feed.js';
import { friendFavorites } from './friendFavorites.js';
import { friendLogCurrent } from './friendLogCurrent.js';
import { friendLogHistory } from './friendLogHistory.js';
import { gameLog } from './gameLog.js';
import { memos } from './memos.js';
import { moderation } from './moderation.js';
import { mutualGraph } from './mutualGraph.js';
import { notifications } from './notifications.js';
import { tableAlter } from './tableAlter.js';
import { tableFixes } from './tableFixes.js';
import { tableSize } from './tableSize.js';
import { worldFavorites } from './worldFavorites.js';

import sqliteService from '../sqlite.js';

const dbVars = {
    userId: '',
    userPrefix: '',
    maxTableSize: 500,
    searchTableSize: 5000
};

const database = {
    ...feed,
    ...activityV2,
    ...gameLog,
    ...notifications,
    ...moderation,
    ...friendLogHistory,
    ...friendLogCurrent,
    ...memos,
    ...avatarFavorites,
    ...avatarTags,
    ...friendFavorites,
    ...worldFavorites,
    ...tableAlter,
    ...tableFixes,
    ...tableSize,
    ...mutualGraph,

    setMaxTableSize(limit) {
        dbVars.maxTableSize = limit;
    },

    setSearchTableSize(limit) {
        dbVars.searchTableSize = limit;
    },

    async initUserTables(userId) {
        dbVars.userId = userId;
        dbVars.userPrefix = userId.replaceAll('-', '').replaceAll('_', '');
        if (/^\d/.test(dbVars.userPrefix)) dbVars.userPrefix = '_' + dbVars.userPrefix;
        if (typeof window !== 'undefined' && window.__VRCX_HEADLESS__) return;
        for (const sql of schemas.user) await sqliteService.executeNonQuery(sql.replaceAll('__USER_PREFIX__', dbVars.userPrefix));
        const columns = [];
        await sqliteService.execute((row) => columns.push(row[1]), `PRAGMA table_info(${dbVars.userPrefix}_feed_bio)`);
        for (const column of ['bio_links', 'previous_bio_links']) {
            if (!columns.includes(column)) await sqliteService.executeNonQuery(`ALTER TABLE ${dbVars.userPrefix}_feed_bio ADD COLUMN ${column} TEXT DEFAULT '[]'`);
        }
    },

    async initTables() {
        if (typeof window !== 'undefined' && window.__VRCX_HEADLESS__) return;
        for (const sql of schemas.global) await sqliteService.executeNonQuery(sql);
    },

    begin() {
        sqliteService.executeNonQuery('BEGIN');
    },

    commit() {
        sqliteService.executeNonQuery('COMMIT');
    },

    async vacuum() {
        await sqliteService.executeNonQuery('VACUUM');
    },

    async optimize() {
        await sqliteService.executeNonQuery('PRAGMA optimize');
    }
};

window.database = database;
export { database, dbVars };
