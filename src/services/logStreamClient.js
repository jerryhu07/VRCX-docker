import { reactive } from 'vue';

export const logStreamState = reactive({ clients: [], tokenConfigured: false, initialized: false });
export function updateLogStreamState(state) {
    if (!state?.logStream) return;
    logStreamState.clients = state.logStream.clients || [];
    logStreamState.tokenConfigured = !!state.logStream.tokenConfigured;
    logStreamState.initialized = true;
}

export function latestLogClient(clients = logStreamState.clients) {
    return [...clients].filter((client) => client.machineId !== 'codex-smoke')
        .sort((a, b) => (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0))[0];
}

export function isLogClientOnline(client, now = Date.now()) {
    return !!client?.connected && now - (Date.parse(client.lastSeenAt) || 0) < 45000;
}
