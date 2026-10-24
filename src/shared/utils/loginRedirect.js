export function getLoginRedirect(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
        /[\\\u0000-\u001f]/.test(value) || /^\/login(?:[/?#]|$)/.test(value)) return '/feed';
    return value;
}
