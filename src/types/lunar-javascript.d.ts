declare module 'lunar-javascript' {
    export class Lunar {
        static fromDate(date: Date): Lunar;
        getFu(): string;
        getJieQi(): string;
        getNextJieQi(): any;
        getJieQiTable(): Record<string, Solar>;
    }
    
    export class Solar {
        static fromYmd(year: number, month: number, day: number): Solar;
        getLunar(): Lunar;
        toYmd(): string;
    }
}
