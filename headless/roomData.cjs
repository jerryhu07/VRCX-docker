const PLAYER_CACHE_TTL = 12 * 60 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
const validUser = (id) => /^usr_[\da-f-]{36}$/i.test(id || '') && !/^usr_0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(id);
const roomKey = (room) => room ? JSON.stringify([room.ownerId, room.machineId, room.location, room.date]) : '';
const profileFields = ['id', 'displayName', 'bio', 'bioLinks', 'tags', 'userIcon', 'iconUrl', 'bannerUrl', 'bannerType',
    'profilePicOverride', 'profilePicOverrideThumbnail', 'currentAvatarImageUrl', 'currentAvatarThumbnailImageUrl', 'currentAvatarTags',
    'ageVerificationStatus', 'date_joined', 'last_platform', 'badges', 'pronouns', 'status', 'statusDescription', 'developerType'];

class RoomData {
    constructor({ getRoster, getFriends, fetchProfile, fetchMutuals, notify, now = Date.now, delayMs = 500 }) {
        Object.assign(this, { getRoster, getFriends, fetchProfile, fetchMutuals, notify, now, delayMs });
        this.profiles = new Map();
        this.mutuals = new Map();
        this.pausedUntil = 0;
        this.job = null;
    }

    cacheKey(room, id) { return `${room.ownerId}:${id}`; }

    decorate(room) {
        if (!room) return null;
        return { ...room, players: room.players.map((player) => {
            const entry = this.profiles.get(this.cacheKey(room, player.userId));
            return entry?.value ? { ...player, profile: entry.value, profileVersion: entry.at } : player;
        }) };
    }

    network() {
        const room = this.getRoster();
        if (!room) return null;
        const friends = this.getFriends();
        const players = new Map(room.players.filter((p) => validUser(p.userId) && p.userId !== room.ownerId).map((p) => [p.userId, p]));
        const nodes = new Map();
        for (const [id, friend] of friends) {
            if (validUser(id) && id !== room.ownerId) nodes.set(id, { id, label: friend.displayName || friend.name || id, inRoom: players.has(id), isFriend: true });
        }
        for (const [id, player] of players) {
            const profile = this.profiles.get(this.cacheKey(room, id))?.value;
            nodes.set(id, { id, label: profile?.displayName || player.displayName || id, inRoom: true, isFriend: friends.has(id) });
        }
        const edges = new Map();
        let fetched = 0, failed = 0;
        for (const id of players.keys()) {
            const entry = this.mutuals.get(this.cacheKey(room, id));
            if (entry?.value) fetched++;
            if (entry?.error) failed++;
            for (const mutualId of entry?.value || []) {
                if (id === mutualId || !friends.has(mutualId) || !nodes.has(mutualId)) continue;
                if (friends.has(id) && !players.has(mutualId)) continue;
                const pair = [id, mutualId].sort();
                edges.set(pair.join(':'), { source: pair[0], target: pair[1] });
            }
        }
        const connected = new Set([...edges.values()].flatMap((edge) => [edge.source, edge.target]));
        for (const [id, node] of nodes) if (!node.inRoom && !connected.has(id)) nodes.delete(id);
        return { key: roomKey(room), ownerId: room.ownerId, location: room.location, date: room.date,
            nodes: [...nodes.values()], edges: [...edges.values()], fetched, failed, total: players.size,
            refreshing: !!this.job };
    }

    publish() { this.notify({ playerList: this.decorate(this.getRoster()), roomNetwork: this.network() }); }

    requestNetwork(force = false) {
        const room = this.getRoster();
        if (room && force && !this.job) {
            for (const player of room.players) {
                for (const cache of [this.profiles, this.mutuals]) {
                    const cached = cache.get(this.cacheKey(room, player.userId));
                    if (cached) cached.expires = 0;
                }
            }
        }
        if (force) this.sync();
        return this.network();
    }

    sync() {
        if (this.job) return this.job;
        if (this.now() < this.pausedUntil) return Promise.resolve();
        this.job = Promise.resolve().then(() => this.run()).catch((error) => {
            console.warn('Room data refresh failed:', error.message);
        }).finally(() => { this.job = null; this.publish(); });
        return this.job;
    }

    async run() {
        while (true) {
            const room = this.getRoster();
            if (!room) return;
            const ids = room.players.map((p) => p.userId).filter((id) => validUser(id) && id !== room.ownerId);
            const due = (cache, id) => (cache.get(this.cacheKey(room, id))?.expires || 0) <= this.now();
            const id = ids.find((id) => due(this.profiles, id) || due(this.mutuals, id));
            if (!id) return;
            const kind = due(this.profiles, id) ? 'profile' : 'mutual';
            const cache = kind === 'profile' ? this.profiles : this.mutuals;
            const key = this.cacheKey(room, id);
            let rateLimited = false;
            try {
                const result = await (kind === 'profile' ? this.fetchProfile(id) : this.fetchMutuals(id));
                if (this.getRoster()?.ownerId !== room.ownerId) return;
                let value;
                if (kind === 'profile') {
                    if (result?.id !== id) throw new Error('Invalid player profile');
                    value = Object.fromEntries(profileFields.filter((field) => result[field] !== undefined).map((field) => [field, result[field]]));
                } else {
                    if (!Array.isArray(result)) throw new Error('Invalid mutual friends response');
                    value = [...new Set(result.map((item) => typeof item === 'string' ? item : item?.id).filter(validUser))];
                }
                cache.set(key, { value, at: this.now(), expires: this.now() + PLAYER_CACHE_TTL });
            } catch (error) {
                if (this.getRoster()?.ownerId !== room.ownerId) return;
                cache.set(key, { ...cache.get(key), error: true, expires: this.now() + RETRY_DELAY });
                rateLimited = error.status === 429;
            }
            while (cache.size > 1024) cache.delete(cache.keys().next().value);
            this.publish();
            if (rateLimited) { this.pausedUntil = this.now() + RETRY_DELAY; return; }
            if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
    }
}

module.exports = { RoomData };
