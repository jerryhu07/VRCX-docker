async function request(path, options = {}) {
    const response = await fetch(path, {
        method: options.method || 'GET',
        headers: options.body
            ? { 'Content-Type': 'application/json' }
            : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || response.statusText);
    }
    return payload;
}

export function getMutualNetworkSnapshots(limit = 90) {
    return request(`/headless/mutual-network/snapshots?limit=${limit}`);
}

export function getMutualNetworkSnapshot(snapshotId) {
    return request(`/headless/mutual-network/snapshots/${snapshotId}`);
}

export function refreshMutualNetwork() {
    return request('/headless/mutual-network/refresh', { method: 'POST' });
}
