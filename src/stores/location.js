import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useLocationStore = defineStore('Location', () => {
    const lastLocation = ref({
        date: null,
        location: '',
        name: '',
        playerList: new Map(),
        friendList: new Map()
    });
    const lastLocationDestination = ref('');
    const lastLocationDestinationTime = ref(0);

    function applyHeadlessPlayerList(snapshot, friends) {
        const players = (snapshot?.players || []).map((player) => [player.userId || player.displayName,
            { ...player, lastAvatar: '' }]);
        setLastLocation({ date: snapshot?.date || null, location: snapshot?.location || '',
            name: snapshot?.name || '', playerList: new Map(players),
            friendList: new Map(players.filter(([id]) => friends.has(id))) });
    }

    /**
     * @param {{date: number|null, location: string, name: string, playerList: Map<any, any>, friendList: Map<any, any>}} value
     */
    function setLastLocation(value) {
        lastLocation.value = value;
    }

    /**
     * @param {string} value
     */
    function setLastLocationLocation(value) {
        lastLocation.value.location = value;
    }

    /**
     * @param {string} value
     */
    function setLastLocationDestination(value) {
        lastLocationDestination.value = value;
    }

    /**
     * @param {number} value
     */
    function setLastLocationDestinationTime(value) {
        lastLocationDestinationTime.value = value;
    }

    return {
        lastLocation,
        lastLocationDestination,
        lastLocationDestinationTime,
        setLastLocation,
        applyHeadlessPlayerList,
        setLastLocationLocation,
        setLastLocationDestination,
        setLastLocationDestinationTime
    };
});
