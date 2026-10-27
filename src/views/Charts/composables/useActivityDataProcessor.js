import { computed } from 'vue';

import dayjs from 'dayjs';

export function useActivityDataProcessor(
    activityData,
    activityDetailData,
    isDetailVisible,
    isSoloInstanceVisible,
    isNoFriendInstanceVisible,
    selectedDate
) {
    const totalOnlineTime = computed(() => {
        const start = dayjs.tz(selectedDate.value).startOf('day').valueOf();
        const end = dayjs.tz(selectedDate.value).add(1, 'day').startOf('day').valueOf();
        return activityData.value?.reduce((acc, item) => {
            return acc + Math.max(0, Math.min(end, item.leaveTime.valueOf()) - Math.max(start, item.joinTime.valueOf()));
        }, 0);
    });

    const filteredActivityDetailData = computed(() => {
        if (!isDetailVisible.value) {
            return [];
        }
        let result = [...activityDetailData.value];
        if (!isSoloInstanceVisible.value) {
            result = result.filter((arr) => arr.length > 1);
        }
        if (!isNoFriendInstanceVisible.value) {
            result = result.filter((arr) => {
                // solo instance
                if (arr.length === 1) {
                    return true;
                }
                return arr.some((item) => item.isFriend);
            });
        }
        return result;
    });

    return {
        totalOnlineTime,
        filteredActivityDetailData
    };
}
