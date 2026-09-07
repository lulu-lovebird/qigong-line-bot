import { Request, Router } from 'express';
import { getPracticeMethods, getTodayLineCheckin, saveTodayLineCheckin, upsertLineUser, evaluateLineLiffBadges, mergeLegacyPracticeNotes } from '../services/lineCheckin';
import { db } from '../db';
import moment from 'moment-timezone';
import { buildUserMethodReview, getUserMethodAnalysis, getUserPracticeJournal } from '../services/methodStats';
import { generateMethodReviewWithLlm } from '../services/methodReviewLlm';

const router = Router();

const parseMethodIds = (raw: unknown): number[] => {
    if (Array.isArray(raw)) {
        return Array.from(new Set(raw.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
    }

    if (typeof raw === 'string') {
        return Array.from(new Set(raw
            .split(',')
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isFinite(id) && id > 0)));
    }

    if (raw && typeof raw === 'object') {
        return Array.from(new Set(Object.values(raw as Record<string, unknown>)
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)));
    }

    return [];
};

const parseMethodIdsFromRequest = (req: Request): number[] => {
    const direct = parseMethodIds(req.body?.methodIds);
    if (direct.length > 0) return direct;

    const csv = req.body?.methodIdsCsv || req.body?.selectedMethodIdsCsv || req.query?.methodIdsCsv;
    const fromCsv = parseMethodIds(csv);
    if (fromCsv.length > 0) return fromCsv;

    const bracketKeys = Object.keys(req.body || {})
        .filter((key) => key.startsWith('methodIds['))
        .sort();
    if (bracketKeys.length > 0) {
        const values = bracketKeys.map((key) => req.body[key]);
        const fromBracketKeys = parseMethodIds(values);
        if (fromBracketKeys.length > 0) return fromBracketKeys;
    }

    return [];
};

const resolveLineUser = (req: Request) => {
    const lineUserId = (req.header('x-line-user-id') || req.body?.lineUserId || req.query?.lineUserId || '').toString();
    const displayName = (req.header('x-line-display-name') || req.body?.displayName || req.query?.displayName || '').toString();
    return { lineUserId, displayName };
};

const getUserBadgesSnapshot = async (lineUserId: string) => {
    const { rows } = await db.query(
        `SELECT ub.badge_id, ub.earned_year, b.name, b.emoji, b.description
         FROM user_badges ub
         JOIN badges b ON b.id = ub.badge_id
         WHERE ub.line_user_id = $1`,
        [lineUserId]
    );

    return rows.map((row) => ({
        key: `${row.badge_id}:${row.earned_year}`,
        badgeId: row.badge_id,
        earnedYear: row.earned_year,
        name: row.name,
        emoji: row.emoji || '',
        description: row.description || ''
    }));
};

router.get('/practice-methods', async (req, res) => {
    const startedAt = Date.now();
    try {
        const methods = await getPracticeMethods();
        console.log(`[liff-api] loaded practice methods in ${Date.now() - startedAt}ms (${methods.length} roots)`);
        res.json({ methods });
    } catch (error) {
        console.error(`[liff-api] failed to load practice methods after ${Date.now() - startedAt}ms`, error);
        res.status(500).json({ error: 'Failed to load practice methods' });
    }
});

router.get('/checkin/today', async (req, res) => {
    const startedAt = Date.now();
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);
        const data = await getTodayLineCheckin(lineUserId);
        console.log(`[liff-api] loaded today checkin in ${Date.now() - startedAt}ms for ${lineUserId}`);
        res.json(data);
    } catch (error) {
        console.error(`[liff-api] failed to load today checkin after ${Date.now() - startedAt}ms`, error);
        res.status(500).json({ error: 'Failed to load today checkin' });
    }
});

const TIMEZONE = 'Asia/Taipei';

