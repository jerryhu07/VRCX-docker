import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execute: vi.fn()
}));

vi.mock('../../sqlite.js', () => ({
    default: {
        execute: mocks.execute,
        executeNonQuery: vi.fn()
    }
}));
vi.mock('../index.js', () => ({
    dbVars: {
        maxTableSize: 500,
        userPrefix: '',
        userId: 'usr_self'
    }
}));

import { gameLog } from '../gameLog.js';

describe('gameLog.getMyTopWorlds', () => {
    beforeEach(() => {
        mocks.execute.mockReset();
    });

    test('adds an exclude clause when a home world id is provided', async () => {
        mocks.execute.mockImplementation(async (callback, sql, params) => {
            callback(['wrld_1', 'World One', 3, 9000]);
            return undefined;
        });

        const result = await gameLog.getMyTopWorlds(30, 5, 'time', 'wrld_home');

        expect(result).toEqual([
            {
                worldId: 'wrld_1',
                worldName: 'World One',
                visitCount: 3,
                totalTime: 9000
            }
        ]);
        expect(mocks.execute).toHaveBeenCalledTimes(1);
        expect(mocks.execute.mock.calls[0][1]).toContain(
            'AND world_id != @excludeWorldId'
        );
        expect(mocks.execute.mock.calls[0][2]).toMatchObject({
            '@limit': 5,
            '@daysOffset': '-30 days',
            '@excludeWorldId': 'wrld_home'
        });
    });
});

describe('gameLog.getInstanceActivity', () => {
    beforeEach(() => {
        mocks.execute.mockReset();
    });

    test('detects players already present by self join boundaries', async () => {
        mocks.execute.mockResolvedValue(undefined);

        await gameLog.getInstanceActivity(
            '2026-07-05T00:00:00Z',
            '2026-07-06T00:00:00Z'
        );

        expect(mocks.execute).toHaveBeenCalledTimes(1);
        const [, sql, params] = mocks.execute.mock.calls[0];

        expect(sql).toContain('first_self_join_id');
        expect(sql).toContain('second_self_join_id');
        expect(sql).toContain('joined.id > self.first_self_join_id');
        expect(sql).toContain('joined.id < self.second_self_join_id');
        expect(sql).toContain('left_event.time <= 0');
        expect(sql).toContain('candidate_left.time <= 0');
        expect(sql).toContain("left_event.created_at, '-' || (left_event.time * 1.0 / 1000) || ' seconds'");
        expect(sql).toContain("candidate_left.created_at, '-' || (candidate_left.time * 1.0 / 1000) || ' seconds'");
        expect(sql).not.toContain('initial_join_batches');
        expect(sql).not.toContain('HAVING COUNT(*) >= 3');
        expect(params).toMatchObject({
            '@current_user_id': 'usr_self'
        });
    });
});
