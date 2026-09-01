import moment from 'moment-timezone';
import { db } from '../db';

const TIMEZONE = 'Asia/Taipei';

// 1. Method Dictionary Definition
export const methodDictionary = [
    { name: '大雁功', aliases: ['大雁功', '大雁初', '大雁高', '大雁初高', '大雁初級', '大雁高級'] },
    { name: '五禽戲', aliases: ['五禽戲', '鶴戲', '猿戲', '虎戲', '熊戲', '鹿戲'] },
    { name: '回春功', aliases: ['回春功', '回春', '回春初', '回春中'] },
    { name: '龜壽功', aliases: ['龜壽功', '八卦功', '乾坤功', '鳳翔與龜縮'] },
    { name: '正陽功', aliases: ['正陽功', '正陽晨功', '晨功', '夜功'] },
    { name: '神奇晃海功', aliases: ['神奇晃海功', '晃海功', '晃海'] },
    { name: '蓮花養心法', aliases: ['蓮花養心法', '蓮花', '蓮花功'] },
    { name: '和氣舒壓法', aliases: ['和氣舒壓法', '和氣', '舒壓法'] },
    { name: '三窩功', aliases: ['三窩功'] },
    { name: '六音理臟法', aliases: ['六音理臟法'] },
    { name: '靜功', aliases: ['靜功', '周天靜功', '七星心法', '鬆靜功'] }
];

const leafMethodCatalog = [
    '大雁初',
    '大雁高',
    '鶴戲',
    '猿戲',
    '虎戲',
    '熊戲',
    '鹿戲',
    '回春初',
    '回春中',
    '八卦功',
    '乾坤功',
    '鳳翔與龜縮',
    '晨功',
    '夜功',
    '神奇晃海功',
    '蓮花養心法',
    '和氣舒壓法',
    '三窩功',
    '六音理臟法',
    '周天靜功',
    '七星心法',
    '鬆靜功'
];

export type MethodPeriod = '30d' | '90d' | 'month' | 'quarter' | 'year';

export interface UserPracticeJournalEntry {
    id: number;
    lineUserId?: string;
    displayName?: string;
    date: string;
    recordedAt: string;
    methodNames: string[];
    reflectionNote: string;
    bodyFeelingNote: string;
}

export interface AdminPracticeJournalPage {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    entries: UserPracticeJournalEntry[];
}

interface PeriodRange {
    start: Date;
    end: Date;
}

export const getMethodPeriodRange = (period: MethodPeriod): PeriodRange => {
    const now = moment().tz(TIMEZONE);
    let start, end;

    switch (period) {
        case '30d':
            start = now.clone().subtract(29, 'days').startOf('day');
            end = now.clone().add(1, 'millisecond'); // Up to now
            break;
        case '90d':
            start = now.clone().subtract(89, 'days').startOf('day');
            end = now.clone().add(1, 'millisecond');
            break;
        case 'month':
            start = now.clone().startOf('month');
            end = now.clone().endOf('month').add(1, 'millisecond');
            break;
        case 'quarter':
            start = now.clone().startOf('quarter');
            end = now.clone().endOf('quarter').add(1, 'millisecond');
            break;
        case 'year':
            start = now.clone().startOf('year');
            end = now.clone().endOf('year').add(1, 'millisecond');
            break;
        default:
            start = now.clone().subtract(29, 'days').startOf('day');
            end = now.clone().add(1, 'millisecond');
            break;
    }
    return { start: start.toDate(), end: end.toDate() };
};

// Helper: generate CTE for dictionary to join with
const getDictCTE = () => {
    const values = methodDictionary.map(m => `('${m.name}', ARRAY[${m.aliases.map(a => `'${a}'`).join(',')}])`).join(',\n');
    return `
        WITH method_dict AS (
            SELECT * FROM (VALUES ${values}) AS t(method_name, aliases)
        )
    `;
};

