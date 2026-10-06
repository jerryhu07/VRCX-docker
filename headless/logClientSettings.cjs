function validateLogClientSettings(input) {
    const fail = (key) => { throw Object.assign(new Error(`Invalid log client setting: ${key}`), { status: 400 }); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('configuration');
    const output = {};
    const strings = { server: 2048, machineId: 128, logDir: 2048, stateFile: 2048 };
    const numbers = { batchSize: [1, 1000], pollMs: [250, 60000], tailBytes: [0, 67108864],
        historyMaxDays: [0, 3650], historyMaxFiles: [0, 10000], vrchatExitGraceMs: [0, 300000] };
    for (const [key, value] of Object.entries(input)) {
        if (Object.hasOwn(strings, key)) {
            if (typeof value !== 'string' || value.length > strings[key] || /[\x00-\x1f"]/.test(value)) fail(key);
            output[key] = value.trim();
            if (key === 'server') {
                try {
                    const url = new URL(value);
                    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(key);
                } catch { fail(key); }
            }
            if (key === 'machineId' && !/^[a-zA-Z0-9_.-]+$/.test(output[key])) fail(key);
        } else if (Object.hasOwn(numbers, key)) {
            const [min, max] = numbers[key];
            if (!Number.isInteger(value) || value < min || value > max) fail(key);
            output[key] = value;
        } else if (key === 'historyMode') {
            if (!['ask', 'skip', 'backfill', 'tail'].includes(value)) fail(key);
            output[key] = value;
        } else if (['exitWithVrchat', 'singleInstance'].includes(key)) {
            if (typeof value !== 'boolean') fail(key);
            output[key] = value;
        } else fail(key);
    }
    return output;
}
module.exports = { validateLogClientSettings };
