import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { getSanFuPeriod, isDateInSanFuPeriod } from '../src/utils/sanfu';

const period = getSanFuPeriod(2026);
assert(period, '2026 Sanfu period should exist');
assert.equal(period.start.format('YYYY-MM-DD'), '2026-07-15');
assert.equal(period.end.format('YYYY-MM-DD'), '2026-08-23');
assert.equal(period.totalDays, 40);

for (const timezone of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
    process.env.TZ = timezone;
    const timezonePeriod = getSanFuPeriod(2026);
    assert(timezonePeriod, `2026 Sanfu period should exist in ${timezone}`);
    assert.equal(timezonePeriod.start.format('YYYY-MM-DD'), '2026-07-15');
    assert.equal(timezonePeriod.end.format('YYYY-MM-DD'), '2026-08-23');
}

assert.equal(isDateInSanFuPeriod(moment.tz('2026-07-14', 'Asia/Taipei')), false);
assert.equal(isDateInSanFuPeriod(moment.tz('2026-07-15', 'Asia/Taipei')), true);
assert.equal(isDateInSanFuPeriod(moment.tz('2026-08-23', 'Asia/Taipei')), true);
assert.equal(isDateInSanFuPeriod(moment.tz('2026-08-24', 'Asia/Taipei')), false);

console.log('Sanfu date tests passed');
