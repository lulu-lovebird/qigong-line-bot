import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import moment from 'moment-timezone';
import { calculateLineUserStats } from '../src/services/lineCheckin';
import { getPracticeDateWindow, isValidPracticeTimezone, validateCheckinDate } from '../src/services/practiceTimezone';

test('uses each learner timezone and closes make-ups at noon', () => {
    for (const timezone of ['Asia/Taipei', 'America/Los_Angeles', 'America/New_York', 'Europe/London']) {
        assert.equal(isValidPracticeTimezone(timezone), true);
        const beforeCutoff = getPracticeDateWindow(timezone, moment.tz('2026-03-08 11:59:59', timezone));
        assert.equal(beforeCutoff.today, '2026-03-08');
        assert.equal(beforeCutoff.yesterday, '2026-03-07');
        assert.deepEqual(validateCheckinDate(beforeCutoff.yesterday, beforeCutoff), { checkinDate: '2026-03-07', entryKind: 'makeup' });
        const atCutoff = getPracticeDateWindow(timezone, moment.tz('2026-03-08 12:00:00', timezone));
        assert.equal(atCutoff.canMakeupYesterday, false);
        assert.throws(() => validateCheckinDate(atCutoff.yesterday, atCutoff), /closed at 12:00/);
    }
    assert.equal(isValidPracticeTimezone('UTC-5'), false);
});

test('recalculates stored counters after filling a missed date', () => {
    const now = moment.tz('2026-09-12 09:00', 'America/Los_Angeles');
    assert.deepEqual(calculateLineUserStats(['2026-09-10', '2026-09-12'], 'America/Los_Angeles', now), {
        currentStreak: 1, longestStreak: 1, totalCheckins: 2, lastCheckinDate: '2026-09-12'
    });
    assert.deepEqual(calculateLineUserStats(['2026-09-10', '2026-09-12', '2026-09-11'], 'America/Los_Angeles', now), {
        currentStreak: 3, longestStreak: 3, totalCheckins: 3, lastCheckinDate: '2026-09-12'
    });
});

test('ships the LINE make-up UI and migration contract', () => {
    const view = fs.readFileSync(path.join(process.cwd(), 'src/views/liff/checkin.ejs'), 'utf8');
    const route = fs.readFileSync(path.join(process.cwd(), 'src/routes/liffApi.ts'), 'utf8');
    const migration = fs.readFileSync(path.join(process.cwd(), 'migrations/013_line_makeup_checkins.sql'), 'utf8');
    assert.match(view, /id="timezoneCard"/);
    assert.match(view, /<select id="timezoneInput"/);
    assert.match(view, /id="todayTab"/);
    assert.match(view, /id="makeupTab"/);
    assert.match(view, /checkinDate: selectedDate/);
    assert.match(view, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
    assert.match(route, /getLineCheckinForDate/);
    assert.match(route, /req\.body\?\.checkinDate/);
    assert.match(route, /oauth2\/v2\.1\/verify/);
    assert.match(route, /LINE_LOGIN_CHANNEL_ID/);
    assert.match(route, /verification\.expires_in/);
    assert.match(route, /router\.get\('\/checkin\/today', requireVerifiedLineUser/);
    assert.match(view, /x-line-access-token/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS practice_timezone TEXT/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS entry_kind VARCHAR\(16\)/);
    assert.match(migration, /CHECK \(entry_kind IN \('regular', 'makeup'\)\)/);
    assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});
