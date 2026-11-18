const MS_PER_SECOND = 1000;

/** Seconds elapsed since `start` (a `performance.now()` reading). */
export const secondsSince = (start: number): number => (performance.now() - start) / MS_PER_SECOND;
