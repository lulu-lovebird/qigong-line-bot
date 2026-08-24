import { db } from './db';
import moment from 'moment-timezone';
import { Solar, Lunar } from 'lunar-javascript';
import { getLeafCodesByParentCode } from './services/lineCheckin';
import { methodDictionary } from './services/methodStats';
import { getSanFuPeriod } from './utils/sanfu';

const TIMEZONE = 'Asia/Taipei';

const COMBO_BADGES = [
    { badgeId: 'combo_dayan', parentCode: 'dayan' },
    { badgeId: 'combo_wuqinxi', parentCode: 'wuqinxi' },
    { badgeId: 'combo_huichun', parentCode: 'huichun' },
    { badgeId: 'combo_guishou', parentCode: 'guishou' },
    { badgeId: 'combo_zhengyang', parentCode: 'zhengyang' },
    { badgeId: 'combo_jinggong', parentCode: 'jinggong' }
] as const;

const METHOD_DAY_BADGE_GROUPS = [
    { methodName: '大雁功', prefix: 'method_dayan' },
    { methodName: '五禽戲', prefix: 'method_wuqinxi' },
    { methodName: '回春功', prefix: 'method_huichun' },
    { methodName: '龜壽功', prefix: 'method_guishou' },
    { methodName: '正陽功', prefix: 'method_zhengyang' },
    { methodName: '神奇晃海功', prefix: 'method_huanghai' },
    { methodName: '蓮花養心法', prefix: 'method_lotus' },
    { methodName: '和氣舒壓法', prefix: 'method_heqi' },
    { methodName: '三窩功', prefix: 'method_sanwo' },
    { methodName: '六音理臟法', prefix: 'method_liuyin' },
    { methodName: '靜功', prefix: 'method_jinggong' }
] as const;

const METHOD_DAY_THRESHOLDS = [7, 30, 100] as const;

const getMethodDictCTE = () => {
    const values = methodDictionary
        .map((method) => `('${method.name}', ARRAY[${method.aliases.map((alias) => `'${alias}'`).join(',')}])`)
        .join(',\n');

    return `
        WITH method_dict AS (
            SELECT * FROM (VALUES ${values}) AS t(method_name, aliases)
        )
    `;
};

// Helper to check if a user already earned a specific badge this year
const hasEarnedBadge = async (userId: string, badgeId: string, year: number): Promise<boolean> => {
    const query = 'SELECT 1 FROM user_badges WHERE line_user_id = $1 AND badge_id = $2 AND earned_year = $3';
    const { rows } = await db.query(query, [userId, badgeId, year]);
    return rows.length > 0;
};

// Helper to award a badge
const awardBadge = async (userId: string, badgeId: string, year: number) => {
    // Double check to prevent race conditions
    if (await hasEarnedBadge(userId, badgeId, year)) return;

    await db.query(
        'INSERT INTO user_badges (line_user_id, badge_id, earned_year) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, badgeId, year]
    );
};

const getUserMethodDayCounts = async (userId: string) => {
    const query = `
        ${getMethodDictCTE()},
        structured AS (
            SELECT DISTINCT l.checkin_date AS local_date, COALESCE(parent_pm.name_zh, pm.name_zh) AS method_name
            FROM checkin_logs l
            JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            JOIN practice_methods pm ON pm.id = s.practice_method_id
            LEFT JOIN practice_methods parent_pm ON parent_pm.id = pm.parent_id
            WHERE l.line_user_id = $2
        ),
        fallback_logs AS (
            SELECT l.id, COALESCE(l.checkin_date, DATE(l.created_at AT TIME ZONE $1)) AS local_date, COALESCE(l.note, '') AS note
            FROM checkin_logs l
            LEFT JOIN checkin_method_selections s ON s.checkin_log_id = l.id
            WHERE l.line_user_id = $2 AND s.id IS NULL
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
    `;

    const { rows } = await db.query(query, [TIMEZONE, userId]);
    return new Map<string, number>(rows.map((row) => [row.method_name, parseInt(row.matched_days, 10)]));
};

