import { generateCheckinFeedback } from '../services/qigongRagService';
import { Request, Router } from 'express';
import { getLineCheckinForDate, getPracticeMethods, getTodayLineCheckin, saveLineCheckin, upsertLineUser, mergeLegacyPracticeNotes } from '../services/lineCheckin';
import { db } from '../db';
import moment from 'moment-timezone';
import { buildUserMethodReview, getUserMethodAnalysis, getUserPracticeJournal } from '../services/methodStats';
import { generateMethodReviewWithLlm } from '../services/methodReviewLlm';
import { getPracticeFeelingTags } from '../services/practiceFeelingTags';
import { getPracticeTimezoneSettings, updatePracticeTimezone } from '../services/practiceTimezone';

const router = Router();
const lineLoginChannelId = process.env.LINE_LOGIN_CHANNEL_ID || '';

const requireVerifiedLineUser = async (req: Request, res: any, next: any) => {
    const accessToken = req.header('x-line-access-token') || '';
    if (!accessToken) return res.status(401).json({ error: 'Missing LINE access token' });
    try {
        const [verifyResponse, profileResponse] = await Promise.all([
            fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`),
            fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } })
        ]);
        if (!verifyResponse.ok || !profileResponse.ok) return res.status(401).json({ error: 'Invalid LINE access token' });
        const verification = await verifyResponse.json() as { client_id?: string; expires_in?: number };
        if (!lineLoginChannelId) return res.status(500).json({ error: 'LINE_LOGIN_CHANNEL_ID is not configured' });
        if (!Number.isFinite(verification.expires_in) || Number(verification.expires_in) <= 0) {
            return res.status(401).json({ error: 'Expired LINE access token' });
        }
        if (!verification.client_id || String(verification.client_id) !== lineLoginChannelId) {
            return res.status(401).json({ error: 'LINE access token belongs to another channel' });
        }
        const profile = await profileResponse.json() as { userId?: string; displayName?: string };
        if (!profile.userId) return res.status(401).json({ error: 'Invalid LINE profile' });
        (req as any).verifiedLineProfile = profile;
        next();
    } catch (error) {
        console.error('[liff-api] LINE token verification failed', error);
        res.status(503).json({ error: 'LINE identity verification unavailable' });
    }
};

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
    const verified = (req as any).verifiedLineProfile as { userId?: string; displayName?: string } | undefined;
    if (verified?.userId) return { lineUserId: verified.userId, displayName: verified.displayName || '' };
    const lineUserId = (req.header('x-line-user-id') || req.body?.lineUserId || req.query?.lineUserId || '').toString();
    const displayName = (req.header('x-line-display-name') || req.body?.displayName || req.query?.displayName || '').toString();
    return { lineUserId, displayName };
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

router.get('/profile', requireVerifiedLineUser, async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);
        res.json(await getPracticeTimezoneSettings(lineUserId));
    } catch (error) {
        console.error('[liff-api] failed to load profile', error);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

router.patch('/profile/practice-timezone', requireVerifiedLineUser, async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);
        res.json(await updatePracticeTimezone(lineUserId, req.body?.timezone));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update practice timezone';
        res.status(message.includes('timezone') || message.includes('24 hours') || message.includes('calendar date') ? 400 : 500).json({ error: message });
    }
});

router.get('/practice-feeling-tags', async (_req, res) => {
    try {
        res.json({ tags: await getPracticeFeelingTags() });
    } catch (error) {
        console.error('[liff-api] failed to load practice feeling tags', error);
        res.status(500).json({ error: 'Failed to load practice feeling tags' });
    }
});

router.get('/checkin/today', requireVerifiedLineUser, async (req, res) => {
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

router.get('/checkin', requireVerifiedLineUser, async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);
        const settings = await getPracticeTimezoneSettings(lineUserId);
        const requestedDate = typeof req.query.date === 'string' ? req.query.date : settings.today;
        res.json(await getLineCheckinForDate(lineUserId, requestedDate));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load check-in';
        res.status(message.includes('date') || message.includes('window') || message.includes('eligible') || message.includes('timezone') ? 400 : 500).json({ error: message });
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
    const startDate = moment(start).tz(TIMEZONE).format('YYYY-MM-DD');
    const endDate = moment(end).tz(TIMEZONE).format('YYYY-MM-DD');
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
            SELECT u.display_name, COUNT(DISTINCT COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1))) AS value
            FROM checkin_logs c
            JOIN users u ON u.line_user_id = c.line_user_id
            WHERE COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) >= $2::date
              AND COALESCE(c.checkin_date, DATE(c.created_at AT TIME ZONE $1)) < $3::date
            GROUP BY u.display_name
            ORDER BY value DESC, u.display_name ASC
            LIMIT 10;
        `;
        const { rows } = await db.query(query, [TIMEZONE, moment(range.start).tz(TIMEZONE).format('YYYY-MM-DD'), moment(range.end).tz(TIMEZONE).format('YYYY-MM-DD')]);
        res.json({ period, rankBy, label: range.label, displayRange: range.displayRange, entries: rows.map((r) => ({ displayName: r.display_name, value: Number(r.value) })) });
    } catch (error) {
        console.error('[liff-api] failed to load leaderboard', error);
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

router.get('/history', requireVerifiedLineUser, async (req, res) => {
    try {
        const { lineUserId } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });

        const practiceTimezone = (await getPracticeTimezoneSettings(lineUserId)).practiceTimezone;
        const now = moment().tz(practiceTimezone);
        const monthParam = req.query.month?.toString();
        let targetMonth: moment.Moment;
        if (monthParam) {
            targetMonth = moment.tz(monthParam, 'YYYY-MM', practiceTimezone);
            if (!targetMonth.isValid()) targetMonth = now.clone();
        } else {
            targetMonth = now.clone();
        }

        const monthStart = targetMonth.clone().startOf('month').format('YYYY-MM-DD');
        const monthEnd = targetMonth.clone().endOf('month').format('YYYY-MM-DD');

        const logs = await db.query(
            `SELECT cl.id, cl.checkin_date, cl.note, cl.practice_note, cl.source,
                    cl.entry_kind, cl.practice_timezone, cl.created_at,
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
            currentMonth: now.format('YYYY-MM'),
            monthLabel: targetMonth.format('YYYY年 MM月'),
            entries: logs.rows.map((row) => ({
                id: row.id,
                date: row.checkin_date,
                methodNames: row.method_names.filter((n: string | null) => n !== null),
                note: row.note,
                practiceNote: row.practice_note,
                reflectionNote: row.practice_note,
                bodyFeelingNote: '',
                source: row.source,
                entryKind: row.entry_kind === 'makeup' ? 'makeup' : 'regular',
                practiceTimezone: row.practice_timezone || practiceTimezone,
                recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
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

router.get('/method-analysis', requireVerifiedLineUser, async (req, res) => {
    try {
        const { lineUserId, displayName } = resolveLineUser(req);
        if (!lineUserId) return res.status(400).json({ error: 'Missing lineUserId' });
        await upsertLineUser(lineUserId, displayName || null);
        const timezone = (await getPracticeTimezoneSettings(lineUserId)).practiceTimezone;

        const [analysis30d, analysis90d, journal] = await Promise.all([
            getUserMethodAnalysis(lineUserId, '30d', timezone),
            getUserMethodAnalysis(lineUserId, '90d', timezone),
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

router.get('/achievements', requireVerifiedLineUser, async (req, res) => {
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

router.post('/checkin', requireVerifiedLineUser, async (req, res) => {
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

        const saved = await saveLineCheckin(lineUserId, methodIds, practiceNote, req.body?.checkinDate);
        let coachFeedback: string | null = null;
        if (practiceNote && practiceNote.trim().length >= 3) {
            coachFeedback = await generateCheckinFeedback(saved.selectedMethods, practiceNote);
        }
        res.json({ ok: true, ...saved, coachFeedback });
    } catch (error) {
        console.error('[liff-api] failed to save checkin', error);
        res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to save check-in' });
    }
});

export default router;
