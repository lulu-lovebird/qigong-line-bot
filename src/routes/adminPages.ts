import { Router } from 'express';
import { getOverviewStats, getLeaderboardStats, getAllUsersTotalCheckins, AdminPeriod, getAdminPeriodRange, LeaderboardLimit } from '../services/adminStats';
import moment from 'moment-timezone';

const router = Router();

const isValidPeriod = (p: any): p is AdminPeriod => {
    return ['week', 'month', 'quarter', 'year'].includes(p);
};

const parseLeaderboardLimit = (value: unknown): LeaderboardLimit => {
    const parsed = Number(value);
    if (parsed === 20 || parsed === 30) return parsed;
    return 10;
};

const parsePage = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

// Overview Page
router.get('/', async (req, res) => {
    const period = isValidPeriod(req.query.period) ? req.query.period : 'week';
    
    try {
        const data = await getOverviewStats(period);
        const range = getAdminPeriodRange(period);
        
        res.render('admin/overview', {
            i18n: req.i18n,
            lang: req.langCode,
            currentPeriod: period,
            dateRange: `${moment(range.start).format('YYYY-MM-DD')} ~ ${moment(range.end).subtract(1, 'ms').format('YYYY-MM-DD')}`,
            data,
            path: '/line/admin-dashboard'
        });
    } catch (e) {
        console.error('Error rendering admin overview page:', e);
        res.status(500).send('Server Error');
    }
});

// Leaderboard Page
router.get('/leaderboard', async (req, res) => {
    const period = isValidPeriod(req.query.period) ? req.query.period : 'week';
    const currentLimit = parseLeaderboardLimit(req.query.limit);
    const totalsPage = parsePage(req.query.page);
    
    try {
        const [data, totalsData] = await Promise.all([
            getLeaderboardStats(period, currentLimit),
            getAllUsersTotalCheckins(totalsPage, 20)
        ]);
        const range = getAdminPeriodRange(period);
        
        res.render('admin/leaderboard', {
            i18n: req.i18n,
            lang: req.langCode,
            currentPeriod: period,
            currentLimit,
            totalsData,
            dateRange: `${moment(range.start).format('YYYY-MM-DD')} ~ ${moment(range.end).subtract(1, 'ms').format('YYYY-MM-DD')}`,
            data,
            path: '/line/admin-dashboard/leaderboard'
        });
    } catch (e) {
        console.error('Error rendering admin leaderboard page:', e);
        res.status(500).send('Server Error');
    }
});

router.get('/journal', async (req, res) => {
    const period = isValidPeriod(req.query.period) ? req.query.period : 'week';

    try {
        res.render('admin/journal', {
            i18n: req.i18n,
            lang: req.langCode,
            currentPeriod: period,
            dateRange: 'Latest first',
            path: '/line/admin-dashboard/journal'
        });
    } catch (e) {
        console.error('Error rendering admin journal page:', e);
        res.status(500).send('Server Error');
    }
});

export default router;
