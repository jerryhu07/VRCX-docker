import { describe, expect, test } from 'vitest';
import { ref } from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { useActivityDataProcessor } from '../useActivityDataProcessor';

dayjs.extend(utc);
dayjs.extend(timezone);

describe('activity daily time clipping', () => {
    test('counts only the selected day for sessions crossing both boundaries', () => {
        const start = dayjs.tz('2026-10-14').startOf('day');
        const rows = ref([{ joinTime: start.subtract(2, 'hour'), leaveTime: start.add(1, 'hour'), time: 10800000 },
            { joinTime: start.add(23, 'hour'), leaveTime: start.add(26, 'hour'), time: 10800000 }]);
        const result = useActivityDataProcessor(rows, ref([]), ref(true), ref(true), ref(true), ref('2026-10-14'));
        expect(result.totalOnlineTime.value).toBe(7200000);
    });
});
