import moment from 'moment-timezone';
import { db } from '../db';
import { evaluateBadges } from '../badges';
import { createAsyncTtlCache } from '../utils/asyncTtlCache';
import { getPracticeDateWindow, getPracticeTimezoneSettings, validateCheckinDate } from './practiceTimezone';

const TIMEZONE = 'Asia/Taipei';
const PRACTICE_METHOD_CACHE_TTL_MS = 5 * 60 * 1000;

export interface LinePracticeMethod {
    id: number;
    code: string;
    nameZh: string;
    nameEn: string | null;
    estimatedMinutes: number | null;
    parentId: number | null;
    methodType: 'group' | 'leaf';
    children: LinePracticeMethod[];
}

interface PracticeMethodRow {
    id: number;
    code: string;
    name_zh: string;
    name_en: string | null;
    estimated_minutes: number | null;
    parent_id: number | null;
    method_type: string | null;
}

export interface TodayLineCheckinResponse {
    date: string;
    alreadyCheckedIn: boolean;
    checkinLogId: number | null;
    selectedMethodIds: number[];
    practiceNote: string;
    reflectionNote: string;
    bodyFeelingNote: string;
    entryKind: 'regular' | 'makeup';
    practiceTimezone: string;
}

export interface LineUserStats {
    currentStreak: number;
    longestStreak: number;
    totalCheckins: number;
    lastCheckinDate: string | null;
}

export const upsertLineUser = async (lineUserId: string, displayName?: string | null) => {
    await db.query(
        `INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)
         ON CONFLICT (line_user_id) DO UPDATE SET display_name = COALESCE($2, users.display_name)`,
        [lineUserId, displayName || null]
    );
};

const practiceMethodRowsCache = createAsyncTtlCache<PracticeMethodRow[]>(PRACTICE_METHOD_CACHE_TTL_MS);

export const invalidatePracticeMethodCache = () => practiceMethodRowsCache.invalidate();

export const getPracticeMethodRows = async (): Promise<PracticeMethodRow[]> => {
    const rows = await practiceMethodRowsCache.get(async () => {
        const result = await db.queryWithRetry(
            `SELECT id, code, name_zh, name_en, estimated_minutes, parent_id, method_type
             FROM practice_methods
             WHERE is_active = TRUE
             ORDER BY sort_order ASC, id ASC`
        );
        return result.rows;
    });

    return rows.map((row) => ({ ...row }));
};

const buildPracticeMethodTree = (rows: PracticeMethodRow[]): LinePracticeMethod[] => {
    const methodMap = new Map<number, LinePracticeMethod>();

    rows.forEach((row) => {
        methodMap.set(row.id, {
            id: row.id,
            code: row.code,
            nameZh: row.name_zh,
            nameEn: row.name_en,
            estimatedMinutes: row.estimated_minutes,
            parentId: row.parent_id,
            methodType: row.method_type === 'group' ? 'group' : 'leaf',
            children: []
        });
    });

    const roots: LinePracticeMethod[] = [];
    rows.forEach((row) => {
        const method = methodMap.get(row.id);
        if (!method) return;

        if (row.parent_id) {
            const parent = methodMap.get(row.parent_id);
            if (parent) {
                parent.children.push(method);
                return;
            }
        }

        roots.push(method);
    });

    return roots;
};

const normalizeSelectedLeafIds = (selectedIds: number[], rows: PracticeMethodRow[]) => {
    const methodMap = new Map<number, PracticeMethodRow>(rows.map((row) => [row.id, row]));
    const childrenByParentId = new Map<number, number[]>();

    rows.forEach((row) => {
        if (!row.parent_id) return;
        const children = childrenByParentId.get(row.parent_id) || [];
        children.push(row.id);
        childrenByParentId.set(row.parent_id, children);
    });

    const normalized = new Set<number>();
    selectedIds.forEach((id) => {
        const method = methodMap.get(id);
        if (!method) return;

        if (method.method_type === 'group') {
            (childrenByParentId.get(id) || []).forEach((childId) => normalized.add(childId));
            return;
        }

        normalized.add(id);
    });

    return rows
        .filter((row) => normalized.has(row.id))
        .map((row) => row.id);
};

export const getPracticeMethods = async (): Promise<LinePracticeMethod[]> => {
    const rows = await getPracticeMethodRows();
    return buildPracticeMethodTree(rows);
};

