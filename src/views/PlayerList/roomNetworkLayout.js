export function roomLayoutBounds(positions) {
    if (!positions.size) return { x: [-150, 150], y: [-150, 150] };
    const values = [...positions.values()];
    const x = values.map((p) => p.x), y = values.map((p) => p.y);
    const pad = Math.max(20, (Math.max(...x) - Math.min(...x)) * 0.15, (Math.max(...y) - Math.min(...y)) * 0.15);
    return { x: [Math.min(...x) - pad, Math.max(...x) + pad], y: [Math.min(...y) - pad, Math.max(...y) + pad] };
}

// Place new arrivals without moving existing nodes or changing the viewport bounds.
export function placeRoomNode(id, neighbors, positions, bounds) {
    const anchors = neighbors.map((id) => positions.get(id)).filter(Boolean);
    const center = anchors.length ? {
        x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length,
        y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length
    } : { x: (bounds.x[0] + bounds.x[1]) / 2, y: (bounds.y[0] + bounds.y[1]) / 2 };
    let hash = 0;
    for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    const step = Math.min(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]) * 0.07;
    let point;
    for (let attempt = 0; attempt < 40; attempt++) {
        const angle = (hash % 360) * Math.PI / 180 + attempt * 2.39996;
        const radius = step * Math.sqrt(attempt + 1);
        point = {
            x: Math.max(bounds.x[0] + step, Math.min(bounds.x[1] - step, center.x + Math.cos(angle) * radius)),
            y: Math.max(bounds.y[0] + step, Math.min(bounds.y[1] - step, center.y + Math.sin(angle) * radius))
        };
        if ([...positions.values()].every((p) => Math.hypot(p.x - point.x, p.y - point.y) >= step * 0.8)) break;
    }
    return point;
}
