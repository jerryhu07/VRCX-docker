import { expect, test } from 'vitest';
import { isLogClientOnline, latestLogClient, updateLogStreamState, logStreamState } from '../logStreamClient';
test('online indicator expires without heartbeats and keeps unknown distinct from disabled', () => {
    const now = Date.now();
    const client = { machineId: 'windows', connected: true, lastSeenAt: new Date(now).toISOString(), debugLoggingEnabled: null };
    updateLogStreamState({ logStream: { clients: [client], tokenConfigured: true } });
    expect(latestLogClient()).toEqual(client);
    expect(isLogClientOnline(client, now)).toBe(true);
    expect(isLogClientOnline(client, now + 45001)).toBe(false);
    expect(logStreamState.clients[0].debugLoggingEnabled).toBeNull();
});
