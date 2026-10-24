import { createSharedComposable, useEventListener } from '@vueuse/core';
import { onScopeDispose, readonly, ref } from 'vue';

// The aspect-ratio clause excludes square viewports, which orientation alone includes.
export const PORTRAIT_QUERY = '(orientation: portrait) and (aspect-ratio < 1/1)';

export const usePortraitLayout = createSharedComposable(() => {
    const isPortrait = ref(false);
    if (typeof window === 'undefined' || !window.matchMedia) return { isPortrait: readonly(isPortrait) };
    const query = window.matchMedia(PORTRAIT_QUERY);
    const root = document.documentElement;
    let width = window.innerWidth;
    let keyboardReferenceHeight = 0;
    let initialized = false;
    let blurFrame;
    const previousLayout = root.dataset.layout;
    const previousHeight = root.style.getPropertyValue('--app-viewport-height');

    const update = () => {
        const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
        const sameWidth = Math.abs(window.innerWidth - width) < 1;
        const keyboardClosing = sameWidth && keyboardReferenceHeight > 0 && window.innerHeight < keyboardReferenceHeight * 0.8;
        // A soft keyboard may resize the layout viewport without changing its width.
        if (!initialized || (!editing && !keyboardClosing) || !sameWidth) {
            if (!sameWidth) keyboardReferenceHeight = 0;
            isPortrait.value = query.matches && window.innerHeight > window.innerWidth;
            width = window.innerWidth;
            initialized = true;
        }
        root.dataset.layout = isPortrait.value ? 'portrait' : 'landscape';
        root.style.setProperty('--app-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
    };
    useEventListener(window, 'resize', update);
    useEventListener(query, 'change', update);
    useEventListener(window.visualViewport, 'resize', update);
    useEventListener(document, 'focusin', () => {
        if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) {
            keyboardReferenceHeight = Math.max(keyboardReferenceHeight, window.innerHeight);
        }
    });
    useEventListener(document, 'focusout', () => {
        cancelAnimationFrame(blurFrame);
        blurFrame = requestAnimationFrame(update);
    });
    update();
    onScopeDispose(() => {
        cancelAnimationFrame(blurFrame);
        if (previousLayout === undefined) delete root.dataset.layout;
        else root.dataset.layout = previousLayout;
        if (previousHeight) root.style.setProperty('--app-viewport-height', previousHeight);
        else root.style.removeProperty('--app-viewport-height');
    });
    return { isPortrait: readonly(isPortrait) };
});
