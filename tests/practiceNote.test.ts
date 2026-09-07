import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildLegacyNote, mergeLegacyPracticeNotes } from '../src/services/lineCheckin';

test('builds the legacy searchable note from one unified practice note', () => {
    assert.equal(buildLegacyNote(['大雁初', '鬆靜功'], '  呼吸穩定，肩頸放鬆。  '), '功法：大雁初、鬆靜功；心得與感受：呼吸穩定，肩頸放鬆。');
    assert.equal(buildLegacyNote(['大雁初']), '功法：大雁初');
});

test('combines every legacy note shape without losing its meaning', () => {
    assert.equal(mergeLegacyPracticeNotes('呼吸穩定', '肩頸放鬆'), '練功心得：呼吸穩定\n身體感受：肩頸放鬆');
    assert.equal(mergeLegacyPracticeNotes('呼吸穩定', ''), '呼吸穩定');
    assert.equal(mergeLegacyPracticeNotes('', '肩頸放鬆'), '肩頸放鬆');
    assert.equal(mergeLegacyPracticeNotes('  ', '\n'), '');
});

test('ships one practice-note field and an idempotent legacy-data migration', () => {
    const checkinView = fs.readFileSync(path.join(process.cwd(), 'src/views/liff/checkin.ejs'), 'utf8');
    const migration = fs.readFileSync(path.join(process.cwd(), 'migrations/011_line_unified_practice_note.sql'), 'utf8');

    assert.match(checkinView, /id="practiceNote"/);
    assert.doesNotMatch(checkinView, /id="reflectionNote"|id="bodyFeelingNote"/);
    assert.match(checkinView, /practiceNote: practiceNote\.value/);
    assert.match(checkinView, /reflectionNote: practiceNote\.value/);
    assert.match(checkinView, /mergeLegacyNotes\(todayResp\.reflectionNote, todayResp\.bodyFeelingNote\)/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS practice_note TEXT/);
    assert.match(migration, /練功心得：/);
    assert.match(migration, /身體感受：/);
    assert.match(migration, /WHERE practice_note IS NULL/);
    assert.match(migration, /CREATE TRIGGER sync_line_practice_note_from_legacy/);
    assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});
