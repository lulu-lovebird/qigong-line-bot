import { Solar } from 'lunar-javascript';
import moment from 'moment-timezone';

const TIMEZONE = 'Asia/Taipei';

export interface SanFuPeriod {
    start: moment.Moment;
    end: moment.Moment;
    totalDays: number;
}

export const getSanFuPeriod = (year: number): SanFuPeriod | null => {
    if (!Number.isInteger(year)) throw new Error(`Invalid Sanfu year: ${year}`);

    const scanStart = moment.tz(`${year}-06-20`, 'YYYY-MM-DD', true, TIMEZONE);
    const scanEnd = moment.tz(`${year}-08-31`, 'YYYY-MM-DD', true, TIMEZONE);

    let current = scanStart.clone();
    let start: moment.Moment | null = null;
    let end: moment.Moment | null = null;

    while (current.isSameOrBefore(scanEnd, 'day')) {
        const fu = Solar
            .fromYmd(current.year(), current.month() + 1, current.date())
            .getLunar()
            .getFu();
        if (fu) {
            if (!start) start = current.clone();
            end = current.clone();
        } else if (start && end) {
            break;
        }

        current.add(1, 'day');
    }

    if (!start || !end) return null;

    return {
        start,
        end,
        totalDays: end.diff(start, 'days') + 1
    };
};

export const isDateInSanFuPeriod = (now: moment.Moment) => {
    const period = getSanFuPeriod(now.year());
    if (!period) return false;
    return now.isSameOrAfter(period.start, 'day') && now.isSameOrBefore(period.end, 'day');
};
