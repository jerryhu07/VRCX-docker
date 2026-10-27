const epoch = (value) => Date.parse(value) || 0;

function buildInstanceActivity({ locations, events, rawEvents, clients, user, now = Date.now() }) {
    const currentUserData = [];
    const detailData = [];
    const source = [];
    const fileLocations = new Map();
    for (const [file, offset, loggedAt, data] of rawEvents) {
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        const type = event.parsed?.type || event.rawLog?.[2];
        const args = event.parsed?.args || event.rawLog?.slice(3) || [];
        if (type === 'location') fileLocations.set(file, args[0]);
        if (type === 'location-destination') fileLocations.delete(file);
        source.push({ file, offset, at: epoch(loggedAt), type, args, location: fileLocations.get(file) });
    }
    for (const location of locations) {
        const [id, createdAt, tag, worldName, duration, nextAt] = location;
        const start = epoch(createdAt);
        const next = epoch(nextAt);
        const rows = events.filter((e) => e[4] === tag && epoch(e[1]) >= start && (!next || epoch(e[1]) < next));
        const raw = source.filter((e) => e.location === tag && e.at >= start - 30000 && (!next || e.at < next));
        const ownLeaves = rows.filter((e) => e[2] === 'OnPlayerLeft' && e[5] === user.id);
        const ends = [duration > 0 ? start + duration : 0, next, ...ownLeaves.map((e) => epoch(e[1]))].filter((e) => e > start);
        const client = clients.filter((c) => c.currentLocation === tag &&
            Math.abs((epoch(c.currentLocationCreatedAt) || c.currentLocationAt) - start) <= 30000)
            .sort((a, b) => epoch(b.lastSeenAt) - epoch(a.lastSeenAt))[0];
        const live = !ends.length && client?.connected && client.vrchatRunning === true && now - epoch(client.lastSeenAt) < 45000;
        const stopped = !ends.length && client?.vrchatRunning === false && epoch(client.lastEventAt) >= start;
        const observed = Math.max(start, ...rows.map((e) => epoch(e[1])), ...raw.map((e) => e.at));
        const end = ends.length ? Math.min(...ends) : live ? now : stopped ? epoch(client.gameStoppedAt) || epoch(client.lastEventAt) : observed;
        const closed = ends.length > 0 || stopped;
        const status = live ? 'online' : closed ? 'closed' : 'unknown';
        const makeRow = (key, uid, name, joinedAt, leftAt, present = false, still = false) => ({
            id: key, session_id: id, created_at: new Date(leftAt).toISOString(),
            type: 'OnPlayerLeft', display_name: name, user_id: uid, location: tag,
            time: Math.max(0, leftAt - joinedAt), world_name: worldName || '',
            present_at_self_join: present, still_present_at_self_leave: still,
            session_status: status
        });
        const self = makeRow(`self:${id}`, user.id, user.displayName || user.id, start, end);
        currentUserData.push(self);
        const detail = [self];
        // Only real source-file self joins delimit the initial roster, never synthesized DB joins.
        const selfJoins = raw.filter((e) => e.type === 'player-joined' && e.args[1] === user.id);
        const first = selfJoins[0];
        const second = selfJoins.find((e) => first && e.file === first.file && e.offset > first.offset && e.at <= first.at + 90000);
        const initial = new Set(raw.filter((e) => e.type === 'player-joined' && first && second &&
            e.file === first.file && e.offset > first.offset && e.offset < second.offset)
            .map((e) => `${e.at}:${e.args[1] || e.args[0]}`));
        const open = new Map();
        rows.sort((a, b) => epoch(a[1]) - epoch(b[1]) || a[0] - b[0]);
        for (const event of rows) {
            const [eventId, at, type, name, , uid, time] = event;
            if (uid === user.id || epoch(at) > end) continue;
            const key = uid || name;
            if (type === 'OnPlayerJoined') {
                if (!open.has(key)) {
                    const present = initial.has(`${epoch(at)}:${key}`);
                    open.set(key, { id: eventId, uid, name, at: present ? start : epoch(at), present });
                }
            } else if (type === 'OnPlayerLeft') {
                const joined = open.get(key);
                const joinedAt = joined?.at ?? (time > 0 ? Math.max(start, epoch(at) - time) : epoch(at));
                detail.push(makeRow(`${id}:${eventId}`, uid, name, joinedAt, epoch(at), joined?.present));
                open.delete(key);
            }
        }
        for (const joined of open.values()) {
            detail.push(makeRow(`${id}:open:${joined.id}`, joined.uid, joined.name, joined.at, end, joined.present, closed));
        }
        detailData.push([id, detail]);
    }
    return { currentUserData, detailData };
}

module.exports = { buildInstanceActivity };