const getPeriodRange = (period: string) => {
    const now = moment().tz(TIMEZONE);
    switch (period) {
        case 'week': {
            const start = now.clone().startOf('isoWeek');
            const end = now.clone().endOf('isoWeek').add(1, 'millisecond');
            return { start: start.toDate(), end: end.toDate(), label: '本週', displayRange: `${start.format('MM/DD')} ~ ${now.clone().endOf('isoWeek').format('MM/DD')}` };
        }
        case 'month': {
            const start = now.clone().startOf('month');
            const end = now.clone().endOf('month').add(1, 'millisecond');
            return { start: start.toDate(), end: end.toDate(), label: '本月', displayRange: `${start.format('MM/DD')} ~ ${now.clone().endOf('month').format('MM/DD')}` };
        }
        case 'quarter': {
            const start = now.clone().startOf('quarter');
            const end = now.clone().endOf('quarter').add(1, 'millisecond');
            return { start: start.toDate(), end: end.toDate(), label: '本季', displayRange: `${now.year()} Q${now.quarter()} (${start.format('MM/DD')} ~ ${now.clone().endOf('quarter').format('MM/DD')})` };
        }
        default:
            return null;
    }
};

const computeStreaksInRange = async (start: Date, end: Date) => {
    const query = `
        SELECT c.line_user_id, u.display_name, DATE(c.created_at AT TIME ZONE $1) AS d
        FROM checkin_logs c
        JOIN users u ON u.line_user_id = c.line_user_id
        WHERE c.created_at >= $2 AND c.created_at < $3
        GROUP BY c.line_user_id, u.display_name, d
        ORDER BY c.line_user_id, d ASC;
    `;
    const { rows } = await db.query(query, [TIMEZONE, start, end]);
    if (rows.length === 0) return [];

    const userStreaks = new Map<string, { displayName: string; maxStreak: number }>();
    let currentUserId = '';
    let currentDisplayName = '';
    let currentStreak = 0;
    let maxStreak = 0;
    let lastDate: moment.Moment | null = null;

    const processingRows = [...rows, { line_user_id: '__dummy__', display_name: '', d: '2000-01-01' }];
    for (const row of processingRows) {
        if (row.line_user_id !== currentUserId) {
            if (currentUserId !== '') {
                userStreaks.set(currentUserId, { displayName: currentDisplayName, maxStreak });
            }
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

    return Array.from(userStreaks.values())
        .sort((a, b) => {
            if (b.maxStreak !== a.maxStreak) return b.maxStreak - a.maxStreak;
            return a.displayName.localeCompare(b.displayName);
        })
        .slice(0, 10);
};

router.get('/leaderboard', async (req, res) => {
    try {
        const period = (req.query.period || 'all').toString();
        const rankBy = (req.query.rankBy || 'checkins').toString();

        if (period === 'all') {
            if (rankBy === 'streak') {
                const { rows } = await db.query('SELECT display_name, longest_streak AS value FROM users WHERE longest_streak > 0 ORDER BY longest_streak DESC LIMIT 10');
                return res.json({ period: 'all', rankBy, label: '總排行榜', entries: rows.map((r) => ({ displayName: r.display_name, value: Number(r.value) })) });
            }
            const { rows } = await db.query('SELECT display_name, total_checkins AS value FROM users WHERE total_checkins > 0 ORDER BY total_checkins DESC LIMIT 10');
            return res.json({ period: 'all', rankBy, label: '總排行榜', entries: rows.map((r) => ({ displayName: r.display_name, value: Number(r.value) })) });
        }

        const range = getPeriodRange(period);
        if (!range) return res.status(400).json({ error: 'Invalid period. Use week, month, quarter, or all.' });

        if (rankBy === 'streak') {
            const streaks = await computeStreaksInRange(range.start, range.end);
            return res.json({ period, rankBy, label: range.label, displayRange: range.displayRange, entries: streaks.map((s) => ({ displayName: s.displayName, value: s.maxStreak })) });
        }

        const query = `
            SELECT u.display_name, COUNT(DISTINCT DATE(c.created_at AT TIME ZONE $1)) AS value
            FROM checkin_logs c
            JOIN users u ON u.line_user_id = c.line_user_id
            WHERE c.created_at >= $2 AND c.created_at < $3
            GROUP BY u.display_name
            ORDER BY value DESC, u.display_name ASC
            LIMIT 10;
        `;
        const { rows } = await db.query(query, [TIMEZONE, range.start, range.end]);
        res.json({ period, rankBy, label: range.label, displayRange: range.displayRange, entries: rows.map((r) => ({ displayName: r.display_name, value: Number(r.value) })) });
    } catch (error) {
        console.error('[liff-api] failed to load leaderboard', error);
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

router.get('/history', async (req, res) => {
    try {
        const { lineUserId } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });

        const now = moment().tz(TIMEZONE);
        const monthParam = req.query.month?.toString();
        let targetMonth: moment.Moment;
        if (monthParam) {
            targetMonth = moment.tz(monthParam, 'YYYY-MM', TIMEZONE);
            if (!targetMonth.isValid()) targetMonth = now.clone();
        } else {
            targetMonth = now.clone();
        }

        const monthStart = targetMonth.clone().startOf('month').format('YYYY-MM-DD');
        const monthEnd = targetMonth.clone().endOf('month').format('YYYY-MM-DD');

        const logs = await db.query(
            `SELECT cl.id, cl.checkin_date, cl.note, cl.practice_note, cl.source,
                    ARRAY_AGG(pm.name_zh ORDER BY pm.sort_order ASC) AS method_names
             FROM checkin_logs cl
             LEFT JOIN checkin_method_selections cms ON cms.checkin_log_id = cl.id
             LEFT JOIN practice_methods pm ON pm.id = cms.practice_method_id
             WHERE cl.line_user_id = $1 AND cl.checkin_date >= $2 AND cl.checkin_date <= $3
             GROUP BY cl.id
             ORDER BY cl.checkin_date DESC`,
            [lineUserId, monthStart, monthEnd]
        );

        const userStats = await db.query(
            'SELECT current_streak, longest_streak, total_checkins FROM users WHERE line_user_id = $1',
            [lineUserId]
        );

        const checkinDaysInMonth = await db.query(
            'SELECT COUNT(DISTINCT checkin_date) AS count FROM checkin_logs WHERE line_user_id = $1 AND checkin_date >= $2 AND checkin_date <= $3',
            [lineUserId, monthStart, monthEnd]
        );

        const badgesRes = await db.query(
            `SELECT b.emoji, b.name, u.earned_year
             FROM user_badges u
             JOIN badges b ON u.badge_id = b.id
             WHERE u.line_user_id = $1
             ORDER BY u.unlocked_at ASC`,
            [lineUserId]
        );

        const badgeMap = new Map<string, { emoji: string; name: string; count: number; years: string[] }>();
        badgesRes.rows.forEach((badge) => {
            const key = badge.name;
            const existing: { emoji: string; name: string; count: number; years: string[] } = badgeMap.get(key) || {
                emoji: badge.emoji || '',
                name: badge.name,
                count: 0,
                years: []
            };

            existing.count += 1;
            if (badge.earned_year && badge.earned_year !== 0) {
                existing.years.push(String(badge.earned_year));
            }

            badgeMap.set(key, existing);
        });

        res.json({
            month: targetMonth.format('YYYY-MM'),
            monthLabel: targetMonth.format('YYYY年 MM月'),
            entries: logs.rows.map((row) => ({
                id: row.id,
                date: row.checkin_date,
                methodNames: row.method_names.filter((n: string | null) => n !== null),
                note: row.note,
                practiceNote: row.practice_note,
                reflectionNote: row.practice_note,
                bodyFeelingNote: '',
                source: row.source
            })),
            stats: userStats.rows[0]
                ? {
                      currentStreak: userStats.rows[0].current_streak || 0,
                      longestStreak: userStats.rows[0].longest_streak || 0,
                      totalCheckins: userStats.rows[0].total_checkins || 0,
                  }
                : null,
            checkinDaysInMonth: Number(checkinDaysInMonth.rows[0]?.count || 0),
            badges: Array.from(badgeMap.values())
        });
    } catch (error) {
        console.error('[liff-api] failed to load history', error);
        res.status(500).json({ error: 'Failed to load history' });
    }
});

router.get('/method-analysis', async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);

        const [analysis30d, analysis90d, journal] = await Promise.all([
            getUserMethodAnalysis(lineUserId, '30d'),
            getUserMethodAnalysis(lineUserId, '90d'),
            getUserPracticeJournal(lineUserId)
        ]);
        const fallbackReviewText = buildUserMethodReview(analysis30d, analysis90d);
        const reviewText = await generateMethodReviewWithLlm(analysis30d, fallbackReviewText, lineUserId);

        res.json({
            analysis30d,
            analysis90d,
            reviewText,
            journal
        });
    } catch (error) {
        console.error('[liff-api] failed to load method analysis', error);
        res.status(500).json({ error: 'Failed to load method analysis' });
    }
});

