<template>
    <div class="portrait-watch-list flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <header class="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
            <div class="min-w-0 w-full xl:flex-1">
                <h1 class="text-base font-semibold">{{ t('view.watch_list.header') }}</h1>
                <p class="text-xs text-muted-foreground">
                    {{ t('view.watch_list.summary', { users: items.length, changes: changes.length }) }}
                </p>
            </div>
            <form class="flex w-full min-w-0 items-center gap-2 xl:flex-1 xl:justify-end" @submit.prevent="handleAdd">
                <Input
                    v-model="newUserId"
                    class="min-w-0 flex-1 xl:max-w-md"
                    :placeholder="t('view.watch_list.user_id')"
                    autocomplete="off" />
                <NativeSelect v-model="newInterval" class="w-28" :aria-label="t('view.watch_list.interval')">
                    <NativeSelectOption v-for="option in intervalOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                    </NativeSelectOption>
                </NativeSelect>
                <Button type="submit" :disabled="adding || !isValidUserId">
                    <Plus />
                    {{ t('view.watch_list.add') }}
                </Button>
            </form>
        </header>

        <NativeSelect v-if="isPortrait" :model-value="selectedUserId" class="m-2 w-auto" :aria-label="t('view.watch_list.user_id')" @update:model-value="selectUser">
            <NativeSelectOption value="">{{ t('view.watch_list.all_changes') }}</NativeSelectOption>
            <NativeSelectOption v-for="item in items" :key="item.userId" :value="item.userId">{{ item.displayName || item.userId }}</NativeSelectOption>
        </NativeSelect>
        <div class="portrait-watch-grid grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside v-show="!isPortrait" class="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0">
                <div class="flex items-center gap-2 border-b px-3 py-2">
                    <Input v-model="filter" class="h-8" :placeholder="t('view.watch_list.search')" />
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        :disabled="loading"
                        :title="t('common.actions.refresh')"
                        @click="load">
                        <RefreshCw :class="{ 'animate-spin': loading }" />
                    </Button>
                </div>
                <ScrollArea class="min-h-0 flex-1">
                    <button
                        class="flex h-9 w-full items-center gap-2 border-b px-3 text-left transition-colors hover:bg-accent/50"
                        :class="{ 'bg-accent': selectedUserId === '' }"
                        @click="selectUser('')">
                        <Activity class="size-3.5 text-muted-foreground" />
                        <span class="min-w-0 flex-1 truncate text-xs font-medium">
                            {{ t('view.watch_list.all_changes') }}
                        </span>
                        <span class="text-[11px] tabular-nums text-muted-foreground">{{ changes.length }}</span>
                    </button>
                    <div
                        v-for="item in filteredItems"
                        :key="item.userId"
                        class="group flex h-10 items-center border-b px-2 transition-colors hover:bg-accent/50"
                        :class="{ 'bg-accent': selectedUserId === item.userId }">
                        <button
                            class="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
                            @click="selectUser(item.userId)">
                            <span
                                class="size-2 shrink-0 rounded-full"
                                :class="
                                    item.lastError
                                        ? 'bg-destructive'
                                        : item.enabled
                                          ? 'bg-emerald-500'
                                          : 'bg-muted-foreground/40'
                                ">
                            </span>
                            <span class="min-w-0 flex-1 truncate text-xs font-medium">
                                {{ item.displayName || item.userId }}
                            </span>
                            <span
                                class="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                                <Users class="size-3" />
                                {{ item.mutualCount ?? '-' }}
                            </span>
                            <span class="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                {{ formatRelative(item.lastAttemptAt) }}
                            </span>
                        </button>
                        <DropdownMenu>
                            <DropdownMenuTrigger as-child>
                                <Button variant="ghost" size="icon-sm" class="size-7 shrink-0">
                                    <MoreVertical class="size-3.5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" class="w-52">
                                <DropdownMenuCheckboxItem
                                    :model-value="item.enabled"
                                    @select.prevent
                                    @update:model-value="setEnabled(item, $event)">
                                    {{ t('view.watch_list.enabled') }}
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuItem
                                    :disabled="pollingIds.has(item.userId)"
                                    @click="handlePoll(item.userId)">
                                    <RefreshCw :class="{ 'animate-spin': pollingIds.has(item.userId) }" />
                                    {{ t('view.watch_list.poll_now') }}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>{{ t('view.watch_list.interval') }}</DropdownMenuLabel>
                                <div class="px-2 pb-2" @click.stop @keydown.stop>
                                    <NativeSelect
                                        :model-value="String(item.intervalMs)"
                                        class="w-full"
                                        :aria-label="t('view.watch_list.interval')"
                                        @update:model-value="setInterval(item, $event)">
                                        <NativeSelectOption
                                            v-for="option in intervalOptions"
                                            :key="option.value"
                                            :value="option.value">
                                            {{ option.label }}
                                        </NativeSelectOption>
                                    </NativeSelect>
                                </div>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem class="text-destructive" @click="confirmRemove(item)">
                                    <Trash2 />
                                    {{ t('common.actions.delete') }}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                    <div v-if="!filteredItems.length" class="px-4 py-10 text-center text-sm text-muted-foreground">
                        {{ t('common.no_data') }}
                    </div>
                </ScrollArea>
            </aside>

            <main class="min-h-0 overflow-y-auto overscroll-contain">
                <div class="mx-auto max-w-5xl px-4 py-4">
                    <div class="mb-3 flex items-center justify-between gap-3">
                        <h2 class="text-sm font-semibold">
                            {{ selectedItem?.displayName || selectedItem?.userId || t('view.watch_list.all_changes') }}
                        </h2>
                        <Badge variant="outline">{{ visibleChanges.length }}</Badge>
                    </div>
                    <div v-if="visibleChanges.length" class="space-y-2">
                        <details
                            v-for="change in visibleChanges"
                            :key="change.id"
                            class="group rounded-md border bg-card open:shadow-sm">
                            <summary class="flex cursor-pointer list-none items-center gap-3 px-3 py-3">
                                <ChevronRight
                                    class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                                <div class="min-w-0 flex-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <span class="truncate text-sm font-medium">
                                            {{ itemName(change.userId) }}
                                        </span>
                                        <Badge :variant="change.source === 'mutuals' ? 'secondary' : 'outline'">
                                            {{
                                                change.source === 'mutuals'
                                                    ? t('view.watch_list.mutual_friends')
                                                    : t('view.watch_list.profile')
                                            }}
                                        </Badge>
                                        <Badge v-if="change.kind === 'baseline'" variant="outline">
                                            {{ t('view.watch_list.baseline') }}
                                        </Badge>
                                    </div>
                                    <div class="mt-1 text-xs text-muted-foreground">
                                        {{ formatDate(change.createdAt) }} · {{ change.diff.length }}
                                    </div>
                                </div>
                            </summary>
                            <div class="border-t bg-background px-3 py-3">
                                <div class="overflow-hidden rounded-md border font-mono text-xs">
                                    <div
                                        v-for="(entry, index) in change.diff"
                                        :key="`${entry.path}-${index}`"
                                        class="border-b last:border-b-0">
                                        <div class="border-b bg-muted/60 px-3 py-1.5 font-sans font-medium">
                                            {{ entry.path }}
                                        </div>
                                        <div class="portrait-json overflow-x-auto">
                                            <div
                                                v-for="(line, lineIndex) in diffLines(entry)"
                                                :key="`${line.kind}-${lineIndex}`"
                                                class="grid min-w-max grid-cols-[28px_minmax(0,1fr)]"
                                                :class="diffLineClass(line.kind)">
                                                <span
                                                    class="select-none border-r px-2 py-0.5 text-center font-semibold opacity-70">
                                                    {{ line.prefix }}
                                                </span>
                                                <span class="px-2 py-0.5 whitespace-pre">{{ line.text }}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <details class="mt-3 border-t pt-3">
                                    <summary class="cursor-pointer text-xs font-medium text-muted-foreground">
                                        {{ t('view.watch_list.raw_snapshot') }}
                                    </summary>
                                    <pre
                                        class="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre"
                                        >{{ formatSnapshot(change.snapshot) }}</pre
                                    >
                                </details>
                            </div>
                        </details>
                    </div>
                    <div v-else class="py-20 text-center text-sm text-muted-foreground">
                        {{ t('common.no_data') }}
                    </div>
                </div>
            </main>
        </div>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
    import { usePortraitLayout } from '@/composables/usePortraitLayout';
    const { isPortrait } = usePortraitLayout();
    import { toast } from 'vue-sonner';
    import { Activity, ChevronRight, MoreVertical, Plus, RefreshCw, Trash2, Users } from 'lucide-vue-next';
    import { useI18n } from 'vue-i18n';

    import { Badge } from '../../components/ui/badge';
    import { Button } from '../../components/ui/button';
    import {
        DropdownMenu,
        DropdownMenuCheckboxItem,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuLabel,
        DropdownMenuSeparator,
        DropdownMenuTrigger
    } from '../../components/ui/dropdown-menu';
    import { Input } from '../../components/ui/input';
    import { NativeSelect, NativeSelectOption } from '../../components/ui/native-select';
    import { ScrollArea } from '../../components/ui/scroll-area';
    import { useModalStore } from '../../stores';
    import {
        addWatchUser,
        getWatchList,
        pollWatchUser,
        removeWatchUser,
        updateWatchUser
    } from '../../services/watchList';

    const { t } = useI18n();
    const modalStore = useModalStore();
    const items = ref([]);
    const changes = ref([]);
    const selectedUserId = ref('');
    const newUserId = ref('');
    const newInterval = ref(String(8 * 60 * 60 * 1000));
    const filter = ref('');
    const loading = ref(false);
    const adding = ref(false);
    const pollingIds = ref(new Set());

    const intervalOptions = [1, 2, 4, 8, 12, 24, 48, 168].map((hours) => ({
        value: String(hours * 60 * 60 * 1000),
        label: hours < 24 ? `${hours}h` : `${hours / 24}d`
    }));

    const isValidUserId = computed(() => /^usr_[0-9a-fA-F-]{36}$/.test(newUserId.value.trim()));
    const selectedItem = computed(() => items.value.find((item) => item.userId === selectedUserId.value));
    const visibleChanges = computed(() =>
        selectedUserId.value ? changes.value.filter((change) => change.userId === selectedUserId.value) : changes.value
    );
    const filteredItems = computed(() => {
        const value = filter.value.trim().toLowerCase();
        if (!value) return items.value;
        return items.value.filter((item) => `${item.displayName} ${item.userId}`.toLowerCase().includes(value));
    });

    async function load() {
        loading.value = true;
        try {
            const data = await getWatchList();
            items.value = data.items || [];
            changes.value = data.changes || [];
            if (selectedUserId.value && !items.value.some((item) => item.userId === selectedUserId.value)) {
                selectedUserId.value = '';
            }
        } catch (error) {
            toast.error(error.message);
        } finally {
            loading.value = false;
        }
    }

    async function handleAdd() {
        if (!isValidUserId.value || adding.value) return;
        adding.value = true;
        try {
            const userId = newUserId.value.trim();
            await addWatchUser(userId, Number(newInterval.value));
            newUserId.value = '';
            selectedUserId.value = userId;
            await load();
        } catch (error) {
            toast.error(error.message);
        } finally {
            adding.value = false;
        }
    }

    async function handlePoll(userId) {
        pollingIds.value = new Set([...pollingIds.value, userId]);
        try {
            const result = await pollWatchUser(userId);
            if (result.errors?.length) toast.warning(result.errors.join('\n'));
            await load();
        } catch (error) {
            toast.error(error.message);
        } finally {
            const next = new Set(pollingIds.value);
            next.delete(userId);
            pollingIds.value = next;
        }
    }

    async function setInterval(item, value) {
        try {
            await updateWatchUser(item.userId, { intervalMs: Number(value) });
            item.intervalMs = Number(value);
        } catch (error) {
            toast.error(error.message);
            await load();
        }
    }

    async function setEnabled(item, enabled) {
        try {
            await updateWatchUser(item.userId, { enabled });
            item.enabled = enabled;
        } catch (error) {
            toast.error(error.message);
            await load();
        }
    }

    async function confirmRemove(item) {
        const { ok } = await modalStore.confirm({
            title: t('view.watch_list.remove_title'),
            description: t('view.watch_list.remove_description', {
                name: item.displayName || item.userId
            })
        });
        if (!ok) return;
        try {
            await removeWatchUser(item.userId);
            await load();
        } catch (error) {
            toast.error(error.message);
        }
    }

    function selectUser(userId) {
        selectedUserId.value = userId;
    }

    function itemName(userId) {
        const item = items.value.find((entry) => entry.userId === userId);
        return item?.displayName || userId;
    }

    function formatDate(value) {
        if (!value) return '-';
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
    }

    function formatRelative(value) {
        if (!value) return t('view.watch_list.never');
        const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
        if (minutes < 1) return t('view.watch_list.just_now');
        if (minutes < 60) return `${minutes}m`;
        if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
        return `${Math.floor(minutes / 1440)}d`;
    }

    function formatSnapshot(value) {
        return JSON.stringify(value, null, 2);
    }

    function formatDiffValue(value) {
        const formatted = JSON.stringify(value, null, 2);
        return (formatted ?? String(value)).split('\n');
    }

    function diffLines(entry) {
        const lines = [];
        if (entry.before !== undefined) {
            lines.push(
                ...formatDiffValue(entry.before).map((text) => ({
                    kind: 'remove',
                    prefix: '-',
                    text
                }))
            );
        }
        if (entry.after !== undefined) {
            lines.push(
                ...formatDiffValue(entry.after).map((text) => ({
                    kind: 'add',
                    prefix: '+',
                    text
                }))
            );
        }
        return lines;
    }

    function diffLineClass(kind) {
        if (kind === 'remove') {
            return 'bg-[#ffebe9] text-[#82071e] dark:bg-[#3d1518] dark:text-[#ffb3ba]';
        }
        return 'bg-[#dafbe1] text-[#116329] dark:bg-[#12261e] dark:text-[#7ee787]';
    }

    let refreshTimer;
    function handleBackendRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(load, 250);
    }

    onMounted(() => {
        load();
        window.addEventListener('vrcx:watch-list-refresh', handleBackendRefresh);
    });
    onBeforeUnmount(() => {
        window.clearTimeout(refreshTimer);
        window.removeEventListener('vrcx:watch-list-refresh', handleBackendRefresh);
    });
</script>
