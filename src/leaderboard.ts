import moment from 'moment-timezone';
import { db } from './db';

const TIMEZONE = 'Asia/Taipei';

export type Period = 'week' | 'month' | 'quarter';

interface PeriodRange {
    label: string;
    start: Date;
    end: Date;
    displayRange: string;
}

const getPeriodRange = (period: Period): PeriodRange => {
    const now = moment().tz(TIMEZONE);
    let start, end, label, displayRange;

    switch (period) {
        case 'week':
            // startOf('isoWeek') starts on Monday
            start = now.clone().startOf('isoWeek');
            end = now.clone().endOf('isoWeek').add(1, 'millisecond'); // boundary exclusive
            label = '本週排行榜（週榜）';
            displayRange = `${start.format('YYYY-MM-DD')} ~ ${now.clone().endOf('isoWeek').format('YYYY-MM-DD')}`;
            break;
        case 'month':
            start = now.clone().startOf('month');
            end = now.clone().endOf('month').add(1, 'millisecond');
            label = '本月排行榜（月榜）';
            displayRange = `${start.format('YYYY-MM-DD')} ~ ${now.clone().endOf('month').format('YYYY-MM-DD')}`;
            break;
        case 'quarter':
            start = now.clone().startOf('quarter');
            end = now.clone().endOf('quarter').add(1, 'millisecond');
            label = '本季排行榜（季榜）';
            const qStr = `${now.year()} Q${now.quarter()}`;
            displayRange = `${qStr}（${start.format('YYYY-MM-DD')} ~ ${now.clone().endOf('quarter').format('YYYY-MM-DD')}）`;
            break;
    }

    return { label, start: start.toDate(), end: end.toDate(), displayRange };
};

const getTopTotals = async (start: Date, end: Date) => {
    const startDate = moment(start).tz(TIMEZONE).format('YYYY-MM-DD');
    const endDate = moment(end).tz(TIMEZONE).format('YYYY-MM-DD');
    const query = `
        SELECT u.display_name, COUNT(DISTINCT COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1))) AS total_days
        FROM checkin_logs c
        JOIN users u ON u.line_user_id = c.line_user_id
        WHERE COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) >= $2::date
          AND COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) < $3::date
        GROUP BY u.display_name
        ORDER BY total_days DESC, u.display_name ASC
        LIMIT 10;
    `;
    const { rows } = await db.query(query, [TIMEZONE, startDate, endDate]);
    return rows;
};

const getTopStreaks = async (start: Date, end: Date) => {
    const startDate = moment(start).tz(TIMEZONE).format('YYYY-MM-DD');
    const endDate = moment(end).tz(TIMEZONE).format('YYYY-MM-DD');
    // 1. Fetch all distinct check-in dates for all users in period
    const query = `
        SELECT c.line_user_id, u.display_name, COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) AS d
        FROM checkin_logs c
        JOIN users u ON u.line_user_id = c.line_user_id
        WHERE COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) >= $2::date
          AND COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) < $3::date
        GROUP BY c.line_user_id, u.display_name, d
        ORDER BY c.line_user_id, d ASC;
    `;
    const { rows } = await db.query(query, [TIMEZONE, startDate, endDate]);
    
    if (rows.length === 0) return [];

    // 2. Compute max streak per user in JS
    const userStreaks = new Map<string, { displayName: string, maxStreak: number }>();
    
    let currentUserId = '';
    let currentDisplayName = '';
    let currentStreak = 0;
    let maxStreak = 0;
    let lastDate: moment.Moment | null = null;

    // Push a dummy row at end to force flush of the last user
    const processingRows = [...rows, { line_user_id: 'dummy', display_name: '', d: '2000-01-01' }];

    for (const row of processingRows) {
        if (row.line_user_id !== currentUserId) {
            // Save previous user
            if (currentUserId !== '') {
                userStreaks.set(currentUserId, { displayName: currentDisplayName, maxStreak });
            }
            // Reset for new user
            currentUserId = row.line_user_id;
            currentDisplayName = row.display_name;
            currentStreak = 1;
            maxStreak = 1;
            lastDate = moment.tz(row.d, TIMEZONE);
        } else {
            const rowDate = moment.tz(row.d, TIMEZONE);
            if (lastDate && rowDate.diff(lastDate, 'days') === 1) {
                currentStreak++;
                if (currentStreak > maxStreak) maxStreak = currentStreak;
            } else {
                currentStreak = 1;
            }
            lastDate = rowDate;
        }
    }

    // Sort users by maxStreak descending, then name ascending
    const sorted = Array.from(userStreaks.values())
        .sort((a, b) => {
            if (b.maxStreak !== a.maxStreak) return b.maxStreak - a.maxStreak;
            return a.displayName.localeCompare(b.displayName);
        })
        .slice(0, 10);
        
    return sorted;
};

export const buildPeriodLeaderboardText = async (period: Period): Promise<string> => {
    const { label, start, end, displayRange } = getPeriodRange(period);
    
    const totals = await getTopTotals(start, end);
    const streaks = await getTopStreaks(start, end);

    let msg = `🏆 ${label}\n期間：${displayRange}\n\n`;

    if (totals.length === 0 && streaks.length === 0) {
        msg += '目前此期間尚無打卡紀錄，快來搶頭香！🔥';
        return msg;
    }

    let periodPrefix = '';
    if (period === 'week') periodPrefix = '本週';
    if (period === 'month') periodPrefix = '本月';
    if (period === 'quarter') periodPrefix = '本季';

    msg += `⭐ ${periodPrefix}總打卡天數 Top 10\n`;
    totals.forEach((r, i) => msg += `${i + 1}. ${r.display_name}（${r.total_days}天）\n`);

    msg += `\n🔥 ${periodPrefix}最長連續打卡 Top 10\n`;
    streaks.forEach((r, i) => msg += `${i + 1}. ${r.displayName}（連續${r.maxStreak}天）\n`);

    return msg.trim();
};