router.get('/achievements', async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);

        const [statsRes, badgesRes] = await Promise.all([
            db.query('SELECT current_streak, longest_streak, total_checkins, last_checkin_date FROM users WHERE line_user_id = $1', [lineUserId]),
            db.query(
                `SELECT b.emoji, b.name, b.description, u.earned_year
                 FROM user_badges u
                 JOIN badges b ON u.badge_id = b.id
                 WHERE u.line_user_id = $1
                 ORDER BY u.unlocked_at ASC`,
                [lineUserId]
            )
        ]);

        const statsRow = statsRes.rows[0] || {};
        const totalCheckins = Number(statsRow.total_checkins || 0);
        let levelTitle = '練氣 (Level 1)';
        let nextMilestone: { title: string; remaining: number; unit: string } | null = null;
        if (totalCheckins >= 200) {
            levelTitle = '化境 (Level 4)';
        } else if (totalCheckins >= 90) {
            levelTitle = '結丹 (Level 3)';
            nextMilestone = { title: '化境 (Level 4)', remaining: 200 - totalCheckins, unit: '天總打卡' };
        } else if (totalCheckins >= 30) {
            levelTitle = '築基 (Level 2)';
            nextMilestone = { title: '結丹 (Level 3)', remaining: 90 - totalCheckins, unit: '天總打卡' };
        } else {
            nextMilestone = { title: '築基 (Level 2)', remaining: 30 - totalCheckins, unit: '天總打卡' };
        }

        res.json({
            stats: {
                currentStreak: Number(statsRow.current_streak || 0),
                longestStreak: Number(statsRow.longest_streak || 0),
                totalCheckins,
                lastCheckinDate: statsRow.last_checkin_date ? moment(statsRow.last_checkin_date).tz(TIMEZONE).format('YYYY-MM-DD') : null
            },
            badges: badgesRes.rows,
            levelTitle,
            nextMilestone
        });
    } catch (error) {
        console.error('[liff-api] failed to load achievements', error);
        res.status(500).json({ error: 'Failed to load achievements' });
    }
});

