import moment from 'moment-timezone';
import { db } from '../db';

const DEFAULT_TIMEZONE = 'Asia/Taipei';
const MAKEUP_CUTOFF_HOUR = 12;

export interface PracticeDateWindow {
    practiceTimezone: string;
    today: string;
    yesterday: string;
    canMakeupYesterday: boolean;
    makeupDeadline: string;
}

export interface PracticeTimezoneSettings extends PracticeDateWindow {
    confirmed: boolean;
}

export const isValidPracticeTimezone = (timezone: unknown): timezone is string =>
    typeof timezone === 'string' && Boolean(moment.tz.zone(timezone));

export const getPracticeDateWindow = (practiceTimezone: string, now = moment()): PracticeDateWindow => {
    if (!isValidPracticeTimezone(practiceTimezone)) throw new Error('Invalid practice timezone');
    const localNow = now.clone().tz(practiceTimezone);
    return {
        practiceTimezone,
        today: localNow.format('YYYY-MM-DD'),
        yesterday: localNow.clone().subtract(1, 'day').format('YYYY-MM-DD'),
        canMakeupYesterday: localNow.hour() < MAKEUP_CUTOFF_HOUR,
        makeupDeadline: localNow.clone().startOf('day').hour(MAKEUP_CUTOFF_HOUR).toISOString()
    };
};

export const validateCheckinDate = (value: unknown, window: PracticeDateWindow) => {
    const checkinDate = value === undefined || value === null || value === '' ? window.today : String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkinDate) || !moment(checkinDate, 'YYYY-MM-DD', true).isValid()) {
        throw new Error('Invalid check-in date');
    }
    if (checkinDate === window.today) return { checkinDate, entryKind: 'regular' as const };
    if (checkinDate === window.yesterday && window.canMakeupYesterday) return { checkinDate, entryKind: 'makeup' as const };
    if (checkinDate === window.yesterday) throw new Error('Yesterday’s make-up window closed at 12:00 local time');
    throw new Error('Check-in date must be today or an eligible yesterday');
};

export const getPracticeTimezoneSettings = async (lineUserId: string): Promise<PracticeTimezoneSettings> => {
    const { rows } = await db.query(
        `SELECT COALESCE(practice_timezone, $2) AS practice_timezone,
                COALESCE(practice_timezone_confirmed, FALSE) AS practice_timezone_confirmed
         FROM users
         WHERE line_user_id = $1`,
        [lineUserId, DEFAULT_TIMEZONE]
    );
    const row = rows[0] || {};
    const practiceTimezone = isValidPracticeTimezone(row.practice_timezone) ? row.practice_timezone : DEFAULT_TIMEZONE;
    return { ...getPracticeDateWindow(practiceTimezone), confirmed: Boolean(row.practice_timezone_confirmed) };
};

export const updatePracticeTimezone = async (lineUserId: string, timezone: unknown): Promise<PracticeTimezoneSettings> => {
    if (!isValidPracticeTimezone(timezone)) throw new Error('Unsupported practice timezone');
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lineUserId]);
        const { rows } = await client.query(
            `SELECT COALESCE(practice_timezone, $2) AS practice_timezone,
                    COALESCE(practice_timezone_confirmed, FALSE) AS practice_timezone_confirmed,
                    practice_timezone_updated_at,
                    EXISTS (SELECT 1 FROM checkin_logs l WHERE l.line_user_id = users.line_user_id) AS has_checkins
             FROM users
             WHERE line_user_id = $1
             FOR UPDATE`,
            [lineUserId, DEFAULT_TIMEZONE]
        );
        if (!rows.length) throw new Error('LINE user not found');
        const currentTimezone = isValidPracticeTimezone(rows[0].practice_timezone) ? rows[0].practice_timezone : DEFAULT_TIMEZONE;
        if (timezone === currentTimezone && rows[0].practice_timezone_confirmed) {
            await client.query('COMMIT');
            return getPracticeTimezoneSettings(lineUserId);
        }
        if (timezone !== currentTimezone && (rows[0].practice_timezone_confirmed || rows[0].has_checkins)) {
            const lastUpdated = rows[0].practice_timezone_updated_at ? moment(rows[0].practice_timezone_updated_at) : null;
            if (lastUpdated?.isAfter(moment().subtract(24, 'hours'))) throw new Error('Practice timezone can only be changed once every 24 hours');
            if (moment().tz(currentTimezone).format('YYYY-MM-DD') !== moment().tz(timezone).format('YYYY-MM-DD')) {
                throw new Error('Change practice timezone when both locations are on the same calendar date');
            }
            if (getPracticeDateWindow(currentTimezone).canMakeupYesterday !== getPracticeDateWindow(timezone).canMakeupYesterday) {
                throw new Error('Change practice timezone when both locations have the same make-up availability');
            }
        }
        await client.query(
            `UPDATE users
             SET practice_timezone = $2,
                 practice_timezone_confirmed = TRUE,
                 practice_timezone_updated_at = CURRENT_TIMESTAMP
             WHERE line_user_id = $1`,
            [lineUserId, timezone]
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    return getPracticeTimezoneSettings(lineUserId);
};
