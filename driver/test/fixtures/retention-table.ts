/**
 * What a closed run leaves for the next claim of the same job, one row per way the loop leaves its
 * group — the conformance table both executors run (`docker/`, `k8s/`), each row
 * through its own harness. Typed as a `Record`, so neither suite can leave a row out. `adoptable` is
 * a group the loop retained (`JobState.keepGroup`): its runner stays for the next claim to read.
 * Not a row: a group the loop finishes — docker removes its runner, kubernetes keeps the finished
 * Job for the reaper (`finishGroup`), so the two have no common outcome to pin.
 */
export const RETENTION_TABLE = {
    'a closed run whose group the loop retains': 'adoptable',
} as const;

export type RetentionRow = keyof typeof RETENTION_TABLE;

export const RETENTION_ROWS = Object.entries(RETENTION_TABLE) as [RetentionRow, string][];
