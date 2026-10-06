<template>
    <Dialog :open="true" @update:open="emit('close')">
        <DialogScrollContent class="max-w-2xl">
            <DialogHeader><DialogTitle>{{ t('view.game_log.stream.settings') }}</DialogTitle></DialogHeader>
            <form v-if="config" ref="form" class="grid gap-4" @submit.prevent="save">
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div v-for="key in textFields" :key="key" class="grid min-w-0 gap-1.5" :class="key === 'server' ? 'sm:col-span-2' : ''">
                        <Label :for="`log-${key}`">{{ t(`view.game_log.stream.${key}`) }}</Label>
                        <div class="flex gap-1">
                            <Input :id="`log-${key}`" v-model="config[key]" :required="key === 'server' || key === 'machineId'" :maxlength="key === 'machineId' ? 128 : 2048" />
                            <TooltipWrapper :content="resetLabel(key)"><Button type="button" variant="ghost" size="icon" :disabled="busy" :aria-label="resetLabel(key)" @click="resetField(key)"><RotateCcw class="size-4" /></Button></TooltipWrapper>
                        </div>
                    </div>
                    <div class="grid gap-1.5">
                        <Label for="log-historyMode">{{ t('view.game_log.stream.historyMode') }}</Label>
                        <div class="flex gap-1">
                            <Select v-model="config.historyMode">
                                <SelectTrigger id="log-historyMode" class="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem v-for="mode in ['ask', 'skip', 'backfill', 'tail']" :key="mode" :value="mode">{{ t(`view.game_log.stream.${mode}`) }}</SelectItem></SelectContent>
                            </Select>
                            <TooltipWrapper :content="resetLabel('historyMode')"><Button type="button" variant="ghost" size="icon" :disabled="busy" :aria-label="resetLabel('historyMode')" @click="resetField('historyMode')"><RotateCcw class="size-4" /></Button></TooltipWrapper>
                        </div>
                    </div>
                    <div v-for="field in numberFields" :key="field.key" class="grid gap-1.5">
                        <Label :for="`log-${field.key}`">{{ t(`view.game_log.stream.${field.key}`) }}</Label>
                        <div class="flex gap-1">
                            <Input :id="`log-${field.key}`" v-model="config[field.key]" type="number" :min="field.min" :max="field.max" step="1" required />
                            <TooltipWrapper :content="resetLabel(field.key)"><Button type="button" variant="ghost" size="icon" :disabled="busy" :aria-label="resetLabel(field.key)" @click="resetField(field.key)"><RotateCcw class="size-4" /></Button></TooltipWrapper>
                        </div>
                    </div>
                    <div v-for="key in ['exitWithVrchat', 'singleInstance']" :key="key" class="flex items-center justify-between gap-3">
                        <Label :for="`log-${key}`">{{ t(`view.game_log.stream.${key}`) }}</Label>
                        <div class="flex items-center gap-1">
                            <Switch :id="`log-${key}`" v-model="config[key]" />
                            <TooltipWrapper :content="resetLabel(key)"><Button type="button" variant="ghost" size="icon" :disabled="busy" :aria-label="resetLabel(key)" @click="resetField(key)"><RotateCcw class="size-4" /></Button></TooltipWrapper>
                        </div>
                    </div>
                </div>
                <div class="grid gap-1.5 border-t pt-4">
                    <Label for="log-secret">{{ t('view.game_log.stream.secret') }}</Label>
                    <div class="flex gap-1">
                        <Input id="log-secret" :model-value="config.token" :type="showSecret ? 'text' : 'password'" readonly autocomplete="off" />
                        <TooltipWrapper :content="t('view.game_log.stream.reveal')"><Button type="button" variant="ghost" size="icon" :aria-label="t('view.game_log.stream.reveal')" @click="showSecret = !showSecret"><Eye class="size-4" /></Button></TooltipWrapper>
                        <TooltipWrapper :content="t('view.game_log.stream.rotate')"><Button type="button" variant="ghost" size="icon" :disabled="busy" :aria-label="t('view.game_log.stream.rotate')" @click="rotate"><RefreshCw class="size-4" /></Button></TooltipWrapper>
                    </div>
                </div>
                <DialogFooter class="flex-wrap gap-2">
                    <Button type="button" variant="outline" :disabled="busy" @click="resetAll"><RotateCcw class="size-4" />{{ t('view.game_log.stream.reset_all') }}</Button>
                    <TooltipWrapper :content="t('view.game_log.stream.config')"><Button type="button" variant="outline" size="icon" :disabled="busy" :aria-label="t('view.game_log.stream.config')" @click="download(false)"><FileKey class="size-4" /></Button></TooltipWrapper>
                    <TooltipWrapper :content="t('view.game_log.stream.download')"><Button type="button" variant="outline" size="icon" :disabled="busy" :aria-label="t('view.game_log.stream.download')" @click="download(true)"><Download class="size-4" /></Button></TooltipWrapper>
                    <Button type="submit" :disabled="busy"><Save class="size-4" />{{ t('view.game_log.stream.save') }}</Button>
                </DialogFooter>
            </form>
            <span v-else role="status">{{ t('view.game_log.stream.loading') }}</span>
        </DialogScrollContent>
    </Dialog>
