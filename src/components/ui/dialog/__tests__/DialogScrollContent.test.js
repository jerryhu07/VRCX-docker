import { expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { Dialog, DialogScrollContent, DialogTitle } from '../index';

vi.mock('../../../../stores', () => ({}));

it('does not let the overlay cancel pointerdown inside editable inputs', async () => {
    const wrapper = mount({
        components: { Dialog, DialogScrollContent, DialogTitle },
        template: '<Dialog :open="true"><DialogScrollContent><DialogTitle>Settings</DialogTitle><input id="pointer-input" /></DialogScrollContent></Dialog>'
    }, { attachTo: document.body });
    try {
        await flushPromises();
        const input = document.querySelector('#pointer-input');
        expect(input).not.toBeNull();
        const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    } finally { wrapper.unmount(); }
});
