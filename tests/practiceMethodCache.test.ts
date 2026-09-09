import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db';
import { getPracticeMethodRows, invalidatePracticeMethodCache } from '../src/services/lineCheckin';
import { createAsyncTtlCache } from '../src/utils/asyncTtlCache';

test('reuses and expires successful async cache values', async () => {
    let now = 100;
    let loads = 0;
    const cache = createAsyncTtlCache(50, () => now);
    const loader = async () => ++loads;

    assert.equal(await cache.get(loader), 1);
    now = 149;
    assert.equal(await cache.get(loader), 1);
    now = 150;
    assert.equal(await cache.get(loader), 2);
});

test('coalesces concurrent loads and retries after failure', async () => {
    let resolveLoad: ((value: number) => void) | undefined;
    let loads = 0;
    const cache = createAsyncTtlCache<number>(300000);
    const loader = () => {
        loads += 1;
        return new Promise<number>((resolve) => { resolveLoad = resolve; });
    };

    const first = cache.get(loader);
    const second = cache.get(loader);
    assert.equal(loads, 1);
    resolveLoad?.(7);
    assert.deepEqual(await Promise.all([first, second]), [7, 7]);

    cache.invalidate();
    await assert.rejects(cache.get(async () => { throw new Error('temporary'); }), /temporary/);
    assert.equal(await cache.get(async () => 8), 8);
});

test('invalidation during a load prevents stale cache repopulation', async () => {
    let resolveFirst: ((value: number) => void) | undefined;
    let loads = 0;
    const cache = createAsyncTtlCache<number>(300000);
    const first = cache.get(() => {
        loads += 1;
        return new Promise<number>((resolve) => { resolveFirst = resolve; });
    });

    cache.invalidate();
    assert.equal(await cache.get(async () => ++loads), 2);
    resolveFirst?.(1);
    assert.equal(await first, 1);
    assert.equal(await cache.get(async () => ++loads), 2);
});

test('practice method loader queries once and returns isolated arrays', async () => {
    const originalQuery = db.queryWithRetry;
    let queries = 0;
    (db as { queryWithRetry: typeof db.queryWithRetry }).queryWithRetry = async () => {
        queries += 1;
        return {
            rows: [{ id: 1, code: 'dayan', name_zh: '大雁功', name_en: 'Dayan Qigong', estimated_minutes: 20, parent_id: null, method_type: 'leaf' }]
        } as Awaited<ReturnType<typeof db.queryWithRetry>>;
    };

    try {
        invalidatePracticeMethodCache();
        const [first, second] = await Promise.all([getPracticeMethodRows(), getPracticeMethodRows()]);
        assert.equal(queries, 1);
        assert.notEqual(first, second);
        first.pop();
        assert.equal(second.length, 1);
        second[0].name_zh = '已修改';
        const third = await getPracticeMethodRows();
        assert.equal(third.length, 1);
        assert.equal(third[0].name_zh, '大雁功');
    } finally {
        invalidatePracticeMethodCache();
        (db as { queryWithRetry: typeof db.queryWithRetry }).queryWithRetry = originalQuery;
    }
});
