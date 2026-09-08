import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildLegacyNote, mergeLegacyPracticeNotes } from '../src/services/lineCheckin';
import { normalizePracticeFeelingTags } from '../src/services/practiceFeelingTags';

test('builds the legacy searchable note from one unified practice note', () => {
    assert.equal(buildLegacyNote(['大雁初', '鬆靜功'], '  呼吸穩定，肩頸放鬆。  '), '功法：大雁初、鬆靜功；心得與感受：呼吸穩定，肩頸放鬆。');
    assert.equal(buildLegacyNote(['大雁初']), '功法：大雁初');
});

test('validates and orders configurable practice feeling tags', () => {
    assert.deepEqual(normalizePracticeFeelingTags([
        { id: 2, nameZh: ' 心神平靜 ', nameZhCn: '心神平静', nameEn: 'Calm', isActive: true },
        { nameZh: '發熱出汗', isActive: false }
    ]), [
        { id: 2, nameZh: '心神平靜', nameZhCn: '心神平静', nameEn: 'Calm', sortOrder: 10, isActive: true },
        { id: null, nameZh: '發熱出汗', nameZhCn: '', nameEn: '', sortOrder: 20, isActive: false }
    ]);
    assert.throws(() => normalizePracticeFeelingTags([{ nameZh: '重複' }, { nameZh: '重複' }]), /重複/);
    assert.throws(() => normalizePracticeFeelingTags([{ id: 1, nameZh: '甲' }, { id: 1, nameZh: '乙' }]), /ID 1 重複/);
    assert.throws(() => normalizePracticeFeelingTags([{ nameZh: '甲', nameEn: 'Same' }, { nameZh: '乙', nameEn: 'same' }]), /與其他標籤重複/);
});

test('combines every legacy note shape without losing its meaning', () => {
    assert.equal(mergeLegacyPracticeNotes('呼吸穩定', '肩頸放鬆'), '練功心得：呼吸穩定\n身體感受：肩頸放鬆');
    assert.equal(mergeLegacyPracticeNotes('呼吸穩定', ''), '呼吸穩定');
    assert.equal(mergeLegacyPracticeNotes('', '肩頸放鬆'), '肩頸放鬆');
    assert.equal(mergeLegacyPracticeNotes('  ', '\n'), '');
    assert.equal(mergeLegacyPracticeNotes(null, null), '');
    assert.equal(mergeLegacyPracticeNotes(null, '肩頸放鬆'), '肩頸放鬆');
});

test('ships one practice-note field and an idempotent legacy-data migration', () => {
    const checkinView = fs.readFileSync(path.join(process.cwd(), 'src/views/liff/checkin.ejs'), 'utf8');
    const migration = fs.readFileSync(path.join(process.cwd(), 'migrations/011_line_unified_practice_note.sql'), 'utf8');
    const feelingTagsMigration = fs.readFileSync(path.join(process.cwd(), 'migrations/012_line_practice_feeling_tags.sql'), 'utf8');

    assert.match(checkinView, /id="practiceNote"/);
    assert.doesNotMatch(checkinView, /id="reflectionNote"|id="bodyFeelingNote"/);
    assert.match(checkinView, /practiceNote: practiceNote\.value/);
    assert.match(checkinView, /reflectionNote: practiceNote\.value/);
    assert.match(checkinView, /mergeLegacyNotes\(todayResp\.reflectionNote, todayResp\.bodyFeelingNote\)/);
    assert.match(checkinView, /id="feelingTags"/);
    assert.match(checkinView, /practice-feeling-tags/);
    assert.match(checkinView, /toggleFeelingTag/);
    assert.match(checkinView, /return \{ tags: \[\] \}/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS practice_note TEXT/);
    assert.match(migration, /練功心得：/);
    assert.match(migration, /身體感受：/);
    assert.match(migration, /WHERE practice_note IS NULL/);
    assert.match(migration, /CREATE TRIGGER sync_line_practice_note_from_legacy/);
    assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
    assert.match(feelingTagsMigration, /CREATE TABLE IF NOT EXISTS practice_feeling_tags/);
    assert.match(feelingTagsMigration, /ON CONFLICT \(code\) DO NOTHING/);
    assert.match(feelingTagsMigration, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});