export const getCommunityMethodSummary = async (period: MethodPeriod = '30d') => {
    const { start, end } = getMethodPeriodRange(period);
    
    // Total checkin days for community in period
    const totalDaysQuery = `
        SELECT COUNT(DISTINCT line_user_id || DATE(created_at AT TIME ZONE $1)) AS total_checkin_days
        FROM checkin_logs
        WHERE created_at >= $2 AND created_at < $3
    `;
    const totalRes = await db.query(totalDaysQuery, [TIMEZONE, start, end]);
    const totalCheckinDays = parseInt(totalRes.rows[0]?.total_checkin_days || '0');

    const query = `
        ${getDictCTE()},
        structured AS (
            SELECT DISTINCT l.line_user_id, l.checkin_date AS local_date, COALESCE(parent_pm.name_zh, pm.name_zh) AS method_name
            FROM checkin_logs l
            JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            JOIN practice_methods pm ON pm.id = s.practice_method_id
            LEFT JOIN practice_methods parent_pm ON parent_pm.id = pm.parent_id
            WHERE l.created_at >= $2 AND l.created_at < $3
        ),
        fallback_logs AS (
            SELECT l.id, l.line_user_id, (l.created_at AT TIME ZONE $1)::date AS local_date, COALESCE(l.note, '') AS note
            FROM checkin_logs l
            LEFT JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            WHERE l.created_at >= $2 AND l.created_at < $3 AND s.id IS NULL
        ),
        fallback_matched AS (
            SELECT DISTINCT l.line_user_id, l.local_date, md.method_name
            FROM fallback_logs l
            JOIN method_dict md ON EXISTS (
                SELECT 1 FROM unnest(md.aliases) a WHERE l.note ILIKE '%' || a || '%'
            )
        ),
        matched AS (
            SELECT * FROM structured
            UNION ALL
            SELECT * FROM fallback_matched
        )
        SELECT method_name, COUNT(*) AS matched_days
        FROM matched
        GROUP BY method_name
        ORDER BY matched_days DESC
    `;
    const { rows } = await db.query(query, [TIMEZONE, start, end]);
    
    const totalMatched = rows.reduce((sum, r) => sum + parseInt(r.matched_days), 0);
    
    const methodDistribution = rows.map(r => ({
        methodName: r.method_name,
        matchedDays: parseInt(r.matched_days),
        compositionRatio: totalMatched > 0 ? (parseInt(r.matched_days) / totalMatched) : 0
    }));

    return {
        totalCheckinDays,
        totalMatchedMethodDays: totalMatched,
        methodDistribution
    };
};

export const searchUsersByName = async (keyword: string) => {
    const { rows } = await db.query(`
        SELECT line_user_id, display_name 
        FROM users 
        WHERE display_name ILIKE $1 
        ORDER BY total_checkins DESC 
        LIMIT 20
    `, [`%${keyword}%`]);
    return rows;
};

export const getUserMethodAnalysis = async (userId: string, period: MethodPeriod) => {
    const { start, end } = getMethodPeriodRange(period);

    const totalDaysQuery = `
        SELECT COUNT(DISTINCT COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1))) AS total_checkin_days
        FROM checkin_logs
        WHERE line_user_id = $2 AND created_at >= $3 AND created_at < $4
    `;
    const totalRes = await db.query(totalDaysQuery, [TIMEZONE, userId, start, end]);
    const totalCheckinDays = parseInt(totalRes.rows[0]?.total_checkin_days || '0');

    const query = `
        ${getDictCTE()},
        structured AS (
            SELECT DISTINCT l.checkin_date AS local_date, COALESCE(parent_pm.name_zh, pm.name_zh) AS method_name
            FROM checkin_logs l
            JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            JOIN practice_methods pm ON pm.id = s.practice_method_id
            LEFT JOIN practice_methods parent_pm ON parent_pm.id = pm.parent_id
            WHERE l.line_user_id = $2 AND l.created_at >= $3 AND l.created_at < $4
        ),
        fallback_logs AS (
            SELECT l.id, (l.created_at AT TIME ZONE $1)::date AS local_date, COALESCE(l.note, '') AS note
            FROM checkin_logs l
            LEFT JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            WHERE l.line_user_id = $2 AND l.created_at >= $3 AND l.created_at < $4 AND s.id IS NULL
        ),
        fallback_matched AS (
            SELECT DISTINCT l.local_date, md.method_name
            FROM fallback_logs l
            JOIN method_dict md ON EXISTS (
                SELECT 1 FROM unnest(md.aliases) a WHERE l.note ILIKE '%' || a || '%'
            )
        ),
        matched AS (
            SELECT * FROM structured
            UNION ALL
            SELECT * FROM fallback_matched
        )
        SELECT method_name, COUNT(*) AS matched_days
        FROM matched
        GROUP BY method_name
        ORDER BY matched_days DESC
    `;
    const { rows } = await db.query(query, [TIMEZONE, userId, start, end]);

    const totalMatched = rows.reduce((sum, r) => sum + parseInt(r.matched_days), 0);

    const methods = rows.map(r => {
        const matchedDays = parseInt(r.matched_days);
        return {
            methodName: r.method_name,
            matchedDays,
            attendanceRatio: totalCheckinDays > 0 ? (matchedDays / totalCheckinDays) : 0,
            compositionRatio: totalMatched > 0 ? (matchedDays / totalMatched) : 0
        };
    });

    return {
        totalCheckinDays,
        totalMatchedMethodDays: totalMatched,
        methods,
        top3Methods: methods.slice(0, 3)
    };
};

