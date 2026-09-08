import { Request, Router } from 'express';
import { getOverviewStats, getLeaderboardStats, AdminPeriod, getAdminPeriodRange, getCheckedInUsersByDate, getPendingUsersByDate, LeaderboardLimit } from '../services/adminStats';
import { getAdminPracticeJournal } from '../services/methodStats';
import moment from 'moment-timezone';
import { getPracticeFeelingTags, savePracticeFeelingTags } from '../services/practiceFeelingTags';

const router = Router();

// Define allowed periods
const isValidPeriod = (p: any): p is AdminPeriod => {
    return ['week', 'month', 'quarter', 'year'].includes(p);
};

const parseLeaderboardLimit = (value: unknown): LeaderboardLimit => {
    const parsed = Number(value);
    if (parsed === 20 || parsed === 30) return parsed;
    return 10;
};

router.get('/overview', async (req, res) => {
    try {
        const period = req.query.period as string;
        if (!isValidPeriod(period)) {
            return res.status(400).json({ error: 'Invalid period. Use week, month, quarter, or year.' });
        }

        const data = await getOverviewStats(period);
        const range = getAdminPeriodRange(period);

        res.json({
            periodMeta: {
                start: moment(range.start).format('YYYY-MM-DD'),
                end: moment(range.end).subtract(1, 'ms').format('YYYY-MM-DD')
            },
            ...data
        });
    } catch (e) {
        console.error('Error fetching admin overview API:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/leaderboard', async (req, res) => {
    try {
        const period = req.query.period as string;
        if (!isValidPeriod(period)) {
            return res.status(400).json({ error: 'Invalid period. Use week, month, quarter, or year.' });
        }

        const data = await getLeaderboardStats(period, parseLeaderboardLimit(req.query.limit));
        const range = getAdminPeriodRange(period);

        res.json({
            periodMeta: {
                start: moment(range.start).format('YYYY-MM-DD'),
                end: moment(range.end).subtract(1, 'ms').format('YYYY-MM-DD')
            },
            ...data
        });
    } catch (e) {
        console.error('Error fetching admin leaderboard API:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const parsePage = (req: Request) => {
    const page = parseInt((req.query.page as string) || '1', 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
};

const parseLimit = (req: Request) => {
    const limit = parseInt((req.query.limit as string) || '20', 10);
    return Number.isFinite(limit) && limit > 0 && limit <= 100 ? limit : 20;
};

const parseTargetDate = (req: Request) => {
    const rawDate = (req.query.date as string) || moment().tz('Asia/Taipei').format('YYYY-MM-DD');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        throw new Error('Invalid date. Use YYYY-MM-DD.');
    }
    const parsed = moment.tz(rawDate, 'YYYY-MM-DD', true, 'Asia/Taipei');
    if (!parsed.isValid()) {
        throw new Error('Invalid date. Use YYYY-MM-DD.');
    }
    return parsed.format('YYYY-MM-DD');
};

router.get('/today-checkins', async (req, res) => {
    try {
        const data = await getCheckedInUsersByDate(parseTargetDate(req), parsePage(req), parseLimit(req));
        res.json(data);
    } catch (e) {
        console.error('Error fetching today checkins API:', e);
        if (e instanceof Error && e.message.startsWith('Invalid date')) {
            return res.status(400).json({ error: e.message });
        }
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/today-pending', async (req, res) => {
    try {
        const data = await getPendingUsersByDate(parseTargetDate(req), parsePage(req), parseLimit(req));
        res.json(data);
    } catch (e) {
        console.error('Error fetching today pending API:', e);
        if (e instanceof Error && e.message.startsWith('Invalid date')) {
            return res.status(400).json({ error: e.message });
        }
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/journal', async (req, res) => {
    try {
        const data = await getAdminPracticeJournal(parsePage(req), parseLimit(req));
        res.json(data);
    } catch (e) {
        console.error('Error fetching admin journal API:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/practice-feeling-tags', async (_req, res) => {
    try {
        res.json({ tags: await getPracticeFeelingTags(true) });
    } catch (error) {
        console.error('Error fetching practice feeling tags:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/practice-feeling-tags', async (req, res) => {
    try {
        res.json({ tags: await savePracticeFeelingTags(req.body?.tags) });
    } catch (error) {
        console.error('Error saving practice feeling tags:', error);
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid tag data' });
    }
});

export default router;
