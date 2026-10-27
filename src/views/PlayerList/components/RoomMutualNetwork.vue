<template>
    <section class="room-mutual-network flex min-h-80 min-w-0 flex-1 flex-col" :aria-busy="network?.refreshing || loading">
        <div class="flex shrink-0 flex-wrap items-center gap-1 border-b py-1">
            <NativeSelect v-model="selected" class="min-w-0 max-w-52" :aria-label="t('view.player_list.select_player')">
                <NativeSelectOption value="">{{ t('view.player_list.select_player') }}</NativeSelectOption>
                <NativeSelectOption v-for="node in network?.nodes || []" :key="node.id" :value="node.id">{{ node.label }}</NativeSelectOption>
            </NativeSelect>
            <TooltipWrapper :content="t('common.actions.view_details')">
                <Button variant="ghost" size="icon" :disabled="!selected" :aria-label="t('common.actions.view_details')" @click="showUserDialog(selected)"><UserRound /></Button>
            </TooltipWrapper>
            <div class="ml-auto flex items-center">
                <TooltipWrapper :content="t('view.player_list.zoom_in')"><Button variant="ghost" size="icon" :aria-label="t('view.player_list.zoom_in')" @click="renderer?.getCamera().animatedZoom()"><ZoomIn /></Button></TooltipWrapper>
                <TooltipWrapper :content="t('view.player_list.zoom_out')"><Button variant="ghost" size="icon" :aria-label="t('view.player_list.zoom_out')" @click="renderer?.getCamera().animatedUnzoom()"><ZoomOut /></Button></TooltipWrapper>
                <TooltipWrapper :content="t('view.player_list.reset_view')"><Button variant="ghost" size="icon" :aria-label="t('view.player_list.reset_view')" @click="renderer?.getCamera().animatedReset()"><Maximize2 /></Button></TooltipWrapper>
                <TooltipWrapper :content="t('common.actions.refresh')"><Button variant="ghost" size="icon" :disabled="network?.refreshing || loading" :aria-label="t('common.actions.refresh')" @click="refresh(true)"><RefreshCw :class="{ 'animate-spin': network?.refreshing || loading }" /></Button></TooltipWrapper>
                <TooltipWrapper :content="t('view.player_list.network_help')"><Button variant="ghost" size="icon" :aria-label="t('view.player_list.network_help')"><Info /></Button></TooltipWrapper>
            </div>
        </div>
        <div class="flex shrink-0 flex-wrap gap-x-3 gap-y-1 py-1 text-xs text-muted-foreground">
            <span class="inline-flex items-center gap-1"><i class="size-2 rounded-full bg-sky-400" />{{ t('view.player_list.room_player') }}</span>
            <span class="inline-flex items-center gap-1"><i class="size-2 rounded-full bg-emerald-400" />{{ t('view.player_list.room_friend') }}</span>
            <span class="inline-flex items-center gap-1"><i class="size-2 rounded-full bg-amber-400" />{{ t('view.player_list.other_friend') }}</span>
            <span class="ml-auto">{{ t('view.player_list.network_progress', { fetched: network?.fetched || 0, total: network?.total || 0, edges: network?.edges.length || 0 }) }}</span>
            <span v-if="network?.failed" class="text-destructive">{{ t('view.player_list.network_failed', { count: network.failed }) }}</span>
        </div>
        <p v-if="error" class="py-1 text-xs text-destructive" role="alert">{{ error }}</p>
        <div ref="canvas" class="relative min-h-64 min-w-0 flex-1" role="img" :aria-label="t('view.player_list.network')" />
        <DataTableEmpty v-if="!network?.nodes.length && !loading" type="nodata" />
    </section>
</template>

