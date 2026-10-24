import { afterEach, expect, test, vi } from 'vitest';
import { effectScope } from 'vue';
import { PORTRAIT_QUERY, usePortraitLayout } from '../usePortraitLayout';

let scope;
afterEach(() => { scope?.stop(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
function size(width, height) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    window.dispatchEvent(new Event('resize'));
}
function setup(width, height) {
    size(width, height);
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { get: () => window.innerHeight > window.innerWidth });
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    scope = effectScope();
    return scope.run(() => usePortraitLayout());
}

test('uses aspect ratio, including wide portraits, narrow landscapes and squares', () => {
    const { isPortrait } = setup(1000, 1400);
    expect(window.matchMedia).toHaveBeenCalledWith(PORTRAIT_QUERY);
    expect(isPortrait.value).toBe(true);
    size(600, 400);
    expect(isPortrait.value).toBe(false);
    size(600, 600);
    expect(isPortrait.value).toBe(false);
    size(390, 844);
    expect(isPortrait.value).toBe(true);
    expect(document.documentElement.dataset.layout).toBe('portrait');
});

test('keyboard resizing cannot flip layout; real width changes still rotate', () => {
    const { isPortrait } = setup(390, 844);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    size(390, 280);
    expect(isPortrait.value).toBe(true);
    input.blur();
    size(390, 300);
    expect(isPortrait.value).toBe(true);
    size(844, 390);
    expect(isPortrait.value).toBe(false);
    size(390, 844);
    expect(isPortrait.value).toBe(true);
});

test('all consumers share one state and dispose their listeners', () => {
    const { isPortrait } = setup(390, 844);
    const another = scope.run(() => usePortraitLayout());
    expect(another.isPortrait).toBe(isPortrait);
    scope.stop();
    size(844, 390);
    expect(isPortrait.value).toBe(true);
});
