<script setup>
    import { HoverCardTrigger, injectHoverCardRootContext } from 'reka-ui';
    import { usePortraitLayout } from '@/composables/usePortraitLayout';
    const { isPortrait } = usePortraitLayout();
    const context = injectHoverCardRootContext();
    function touchOpen(event) {
        if (!isPortrait.value || event.pointerType !== 'touch') return;
        event.preventDefault();
        context.onOpenChange(!context.open.value);
    }

    const props = defineProps({
        reference: { type: null, required: false },
        asChild: { type: Boolean, required: false },
        as: { type: null, required: false }
    });
</script>

<template>
    <HoverCardTrigger data-slot="hover-card-trigger" v-bind="props" :tabindex="isPortrait ? 0 : undefined" @pointerdown="touchOpen">
        <slot />
    </HoverCardTrigger>
</template>