<script setup>
    import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { storeToRefs } from 'pinia';
    import { Info, Maximize2, RefreshCw, UserRound, ZoomIn, ZoomOut } from 'lucide-vue-next';
    import Graph from 'graphology';
    import Sigma from 'sigma';
    import LayoutWorker from '../../Charts/graphLayoutWorker.js?worker&inline';
    import { Button } from '../../../components/ui/button';
    import { NativeSelect, NativeSelectOption } from '../../../components/ui/native-select';
    import { DataTableEmpty } from '../../../components/ui/data-table';
    import { useAppearanceSettingsStore } from '../../../stores/settings/appearance';
    import { showUserDialog } from '../../../coordinators/userCoordinator';
    import { logStreamState } from '../../../services/logStreamClient';
    import { placeRoomNode, roomLayoutBounds } from '../roomNetworkLayout';

    const { t } = useI18n();
    const { isDarkMode } = storeToRefs(useAppearanceSettingsStore());
    const canvas = ref(null), selected = ref(''), loading = ref(false), error = ref('');
    const room = computed(() => logStreamState.playerList);
    const roomId = computed(() => JSON.stringify([room.value?.ownerId, room.value?.machineId, room.value?.location, room.value?.date]));
    const network = computed(() => {
        const value = logStreamState.roomNetwork;
        return value?.ownerId === room.value?.ownerId && value?.location === room.value?.location && value?.date === room.value?.date ? value : null;
    });
    let renderer, worker, observer, renderTimer, active = false, requestId = 0, fetchVersion = 0, controller;
    const positions = new Map();
    let layoutComplete = false, pendingTopology = '', cameraState;
    let bounds = roomLayoutBounds(positions);

    function drawLabel(ctx, data, settings) {
        if (!data.label) return;
        ctx.font = `${settings.labelSize || 12}px ${settings.labelFont || 'sans-serif'}`;
        const width = canvas.value?.clientWidth || 0;
        let label = data.label;
        while (label.length > 1 && ctx.measureText(label).width > Math.min(180, width - 16)) label = label.slice(0, -1);
        if (label !== data.label) label = `${label.slice(0, -3)}...`;
        const size = ctx.measureText(label).width;
        const x = data.x + data.size + size + 12 < width ? data.x + data.size + 6 : Math.max(4, data.x - data.size - size - 6);
        const y = Math.max(14, Math.min((canvas.value?.clientHeight || 0) - 4, data.y + 4));
        ctx.fillStyle = settings.labelColor.color;
        ctx.fillText(label, x, y);
    }

    async function refresh(force = false) {
        if (!active || !room.value?.location) return;
        controller?.abort();
        controller = new AbortController();
        const version = ++fetchVersion;
        const currentRoom = roomId.value;
        loading.value = true;
        error.value = '';
        try {
            const response = await fetch('/headless/room-network/refresh', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force }), signal: controller.signal
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value?.error?.message || response.statusText);
            if (active && version === fetchVersion && roomId.value === currentRoom) logStreamState.roomNetwork = value;
        } catch (err) {
            if (err.name !== 'AbortError' && version === fetchVersion) error.value = err.message;
        } finally { if (version === fetchVersion) loading.value = false; }
    }

    function render() {
        if (!active || !canvas.value?.clientWidth || !canvas.value?.clientHeight) return;
        const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
        const nodes = network.value?.nodes || [];
        nodes.forEach((node, index) => {
            let position = positions.get(node.id);
            const angle = index * Math.PI * 2 / Math.max(1, nodes.length);
            if (!position) {
                const neighbors = (network.value?.edges || []).filter((edge) => edge.source === node.id || edge.target === node.id)
                    .map((edge) => edge.source === node.id ? edge.target : edge.source);
                position = layoutComplete ? placeRoomNode(node.id, neighbors, positions, bounds) : nodes.length === 1 ? { x: 0, y: 0 } : { x: Math.cos(angle) * 100, y: Math.sin(angle) * 100 };
                positions.set(node.id, position);
            }
            graph.addNode(node.id, { label: node.label, ...position, size: node.inRoom ? 7 : 4,
                color: node.inRoom ? node.isFriend ? '#34d399' : '#38bdf8' : '#fbbf24', forceLabel: node.inRoom || nodes.length <= 40 });
        });
        for (const edge of network.value?.edges || []) {
            if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.source, edge.target)) graph.addEdge(edge.source, edge.target, { size: 0.8 });
        }
        if (!graph.hasNode(selected.value)) selected.value = '';
        const labelColor = isDarkMode.value ? '#eeeeee' : '#222222';
        const edgeColor = isDarkMode.value ? '#727272' : '#b4b4b4';
        if (!renderer) {
            try {
                renderer = new Sigma(graph, canvas.value, { allowInvalidContainer: true, labelColor: { color: labelColor },
                    defaultEdgeColor: edgeColor, labelRenderedSizeThreshold: 6, renderEdgeLabels: false, stagePadding: 48,
                    defaultDrawNodeLabel: drawLabel, defaultDrawNodeHover: drawLabel,
                    nodeReducer: (id, attrs) => {
                        const graph = renderer?.getGraph();
                        const focused = !selected.value || id === selected.value || graph?.hasEdge(id, selected.value);
                        return focused ? { ...attrs, forceLabel: attrs.forceLabel || id === selected.value } : { ...attrs, color: isDarkMode.value ? '#555555' : '#d5d5d5', label: '', forceLabel: false };
                    },
                    edgeReducer: (id, attrs) => ({ ...attrs, hidden: !!selected.value && !renderer?.getGraph().extremities(id).includes(selected.value) })
                });
                renderer.on('clickNode', ({ node }) => { selected.value = selected.value === node ? '' : node; });
                renderer.on('clickStage', () => { selected.value = ''; });
                if (cameraState) renderer.getCamera().setState(cameraState);
            } catch (err) { error.value = err.message; return; }
        } else {
            renderer.setGraph(graph);
            renderer.setSetting('labelColor', { color: labelColor });
            renderer.setSetting('defaultEdgeColor', edgeColor);
        }
        renderer.setCustomBBox(bounds);
        if (!worker) {
            worker = new LayoutWorker();
            worker.onmessage = ({ data }) => {
                if (!active || data.requestId !== requestId || !renderer) return;
                if (data.error) { error.value = data.error; return; }
                const graph = renderer.getGraph();
                for (const [id, position] of Object.entries(data.positions)) if (graph.hasNode(id)) {
                    positions.set(id, position);
                    graph.mergeNodeAttributes(id, position);
                }
                layoutComplete = true;
                bounds = roomLayoutBounds(positions);
                renderer.setCustomBBox(bounds);
                renderer.refresh();
            };
            worker.onerror = () => { error.value = t('view.player_list.layout_failed'); };
        }
        const topology = JSON.stringify([graph.nodes().sort(), graph.edges().map((id) => graph.extremities(id).sort().join(':')).sort()]);
        if (!layoutComplete && pendingTopology && topology !== pendingTopology) { requestId++; pendingTopology = ''; }
        if (!layoutComplete && !network.value?.refreshing && graph.order === 1) layoutComplete = true;
        if (!layoutComplete && !network.value?.refreshing && graph.order > 1 && topology !== pendingTopology) {
            pendingTopology = topology;
            worker.postMessage({ requestId: ++requestId,
            nodes: graph.mapNodes((id, attributes) => ({ id, attributes })),
            edges: graph.mapEdges((key, attributes, source, target) => ({ key, attributes, source, target })),
            settings: { layoutIterations: 300, layoutSpacing: 70, reinitialize: false } });
        }
    }

    function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 100); }
    async function activate() {
        if (active) return;
        active = true;
        await nextTick();
        observer = new ResizeObserver(() => { renderer?.resize(); scheduleRender(); });
        if (canvas.value) observer.observe(canvas.value);
        scheduleRender();
    }
    function deactivate() {
        if (!active) return;
        active = false;
        controller?.abort();
        clearTimeout(renderTimer);
        observer?.disconnect();
        worker?.terminate(); worker = null;
        pendingTopology = ''; requestId++;
        cameraState = renderer?.getCamera().getState();
        renderer?.kill(); renderer = null;
    }
    watch(network, scheduleRender);
    watch(isDarkMode, scheduleRender);
    watch(selected, () => renderer?.refresh());
    watch(roomId, () => {
        positions.clear(); layoutComplete = false; pendingTopology = ''; requestId++;
        bounds = roomLayoutBounds(positions); cameraState = undefined;
        selected.value = ''; renderer?.getCamera().animatedReset();
    });
    onMounted(activate);
    onActivated(activate);
    onDeactivated(deactivate);
    onBeforeUnmount(deactivate);
</script>