export const getLeafCodesByParentCode = async (): Promise<Map<string, string[]>> => {
    const rows = await getPracticeMethodRows();
    const rowById = new Map<number, PracticeMethodRow>(rows.map((row) => [row.id, row]));
    const leafCodesByParentCode = new Map<string, string[]>();

    rows.forEach((row) => {
        if (row.method_type !== 'leaf' || !row.parent_id) return;
        const parent = rowById.get(row.parent_id);
        if (!parent) return;

        leafCodesByParentCode.set(parent.code, [...(leafCodesByParentCode.get(parent.code) || []), row.code]);
    });

    return leafCodesByParentCode;
};

export const getLineCheckinForDate = async (lineUserId: string, checkinDate: string): Promise<TodayLineCheckinResponse> => {
    const settings = await getPracticeTimezoneSettings(lineUserId);
    const target = validateCheckinDate(checkinDate, settings);
    if (!settings.confirmed && target.entryKind === 'makeup') throw new Error('Confirm your practice timezone before making up yesterday');
    const { rows } = await db.queryWithRetry(
        `SELECT id, practice_note, reflection_note, body_feeling_note, entry_kind, practice_timezone
         FROM checkin_logs
         WHERE line_user_id = $1 AND checkin_date = $2`,
        [lineUserId, target.checkinDate]
    );

    if (rows.length === 0) {
        return {
            date: target.checkinDate,
            alreadyCheckedIn: false,
            checkinLogId: null,
            selectedMethodIds: [],
            practiceNote: '',
            reflectionNote: '',
            bodyFeelingNote: '',
            entryKind: target.entryKind,
            practiceTimezone: settings.practiceTimezone
        };
    }

    const checkin = rows[0];
    const selected = await db.queryWithRetry(
        `SELECT practice_method_id
         FROM checkin_method_selections
         WHERE checkin_log_id = $1
         ORDER BY practice_method_id ASC`,
        [checkin.id]
    );

    const methodRows = await getPracticeMethodRows();
    const normalizedSelectedIds = normalizeSelectedLeafIds(
        selected.rows.map((r) => r.practice_method_id),
        methodRows
    );

    const practiceNote = checkin.practice_note || mergeLegacyPracticeNotes(checkin.reflection_note, checkin.body_feeling_note);
    return {
        date: target.checkinDate,
        alreadyCheckedIn: true,
        checkinLogId: checkin.id,
        selectedMethodIds: normalizedSelectedIds,
        practiceNote,
        reflectionNote: checkin.reflection_note || '',
        bodyFeelingNote: checkin.body_feeling_note || '',
        entryKind: checkin.entry_kind === 'makeup' ? 'makeup' : 'regular',
        practiceTimezone: checkin.practice_timezone || settings.practiceTimezone
    };
};

export const getTodayLineCheckin = async (lineUserId: string) => {
    const settings = await getPracticeTimezoneSettings(lineUserId);
    return getLineCheckinForDate(lineUserId, settings.today);
};

export const mergeLegacyPracticeNotes = (reflectionNote: string | null = '', bodyFeelingNote: string | null = '') => {
    const reflection = (reflectionNote || '').trim();
    const bodyFeeling = (bodyFeelingNote || '').trim();
    if (reflection && bodyFeeling) return `練功心得：${reflection}\n身體感受：${bodyFeeling}`;
    return reflection || bodyFeeling;
};

export const buildLegacyNote = (methodNames: string[], practiceNote = '') => {
    const parts: string[] = [];
    if (methodNames.length > 0) parts.push(`功法：${methodNames.join('、')}`);
    if (practiceNote.trim()) parts.push(`心得與感受：${practiceNote.trim()}`);
    return parts.join('；');
};

export const calculateLineUserStats = (dateValues: Array<string | Date>, practiceTimezone: string, now = moment()): LineUserStats => {
    const dates = [...new Set(dateValues.map((value) => moment(value).format('YYYY-MM-DD')))]
        .sort()
        .map((value) => moment.tz(value, 'YYYY-MM-DD', practiceTimezone));
    if (!dates.length) return { currentStreak: 0, longestStreak: 0, totalCheckins: 0, lastCheckinDate: null };

    let longestStreak = 1;
    let runningStreak = 1;
    for (let index = 1; index < dates.length; index += 1) {
        runningStreak = dates[index].diff(dates[index - 1], 'days') === 1 ? runningStreak + 1 : 1;
        longestStreak = Math.max(longestStreak, runningStreak);
    }

    const today = now.clone().tz(practiceTimezone).startOf('day');
    const lastDate = dates[dates.length - 1];
    let currentStreak = 0;
    if (lastDate.isSame(today, 'day') || lastDate.isSame(today.clone().subtract(1, 'day'), 'day')) {
        currentStreak = 1;
        for (let index = dates.length - 1; index > 0 && dates[index].diff(dates[index - 1], 'days') === 1; index -= 1) currentStreak += 1;
    }
    return { currentStreak, longestStreak, totalCheckins: dates.length, lastCheckinDate: lastDate.format('YYYY-MM-DD') };
};

