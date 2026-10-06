<template>
    <div class="mb-2 flex shrink-0 flex-wrap items-center gap-3 border-b pb-2 text-xs">
        <span role="status" class="inline-flex items-center gap-1.5" :title="client?.machineId || ''">
            <span class="size-2 rounded-full" :class="online ? 'bg-emerald-500' : 'bg-muted-foreground/50'"></span>
            {{ t(online ? 'view.game_log.stream.online' : 'view.game_log.stream.offline') }}
        </span>
        <span v-if="online" class="text-muted-foreground">
            {{ t(client?.vrchatRunning === true ? 'view.game_log.stream.running' : client?.vrchatRunning === false ? 'view.game_log.stream.stopped' : 'view.game_log.stream.process_unknown') }}
        </span>
        <span :class="debug === false ? 'text-destructive' : 'text-muted-foreground'" :title="client?.statusError || client?.clientVersion || ''">
            {{ t(debug === true ? 'view.game_log.stream.debug_on' : debug === false ? 'view.game_log.stream.debug_off' : 'view.game_log.stream.debug_unknown') }}
        </span>
        <div class="ml-auto flex items-center gap-1">
            <TooltipWrapper :content="t('view.game_log.stream.settings')">
                <Button variant="ghost" size="icon-sm" :aria-label="t('view.game_log.stream.settings')" @click="settingsOpen = true"><Settings class="size-4" /></Button>
            </TooltipWrapper>
            <TooltipWrapper :content="t('view.game_log.stream.config')">
                <Button variant="ghost" size="icon-sm" :disabled="downloading" :aria-label="t('view.game_log.stream.config')" @click="downloadConfig">
                    <FileKey class="size-4" />
                </Button>
            </TooltipWrapper>
            <TooltipWrapper :content="t('view.game_log.stream.download')">
                <Button as-child variant="ghost" size="icon-sm">
                    <a href="/headless/log-stream/installer.exe" download="vrcx-log-streamer-setup-win-x64.exe" :aria-label="t('view.game_log.stream.download')"><Download class="size-4" /></a>
                </Button>
            </TooltipWrapper>
        </div>
    </div>
    <LogStreamSettings v-if="settingsOpen" @close="settingsOpen = false" />
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Download, FileKey, Settings } from 'lucide-vue-next';
    import LogStreamSettings from './LogStreamSettings.vue';
    import { Button } from '../../../components/ui/button';
    import { TooltipWrapper } from '../../../components/ui/tooltip';
    import { getHeadlessBootstrap } from '../../../services/headlessBootstrap';
    import { isLogClientOnline, latestLogClient, logStreamState, updateLogStreamState } from '../../../services/logStreamClient';

    const { t } = useI18n();
    const now = ref(Date.now());
    const downloading = ref(false);
    const settingsOpen = ref(false);
    const client = computed(() => latestLogClient(logStreamState.clients));
    const online = computed(() => isLogClientOnline(client.value, now.value));
    const debug = computed(() => online.value ? client.value?.debugLoggingEnabled : null);
    const timer = setInterval(() => { now.value = Date.now(); }, 5000);
    onBeforeUnmount(() => clearInterval(timer));
    onMounted(() => { if (!logStreamState.initialized) getHeadlessBootstrap().then((boot) => updateLogStreamState(boot.state)).catch(() => {}); });

    async function downloadConfig() {
        downloading.value = true;
        try {
            const response = await fetch('/headless/log-stream/config');
            if (!response.ok) throw new Error(t('view.game_log.stream.config_error'));
            const config = await response.json();
            const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url; link.download = 'vrcx-log-streamer.config.json';
            document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { toast.error(error.message); }
        finally { downloading.value = false; }
    }
</script>
