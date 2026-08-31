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

export function getWatchList(userId = '') {
    const params = new URLSearchParams({ limit: '300' });
    if (userId) params.set('userId', userId);
    return request(`/headless/watch-list?${params}`);
}

export function addWatchUser(userId, intervalMs) {
    return request('/headless/watch-list/add', {
        method: 'POST',
        body: { userId, intervalMs }
    });
}

export function updateWatchUser(userId, values) {
    return request('/headless/watch-list/update', {
        method: 'POST',
        body: { userId, ...values }
    });
}

export function removeWatchUser(userId) {
    return request('/headless/watch-list/remove', {
        method: 'POST',
        body: { userId }
    });
}

export function pollWatchUser(userId) {
    return request('/headless/watch-list/poll', {
        method: 'POST',
        body: { userId }
    });
}
