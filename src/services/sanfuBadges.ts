import cron from 'node-cron';
import moment from 'moment-timezone';
import { db } from '../db';
import { getSanFuPeriod } from '../utils/sanfu';

const TIMEZONE = 'Asia/Taipei';

export const reconcileSanFuBadges = async (year: number) => {
    const period = getSanFuPeriod(year);
    if (!period) throw new Error(`Sanfu period not found for ${year}`);

    const { rows } = await db.query(
        `INSERT INTO user_badges (line_user_id, badge_id, earned_year)
         SELECT line_user_id, 'seasonal_summer_27', $5
         FROM checkin_logs
         WHERE COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1)) BETWEEN $2::date AND $3::date
         GROUP BY line_user_id
         HAVING COUNT(DISTINCT COALESCE(checkin_date, DATE(created_at AT TIME ZONE $1))) >= $4
         ON CONFLICT DO NOTHING
         RETURNING line_user_id`,
        [
            TIMEZONE,
            period.start.format('YYYY-MM-DD'),
            period.end.format('YYYY-MM-DD'),
            period.totalDays,
            year
        ]
    );
    return rows.length;
};

export const reconcileLatestCompletedSanFuBadges = async (now = moment().tz(TIMEZONE)) => {
    const currentPeriod = getSanFuPeriod(now.year());
    const year = currentPeriod && now.isAfter(currentPeriod.end, 'day') ? now.year() : now.year() - 1;
    return { year, awarded: await reconcileSanFuBadges(year) };
};

export const setupSanFuBadgeReconciliation = () => {
    const reconcile = () => reconcileLatestCompletedSanFuBadges()
        .then(({ year, awarded }) => console.log(`[sanfu-badges] reconciled year=${year} awarded=${awarded}`))
        .catch((error) => console.error('[sanfu-badges] reconciliation failed', error));

    cron.schedule('10 0 * * *', reconcile, { timezone: TIMEZONE });
    reconcile();
};