export const getUserPracticeJournal = async (userId: string, limit = 12): Promise<UserPracticeJournalEntry[]> => {
    const { rows } = await db.query(
        `SELECT c.id,
                c.checkin_date,
                COALESCE(c.updated_at, c.created_at) AS recorded_at,
                c.reflection_note,
                c.body_feeling_note,
                ARRAY_AGG(pm.name_zh ORDER BY pm.sort_order ASC, pm.id ASC)
                    FILTER (WHERE pm.id IS NOT NULL) AS method_names
         FROM checkin_logs c
         LEFT JOIN checkin_method_selections s ON s.checkin_log_id = c.id
         LEFT JOIN practice_methods pm ON pm.id = s.practice_method_id
         WHERE c.line_user_id = $1
           AND (
               COALESCE(BTRIM(c.reflection_note), '') <> ''
               OR COALESCE(BTRIM(c.body_feeling_note), '') <> ''
           )
         GROUP BY c.id
         ORDER BY c.checkin_date DESC
         LIMIT $2`,
        [userId, limit]
    );

    return rows.map((row) => ({
        id: Number(row.id),
        date: row.checkin_date,
        recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
        methodNames: Array.isArray(row.method_names)
            ? row.method_names.filter((name: string | null) => typeof name === 'string')
            : [],
        reflectionNote: row.reflection_note || '',
        bodyFeelingNote: row.body_feeling_note || ''
    }));
};

export const getAdminPracticeJournal = async (page = 1, limit = 20): Promise<AdminPracticeJournalPage> => {
    const offset = (page - 1) * limit;

    const countRes = await db.query(
        `SELECT COUNT(*) AS total
         FROM checkin_logs c
         WHERE COALESCE(BTRIM(c.reflection_note), '') <> ''
            OR COALESCE(BTRIM(c.body_feeling_note), '') <> ''`
    );
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const { rows } = await db.query(
        `SELECT c.id,
                c.line_user_id,
                u.display_name,
                c.checkin_date,
                COALESCE(c.updated_at, c.created_at) AS recorded_at,
                c.reflection_note,
                c.body_feeling_note,
                ARRAY_AGG(pm.name_zh ORDER BY pm.sort_order ASC, pm.id ASC)
                    FILTER (WHERE pm.id IS NOT NULL) AS method_names
         FROM checkin_logs c
         JOIN users u ON u.line_user_id = c.line_user_id
         LEFT JOIN checkin_method_selections s ON s.checkin_log_id = c.id
         LEFT JOIN practice_methods pm ON pm.id = s.practice_method_id
         WHERE COALESCE(BTRIM(c.reflection_note), '') <> ''
            OR COALESCE(BTRIM(c.body_feeling_note), '') <> ''
         GROUP BY c.id, u.line_user_id, u.display_name
         ORDER BY COALESCE(c.updated_at, c.created_at) DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
    );

    return {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        entries: rows.map((row) => ({
            id: Number(row.id),
            lineUserId: row.line_user_id,
            displayName: row.display_name || 'Unknown',
            date: row.checkin_date,
            recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
            methodNames: Array.isArray(row.method_names)
                ? row.method_names.filter((name: string | null) => typeof name === 'string')
                : [],
            reflectionNote: row.reflection_note || '',
            bodyFeelingNote: row.body_feeling_note || ''
        }))
    };
};

export const buildUserMethodReview = (analysis30d: any, analysis90d: any): string => {
    if (analysis30d.methods.length === 0) {
        return "最近 30 天內沒有辨識到任何特定的功法紀錄，請記得在打卡時填寫功法名稱喔！";
    }

    const topMethod = analysis30d.top3Methods[0];
    let review = "";

    // Classification based on composition ratio of top method
    if (topMethod.compositionRatio >= 0.6) {
        review = `你最近以「${topMethod.methodName}」為主，練功重心很明確，節奏相當穩定。`;
    } else if (analysis30d.methods.length >= 3 && topMethod.compositionRatio <= 0.4) {
        review = `你最近各功法分布相對平均，整體練功配置相當均衡。`;
    } else {
        review = `你最近主要修練「${topMethod.methodName}」，搭配其他功法輔助，維持得很好。`;
    }

    // Compare with 90d if available
    if (analysis90d.methods.length > 0) {
        const top90d = analysis90d.top3Methods[0];
        if (topMethod.methodName !== top90d.methodName) {
            review += ` 相比過去 90 天，你的重心從「${top90d.methodName}」轉移了，是一個新的修練階段。`;
        }
    }

    // Recommendation (randomly pick one they haven't practiced much)
    const allDictNames = leafMethodCatalog;
    const practicedNames = analysis30d.methods.map((m: any) => m.methodName);
    const unpracticed = allDictNames.filter(name => !practicedNames.includes(name));
    
    if (unpracticed.length > 0 && topMethod.compositionRatio > 0.5) {
        review += `\n💡 下個階段可適度加入「${unpracticed[0]}」，讓舒展與調和更完整。`;
    }

    return review;
};
