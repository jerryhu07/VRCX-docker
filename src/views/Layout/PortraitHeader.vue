<template>
    <header v-if="isPortrait" class="portrait-header">
        <Button variant="ghost" size="icon" :aria-label="t('common.portrait.navigation')" :aria-expanded="openMobile" @click="toggleSidebar">
            <Menu />
        </Button>
        <h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ title }}</h1>
        <Button variant="ghost" size="icon" :aria-label="t('nav_tooltip.friend_list')" :aria-expanded="friendsOpen" @click="openFriends">
            <Users />
        </Button>
    </header>
</template>

<script setup>
    import { computed, watch } from 'vue';
    import { useRoute } from 'vue-router';
    import { useI18n } from 'vue-i18n';
    import { Menu, Users } from 'lucide-vue-next';
    import { Button } from '@/components/ui/button';
    import { useSidebar } from '@/components/ui/sidebar';
    import { useDashboardStore } from '@/stores/dashboard';

    const props = defineProps({ friendsOpen: Boolean });
    const emit = defineEmits(['update:friendsOpen']);
    const route = useRoute();
    const dashboardStore = useDashboardStore();
    const { t, te } = useI18n();
    const { isMobile: isPortrait, openMobile, setOpenMobile, toggleSidebar } = useSidebar();
    const title = computed(() => {
        if (route.name === 'dashboard') return dashboardStore.getDashboard(route.params.id)?.name || 'VRCX';
        const key = `nav_tooltip.${String(route.name || '').replaceAll('-', '_')}`;
        if (te(key)) return t(key);
        if (String(route.name).startsWith('charts-')) return t('nav_tooltip.charts');
        return 'VRCX';
    });
    function openFriends() {
        setOpenMobile(false);
        emit('update:friendsOpen', !props.friendsOpen);
    }
    watch(openMobile, (open) => { if (open) emit('update:friendsOpen', false); });
    watch(() => route.fullPath, () => {
        setOpenMobile(false);
        emit('update:friendsOpen', false);
    });
</script>