</template>

<script setup>
    import { onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { toast } from 'vue-sonner';
    import { Download, Eye, FileKey, RefreshCw, RotateCcw, Save } from 'lucide-vue-next';
    import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from '../../../components/ui/dialog';
    import { Input } from '../../../components/ui/input';
    import { Label } from '../../../components/ui/label';
    import { Button } from '../../../components/ui/button';
    import { Switch } from '../../../components/ui/switch';
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
    import { TooltipWrapper } from '../../../components/ui/tooltip';
    import { useModalStore } from '../../../stores';

    const emit = defineEmits(['close']);
    const { t } = useI18n();
    const modal = useModalStore();
    const config = ref(null);
    const defaults = ref(null);
    const form = ref(null);
    const busy = ref(false);
    const showSecret = ref(false);
    const textFields = ['server', 'machineId', 'logDir', 'stateFile'];
    const numberFields = [
        { key: 'historyMaxDays', min: 0, max: 3650 }, { key: 'historyMaxFiles', min: 0, max: 10000 },
        { key: 'batchSize', min: 1, max: 1000 }, { key: 'pollMs', min: 250, max: 60000 },
        { key: 'tailBytes', min: 0, max: 67108864 }, { key: 'vrchatExitGraceMs', min: 0, max: 300000 }
    ];

    async function request(url, body) {
        const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || t('view.game_log.stream.config_error'));
        return result;
    }
    onMounted(async () => {
        try {
            const [current, original] = await Promise.all([request('/headless/log-stream/config'), request('/headless/log-stream/config?defaults=1')]);
            original.server = window.location.origin;
            defaults.value = original;
            config.value = current;
        }
        catch (error) { toast.error(error.message); emit('close'); }
    });
    function resetLabel(key) { return t('view.game_log.stream.reset_field', { name: t(`view.game_log.stream.${key}`) }); }
    function resetField(key) { config.value[key] = defaults.value[key]; }
    function resetAll() {
        for (const key of [...textFields, ...numberFields.map((field) => field.key), 'historyMode', 'exitWithVrchat', 'singleInstance']) resetField(key);
    }
    async function persist() {
        if (!form.value.reportValidity()) return false;
        const body = Object.fromEntries([...textFields, 'historyMode', 'exitWithVrchat', 'singleInstance'].map((key) => [key, config.value[key]]));
        for (const { key } of numberFields) body[key] = Number(config.value[key]);
        await request('/headless/log-stream/config', body);
        return true;
    }
    async function save() {
        busy.value = true;
        try { if (await persist()) toast.success(t('view.game_log.stream.saved')); }
        catch (error) { toast.error(error.message); }
        finally { busy.value = false; }
    }
    async function rotate() {
        const { ok } = await modal.confirm({ title: t('view.game_log.stream.rotate'), description: t('view.game_log.stream.rotate_warning') });
        if (!ok) return;
        busy.value = true;
        try {
            const result = await request('/headless/log-stream/token/rotate', { confirm: true });
            config.value.token = result.token;
            showSecret.value = false;
            toast.success(t('view.game_log.stream.rotated'));
        } catch (error) { toast.error(error.message); }
        finally { busy.value = false; }
    }
    async function download(installer) {
        busy.value = true;
        let url;
        try {
            if (!(await persist())) return;
            const link = document.createElement('a');
            if (installer) {
                link.href = `/headless/log-stream/installer.exe?v=${Date.now()}`;
                link.download = 'vrcx-log-streamer-setup-win-x64.exe';
            } else {
                const current = await request('/headless/log-stream/config');
                url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
                link.href = url; link.download = 'vrcx-log-streamer.config.json';
            }
            document.body.appendChild(link); link.click(); link.remove();
        } catch (error) { toast.error(error.message); }
        finally { busy.value = false; if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
</script>
