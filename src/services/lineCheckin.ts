import moment from 'moment-timezone';
import { db } from '../db';
import { evaluateBadges } from '../badges';

const TIMEZONE = 'Asia/Taipei';

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
}

export const upsertLineUser = async (lineUserId: string, displayName?: string | null) => {
    await db.query(
        `INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)
         ON CONFLICT (line_user_id) DO UPDATE SET display_name = COALESCE($2, users.display_name)`,
        [lineUserId, displayName || null]
    );
};

const getPracticeMethodRows = async (): Promise<PracticeMethodRow[]> => {
    const { rows } = await db.queryWithRetry(
        `SELECT id, code, name_zh, name_en, estimated_minutes, parent_id, method_type
         FROM practice_methods
         WHERE is_active = TRUE
         ORDER BY sort_order ASC, id ASC`
    );

    return rows;
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

export const getTodayLineCheckin = async (lineUserId: string): Promise<TodayLineCheckinResponse> => {
    const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const { rows } = await db.queryWithRetry(
        `SELECT id, practice_note, reflection_note, body_feeling_note
         FROM checkin_logs
         WHERE line_user_id = $1 AND checkin_date = $2`,
        [lineUserId, today]
    );

    if (rows.length === 0) {
        return {
            date: today,
            alreadyCheckedIn: false,
            checkinLogId: null,
            selectedMethodIds: [],
            practiceNote: '',
            reflectionNote: '',
            bodyFeelingNote: ''
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
        date: today,
        alreadyCheckedIn: true,
        checkinLogId: checkin.id,
        selectedMethodIds: normalizedSelectedIds,
        practiceNote,
        reflectionNote: checkin.reflection_note || '',
        bodyFeelingNote: checkin.body_feeling_note || ''
    };
};

export const mergeLegacyPracticeNotes = (reflectionNote = '', bodyFeelingNote = '') => {
    const reflection = reflectionNote.trim();
    const bodyFeeling = bodyFeelingNote.trim();
    if (reflection && bodyFeeling) return `練功心得：${reflection}\n身體感受：${bodyFeeling}`;
    return reflection || bodyFeeling;
};

export const buildLegacyNote = (methodNames: string[], practiceNote = '') => {
    const parts: string[] = [];
    if (methodNames.length > 0) parts.push(`功法：${methodNames.join('、')}`);
    if (practiceNote.trim()) parts.push(`心得與感受：${practiceNote.trim()}`);
    return parts.join('；');
};

export const saveTodayLineCheckin = async (
    lineUserId: string,
    methodIds: number[],
    practiceNote: string
) => {
    const uniqueMethodIds = Array.from(new Set(methodIds.filter((id) => Number.isFinite(id) && id > 0)));

    if (uniqueMethodIds.length === 0) {
        throw new Error('At least one practice method must be selected');
    }

    const today = moment().tz(TIMEZONE);
    const todayStr = today.format('YYYY-MM-DD');
    const yesterdayStr = today.clone().subtract(1, 'day').format('YYYY-MM-DD');
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

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
            `SELECT id
             FROM checkin_logs
             WHERE line_user_id = $1 AND checkin_date = $2`,
            [lineUserId, todayStr]
        );

        let checkinLogId: number;
        let alreadyCheckedIn = false;
        let stats: { currentStreak: number; totalCheckins: number } | null = null;

        if (existing.rows.length > 0) {
            alreadyCheckedIn = true;
            checkinLogId = existing.rows[0].id;

            await client.query(
                `UPDATE checkin_logs
                 SET practice_note = $1,
                     reflection_note = $1,
                     body_feeling_note = NULL,
                     note = $2,
                     source = 'liff',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [practiceNote || null, note || null, checkinLogId]
            );

            await client.query(`DELETE FROM checkin_method_selections WHERE checkin_log_id = $1`, [checkinLogId]);

            const userStats = await client.query(
                `SELECT current_streak, total_checkins FROM users WHERE line_user_id = $1`,
                [lineUserId]
            );
            stats = {
                currentStreak: userStats.rows[0]?.current_streak || 0,
                totalCheckins: userStats.rows[0]?.total_checkins || 0
            };
        } else {
            const userRes = await client.query(
                `SELECT current_streak, longest_streak, last_checkin_date, total_checkins
                 FROM users WHERE line_user_id = $1`,
                [lineUserId]
            );
            const user = userRes.rows[0] || { current_streak: 0, longest_streak: 0, last_checkin_date: null, total_checkins: 0 };

            const inserted = await client.query(
                `INSERT INTO checkin_logs (line_user_id, checkin_date, practice_note, reflection_note, body_feeling_note, note, source)
                 VALUES ($1, $2, $3, $3, NULL, $4, 'liff')
                 RETURNING id`,
                [lineUserId, todayStr, practiceNote || null, note || null]
            );
            checkinLogId = inserted.rows[0].id;

            const lastCheckinDate = user.last_checkin_date ? moment(user.last_checkin_date).tz(TIMEZONE).format('YYYY-MM-DD') : null;
            let newStreak = 1;
            if (lastCheckinDate === yesterdayStr) {
                newStreak = (user.current_streak || 0) + 1;
            }
            const newLongestStreak = Math.max(newStreak, user.longest_streak || 0);
            const newTotal = (user.total_checkins || 0) + 1;

            await client.query(
                `UPDATE users
                 SET current_streak = $1,
                     longest_streak = $2,
                     total_checkins = $3,
                     last_checkin_date = $4
                 WHERE line_user_id = $5`,
                [newStreak, newLongestStreak, newTotal, todayStr, lineUserId]
            );

            stats = {
                currentStreak: newStreak,
                totalCheckins: newTotal
            };
        }

        for (const methodId of uniqueMethodIds) {
            await client.query(
                `INSERT INTO checkin_method_selections (checkin_log_id, practice_method_id)
                 VALUES ($1, $2)
                 ON CONFLICT (checkin_log_id, practice_method_id) DO NOTHING`,
                [checkinLogId, methodId]
            );
        }

        await client.query('COMMIT');

        return {
            date: todayStr,
            checkinLogId,
            alreadyCheckedIn,
            selectedMethods: methodNames,
            selectedMethodCodes: methodCodes,
            stats
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const evaluateLineLiffBadges = async (lineUserId: string, selectedMethods: string[], selectedMethodCodes: string[] = []) => {
    const note = buildLegacyNote(selectedMethods);
    await evaluateBadges(lineUserId, note, selectedMethodCodes);
};