const recalculateLineUserStats = async (client: any, lineUserId: string, practiceTimezone: string): Promise<LineUserStats> => {
    const { rows } = await client.query(
        `SELECT checkin_date FROM checkin_logs
         WHERE line_user_id = $1 AND checkin_date IS NOT NULL
         ORDER BY checkin_date ASC`,
        [lineUserId]
    );
    const stats = calculateLineUserStats(rows.map((row: { checkin_date: string | Date }) => row.checkin_date), practiceTimezone);
    await client.query(
        `UPDATE users
         SET current_streak = $2, longest_streak = $3, total_checkins = $4, last_checkin_date = $5
         WHERE line_user_id = $1`,
        [lineUserId, stats.currentStreak, stats.longestStreak, stats.totalCheckins, stats.lastCheckinDate]
    );
    return stats;
};

export const saveLineCheckin = async (
    lineUserId: string,
    methodIds: number[],
    practiceNote: string,
    checkinDate?: unknown
) => {
    const uniqueMethodIds = Array.from(new Set(methodIds.filter((id) => Number.isFinite(id) && id > 0)));

    if (uniqueMethodIds.length === 0) {
        throw new Error('At least one practice method must be selected');
    }

    const leafCodesByParentCode = await getLeafCodesByParentCode();
    const client = await db.getClient();

    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lineUserId]);
        const userSettings = await client.query(
            `SELECT COALESCE(practice_timezone, 'Asia/Taipei') AS practice_timezone,
                    COALESCE(practice_timezone_confirmed, FALSE) AS practice_timezone_confirmed
             FROM users WHERE line_user_id = $1 FOR UPDATE`,
            [lineUserId]
        );
        const practiceTimezone = userSettings.rows[0]?.practice_timezone || 'Asia/Taipei';
        const settings = { ...getPracticeDateWindow(practiceTimezone), confirmed: Boolean(userSettings.rows[0]?.practice_timezone_confirmed) };
        const target = validateCheckinDate(checkinDate, settings);
        if (!settings.confirmed && target.entryKind === 'makeup') throw new Error('Confirm your practice timezone before making up yesterday');

        const methodRows = await client.query(
            `SELECT id, code, name_zh, method_type
             FROM practice_methods
             WHERE id = ANY($1::int[]) AND is_active = TRUE
             ORDER BY sort_order ASC, id ASC`,
            [uniqueMethodIds]
        );

        if (methodRows.rows.length !== uniqueMethodIds.length) {
            throw new Error('One or more selected practice methods are invalid');
        }

        if (methodRows.rows.some((row) => row.method_type !== 'leaf')) {
            throw new Error('Only leaf practice methods can be selected');
        }

        const methodNames = methodRows.rows.map((row) => row.name_zh);
        const methodCodes = methodRows.rows.map((row) => row.code);
        const note = buildLegacyNote(methodNames, practiceNote);

        const existing = await client.query(
            `SELECT id, entry_kind, practice_timezone
             FROM checkin_logs
             WHERE line_user_id = $1 AND checkin_date = $2`,
            [lineUserId, target.checkinDate]
        );

        let checkinLogId: number;
        let alreadyCheckedIn = false;
        let entryKind = target.entryKind;
        let savedPracticeTimezone = settings.practiceTimezone;

        if (existing.rows.length > 0) {
            alreadyCheckedIn = true;
            checkinLogId = existing.rows[0].id;
            entryKind = existing.rows[0].entry_kind === 'makeup' ? 'makeup' : 'regular';
            savedPracticeTimezone = existing.rows[0].practice_timezone || savedPracticeTimezone;

            await client.query(
                `UPDATE checkin_logs
                 SET practice_note = $1,
                     reflection_note = $1,
                     body_feeling_note = NULL,
                      note = $2,
                      source = 'liff',
                      practice_timezone = COALESCE(practice_timezone, $4),
                      updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [practiceNote || null, note || null, checkinLogId, savedPracticeTimezone]
            );

            await client.query(`DELETE FROM checkin_method_selections WHERE checkin_log_id = $1`, [checkinLogId]);

        } else {
            const inserted = await client.query(
                `INSERT INTO checkin_logs
                    (line_user_id, checkin_date, practice_note, reflection_note, body_feeling_note, note, source, entry_kind, practice_timezone)
                 VALUES ($1, $2, $3, $3, NULL, $4, 'liff', $5, $6)
                 RETURNING id`,
                [lineUserId, target.checkinDate, practiceNote || null, note || null, target.entryKind, settings.practiceTimezone]
            );
            checkinLogId = inserted.rows[0].id;
        }

        for (const methodId of uniqueMethodIds) {
            await client.query(
                `INSERT INTO checkin_method_selections (checkin_log_id, practice_method_id)
                 VALUES ($1, $2)
                 ON CONFLICT (checkin_log_id, practice_method_id) DO NOTHING`,
                [checkinLogId, methodId]
            );
        }

        const stats = await recalculateLineUserStats(client, lineUserId, settings.practiceTimezone);
        const beforeBadges = await client.query('SELECT badge_id, earned_year FROM user_badges WHERE line_user_id = $1', [lineUserId]);
        const beforeBadgeKeys = new Set(beforeBadges.rows.map((row: any) => `${row.badge_id}:${row.earned_year}`));
        await evaluateBadges(lineUserId, note, methodCodes, {
            checkinDate: target.checkinDate,
            entryKind,
            practiceTimezone: savedPracticeTimezone,
            queryable: client,
            leafCodesByParentCode
        });
        const afterBadges = await client.query(
            `SELECT ub.badge_id, ub.earned_year, b.name, b.emoji, b.description
             FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
             WHERE ub.line_user_id = $1`,
            [lineUserId]
        );
        const unlockedBadges = afterBadges.rows
            .filter((row: any) => !beforeBadgeKeys.has(`${row.badge_id}:${row.earned_year}`))
            .map((row: any) => ({ badgeId: row.badge_id, earnedYear: row.earned_year, name: row.name, emoji: row.emoji || '', description: row.description || '' }));

        await client.query('COMMIT');

        return {
            date: target.checkinDate,
            checkinLogId,
            alreadyCheckedIn,
            selectedMethods: methodNames,
            selectedMethodCodes: methodCodes,
            stats,
            entryKind,
            practiceTimezone: savedPracticeTimezone,
            unlockedBadges
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const saveTodayLineCheckin = async (lineUserId: string, methodIds: number[], practiceNote: string) =>
    saveLineCheckin(lineUserId, methodIds, practiceNote);

export const saveLegacyTextCheckin = async (lineUserId: string, note: string) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lineUserId]);
        const userSettings = await client.query(
            `SELECT COALESCE(practice_timezone, 'Asia/Taipei') AS practice_timezone
             FROM users WHERE line_user_id = $1 FOR UPDATE`,
            [lineUserId]
        );
        const practiceTimezone = userSettings.rows[0]?.practice_timezone || 'Asia/Taipei';
        const settings = getPracticeDateWindow(practiceTimezone);
        const existing = await client.query(
            'SELECT id FROM checkin_logs WHERE line_user_id = $1 AND checkin_date = $2',
            [lineUserId, settings.today]
        );
        if (existing.rows.length) {
            const { rows } = await client.query(
                `SELECT current_streak, longest_streak, total_checkins, last_checkin_date
                 FROM users WHERE line_user_id = $1`,
                [lineUserId]
            );
            await client.query('ROLLBACK');
            const row = rows[0] || {};
            return {
                alreadyCheckedIn: true,
                date: settings.today,
                entryKind: 'regular' as const,
                practiceTimezone: settings.practiceTimezone,
                stats: {
                    currentStreak: Number(row.current_streak || 0),
                    longestStreak: Number(row.longest_streak || 0),
                    totalCheckins: Number(row.total_checkins || 0),
                    lastCheckinDate: row.last_checkin_date ? moment(row.last_checkin_date).format('YYYY-MM-DD') : null
                }
            };
        }
        await client.query(
            `INSERT INTO checkin_logs
                (line_user_id, checkin_date, note, practice_note, reflection_note, source, entry_kind, practice_timezone)
             VALUES ($1, $2, $3, $3, $3, 'text', 'regular', $4)`,
            [lineUserId, settings.today, note, settings.practiceTimezone]
        );
        const stats = await recalculateLineUserStats(client, lineUserId, settings.practiceTimezone);
        await client.query('COMMIT');
        return { alreadyCheckedIn: false, date: settings.today, entryKind: 'regular' as const, practiceTimezone: settings.practiceTimezone, stats };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const evaluateLineLiffBadges = async (
    lineUserId: string,
    selectedMethods: string[],
    selectedMethodCodes: string[] = [],
    context: { checkinDate?: string; entryKind?: 'regular' | 'makeup'; practiceTimezone?: string } = {}
) => {
    const note = buildLegacyNote(selectedMethods);
    await evaluateBadges(lineUserId, note, selectedMethodCodes, context);
};