router.post('/checkin', async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);

        const methodIds = parseMethodIdsFromRequest(req);
        const practiceNote = typeof req.body?.practiceNote === 'string'
            ? req.body.practiceNote
            : mergeLegacyPracticeNotes(
                typeof req.body?.reflectionNote === 'string' ? req.body.reflectionNote : '',
                typeof req.body?.bodyFeelingNote === 'string' ? req.body.bodyFeelingNote : ''
            );

        console.log('[liff-api] save checkin payload', {
            lineUserId,
            contentType: req.headers['content-type'],
            rawBodyKeys: Object.keys(req.body || {}),
            rawMethodIds: req.body?.methodIds,
            rawMethodIdsCsv: req.body?.methodIdsCsv,
            methodIds,
            methodCount: req.body?.methodCount,
            practiceNoteLength: practiceNote.length
        });

        const beforeBadges = await getUserBadgesSnapshot(lineUserId);
        const beforeBadgeKeys = new Set(beforeBadges.map((badge) => badge.key));

        const saved = await saveTodayLineCheckin(lineUserId, methodIds, practiceNote);
        let unlockedBadges: Array<{ badgeId: string; earnedYear: number; name: string; emoji: string; description: string }> = [];
        if (!saved.alreadyCheckedIn) {
            await evaluateLineLiffBadges(lineUserId, saved.selectedMethods, saved.selectedMethodCodes || []);
            const afterBadges = await getUserBadgesSnapshot(lineUserId);
            unlockedBadges = afterBadges
                .filter((badge) => !beforeBadgeKeys.has(badge.key))
                .map(({ key, ...badge }) => badge);
        }
        res.json({ ok: true, ...saved, unlockedBadges });
    } catch (error) {
        console.error('[liff-api] failed to save checkin', error);
        res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to save check-in' });
    }
});

export default router;
