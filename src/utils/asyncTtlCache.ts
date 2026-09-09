export const createAsyncTtlCache = <T>(ttlMs: number, now = Date.now) => {
    let value: T | undefined;
    let expiresAt = 0;
    let inFlight: Promise<T> | null = null;
    let generation = 0;

    return {
        get(loader: () => Promise<T>): Promise<T> {
            if (value !== undefined && now() < expiresAt) return Promise.resolve(value);
            if (inFlight) return inFlight;

            const loadGeneration = generation;
            const load = loader()
                .then((nextValue) => {
                    if (generation === loadGeneration) {
                        value = nextValue;
                        expiresAt = now() + ttlMs;
                    }
                    return nextValue;
                })
                .finally(() => {
                    if (inFlight === load) inFlight = null;
                });
            inFlight = load;
            return load;
        },
        invalidate() {
            generation += 1;
            value = undefined;
            expiresAt = 0;
            inFlight = null;
        }
    };
};