// The Evaluation Engine
export const evaluateBadges = async (userId: string, text: string, selectedMethodCodes: string[] = []) => {
    const now = moment().tz(TIMEZONE);
    const currentYear = now.year();

    // 1. Fetch user stats
    const { rows: userRows } = await db.query('SELECT current_streak, total_checkins FROM users WHERE line_user_id = $1', [userId]);
    if (userRows.length === 0) return;
    const { current_streak, total_checkins } = userRows[0];

    // --- STREAK BADGES ---
    if (current_streak >= 3 && !(await hasEarnedBadge(userId, 'streak_3', 0))) await awardBadge(userId, 'streak_3', 0);
    if (current_streak >= 7 && !(await hasEarnedBadge(userId, 'streak_7', 0))) await awardBadge(userId, 'streak_7', 0);
    if (current_streak >= 21 && !(await hasEarnedBadge(userId, 'streak_21', 0))) await awardBadge(userId, 'streak_21', 0);
    if (current_streak >= 100 && !(await hasEarnedBadge(userId, 'streak_100', 0))) await awardBadge(userId, 'streak_100', 0);

    // --- TOTAL BADGES ---
    if (total_checkins >= 10 && !(await hasEarnedBadge(userId, 'total_10', 0))) await awardBadge(userId, 'total_10', 0);
    if (total_checkins >= 100 && !(await hasEarnedBadge(userId, 'total_100', 0))) await awardBadge(userId, 'total_100', 0);

    // --- TIME-BASED BADGES ---
    // Fetch last 5 check-ins to check the time window
    const { rows: recentLogs } = await db.query(
        'SELECT created_at FROM checkin_logs WHERE line_user_id = $1 ORDER BY created_at DESC LIMIT 5',
        [userId]
    );

    if (recentLogs.length === 5) {
        let allMorning = true;
        let allNight = true;

        // Check each of the last 5 logs for Morning Dew and Night Serenity
        for (const log of recentLogs) {
            const logTime = moment(log.created_at).tz(TIMEZONE);
            const hour = logTime.hour();
            
            if (hour < 5 || hour >= 7) allMorning = false;
            if (hour < 21 || hour >= 23) allNight = false;
        }

        if (allMorning && current_streak >= 5 && !(await hasEarnedBadge(userId, 'time_morning', 0))) {
            await awardBadge(userId, 'time_morning', 0);
        }
        
        if (allNight && current_streak >= 5 && !(await hasEarnedBadge(userId, 'time_night', 0))) {
            await awardBadge(userId, 'time_night', 0);
        }
    }

    // --- SEASONAL BADGES ---
    // Helper to get Solar Term exact date using Lunar.fromDate mapping
    const getJieQiDateStr = (year: number, jieQiName: string): string | null => {
        // Evaluate based on mid-year to get solstices for current Gregorian year
        const lunar = Lunar.fromDate(new Date(year, 6, 1));
        const jieQi = lunar.getJieQiTable()[jieQiName];
        return jieQi ? jieQi.toYmd() : null;
    };

    const sanFuPeriod = getSanFuPeriod(currentYear);
    if (sanFuPeriod && now.isSameOrAfter(sanFuPeriod.end, 'day')) {
        if (!(await hasEarnedBadge(userId, 'seasonal_summer_27', currentYear))) {
            const { rows } = await db.query(
                `SELECT COUNT(DISTINCT COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1))) AS count
                 FROM checkin_logs
                 WHERE line_user_id = $2
                   AND COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1)) >= $3
                   AND COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1)) <= $4`,
                [TIMEZONE, userId, sanFuPeriod.start.format('YYYY-MM-DD'), sanFuPeriod.end.format('YYYY-MM-DD')]
            );
            if (parseInt(rows[0].count, 10) >= sanFuPeriod.totalDays) {
                await awardBadge(userId, 'seasonal_summer_27', currentYear);
            }
        }
    }

    const winterSolsticeStr = getJieQiDateStr(currentYear, 'DONG_ZHI'); // "冬至" inside lunar-javascript for end of year is DONG_ZHI
    if (winterSolsticeStr) {
        const winterSolstice = moment.tz(winterSolsticeStr, TIMEZONE);
        const daysSinceWinter = now.diff(winterSolstice, 'days');

        // Check if 27 days have passed since winter solstice
        if (daysSinceWinter === 27) {
            if (!(await hasEarnedBadge(userId, 'seasonal_winter_27', currentYear))) {
                const { rows } = await db.query(
                    `WITH guishou_days AS (
                        SELECT DISTINCT COALESCE(l.checkin_date, DATE(l.created_at AT TIME ZONE $1)) AS local_date
                        FROM checkin_logs l
                        LEFT JOIN checkin_method_selections s ON s.checkin_log_id = l.id
                        LEFT JOIN practice_methods pm ON pm.id = s.practice_method_id
                        WHERE l.line_user_id = $2
                          AND l.created_at >= $3
                          AND (
                              pm.code IN ('guishou', 'guishou_bagua', 'guishou_qiankun', 'guishou_fengxiang_guishuo')
                              OR COALESCE(l.note, '') LIKE ANY ($4::text[])
                          )
                    )
                    SELECT COUNT(*) AS count FROM guishou_days`,
                    [TIMEZONE, userId, winterSolstice.toDate(), ['%龜壽功%', '%八卦功%', '%乾坤功%', '%鳳翔與龜縮%']]
                );
                if (parseInt(rows[0].count) >= 27) {
                    await awardBadge(userId, 'seasonal_winter_27', currentYear);
                }
            }
        }
    }

    // --- COMBO BADGES ---
    if (selectedMethodCodes.length > 0) {
        const selectedCodeSet = new Set(selectedMethodCodes);
        const leafCodesByParentCode = await getLeafCodesByParentCode();

        for (const combo of COMBO_BADGES) {
            const requiredLeafCodes = leafCodesByParentCode.get(combo.parentCode) || [];
            if (requiredLeafCodes.length === 0) continue;
            if (!requiredLeafCodes.every((code) => selectedCodeSet.has(code))) continue;

            if (!(await hasEarnedBadge(userId, combo.badgeId, currentYear))) {
                await awardBadge(userId, combo.badgeId, currentYear);
            }
        }
    }

    // --- METHOD DAY BADGES ---
    const methodDayCounts = await getUserMethodDayCounts(userId);
    for (const group of METHOD_DAY_BADGE_GROUPS) {
        const matchedDays = methodDayCounts.get(group.methodName) || 0;
        for (const threshold of METHOD_DAY_THRESHOLDS) {
            if (matchedDays < threshold) continue;

            const badgeId = `${group.prefix}_${threshold}`;
            if (!(await hasEarnedBadge(userId, badgeId, 0))) {
                await awardBadge(userId, badgeId, 0);
            }
        }
    }
};
