import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV, transcriptDir } from './claim.js';
import { CLAUDE_CODE } from './executors.js';
import type { RunSession } from './runner.js';
import { MAILBOXES, SUPERVISOR_ENV } from './supervisor-contract.js';
import { orphanBoundMs } from './supervisor-plan.js';

/**
 * What both executors share about the continuous claude-code transcript exporter
 * (`scripts/claude-export.cjs`): when a run gets one, the env it is started with, and the figures
 * its protocol is sized by. The exporter is a container of the run's pod (docker: its container
 * group) under the task supervisor, which orders its drain; the docker side is `docker-group.ts`,
 * the kubernetes side `runnerJobSpec` in `k8s-podspec.ts`; the relay it talks to is `loop-export.ts`.
 */

const BYTES_PER_KIB = 1024;
const SPOOL_GIB = 1;
const FLUSH_KIB = 256;

/** Unacknowledged bytes one attempt may hold before it fails with `artifact_spool_full` — a task-volume budget, 1 GiB. */
export const EXPORT_SPOOL_MAX_BYTES = SPOOL_GIB * BYTES_PER_KIB * BYTES_PER_KIB * BYTES_PER_KIB;
/** Flush at this much pending, or this long after the oldest unflushed byte, whichever comes first. */
export const EXPORT_FLUSH_BYTES = FLUSH_KIB * BYTES_PER_KIB;
export const EXPORT_FLUSH_MS = 15_000;

/** The attempt failure cause when the spool cap is hit; also the manifest's terminal cause for it. */
export const SPOOL_FULL_CAUSE = 'artifact_spool_full';

/** The exporter's own producer name in a manifest, and its schema version. */
export const EXPORT_PRODUCER = 'exporter';
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Whether this run streams its transcript out while it runs: a claude-code session whose attempt
 * has a control endpoint to relay through (the control URL and the exporter's own token, which
 * opens the export routes alone). Opencode keeps its close-time read until its own exporter lands.
 */
export function exportsTranscript(job: BoardJob, session: RunSession | null): boolean {
    return (
        job.executorType === CLAUDE_CODE &&
        session !== null &&
        Boolean(job.supervisorEnv?.[SUPERVISOR_ENV.controlUrl]) &&
        Boolean(job.supervisorEnv?.[SUPERVISOR_ENV.exportToken])
    );
}

/**
 * The exporter's env: the literals (paths, the attempt's start, the caps, its mailbox with the
 * supervisor) and the control pair — the one credential-like value, its own per-attempt token, which
 * each executor delivers by reference (an env file in docker, the attempt's Secret in kubernetes),
 * never in argv or a spec. `control` pairs the exporter's own name with the supervisor-side name
 * the value is stored under: the exporter script reads `BELLOWS_CONTROL_*`.
 */
export function exportEnv(
    config: DriverConfig,
    job: BoardJob,
    startedAt: string
): { literals: [string, string][]; control: { name: string; source: string }[] } {
    return {
        literals: [
            ['CLAUDE_TRANSCRIPT_DIR', transcriptDir(job)],
            ['RUN_STARTED_AT', startedAt],
            ['EXPORT_FLUSH_BYTES', String(EXPORT_FLUSH_BYTES)],
            ['EXPORT_FLUSH_MS', String(EXPORT_FLUSH_MS)],
            ['EXPORT_SPOOL_MAX_BYTES', String(EXPORT_SPOOL_MAX_BYTES)],
            ['FACTORY_EXPORT_DIR', MAILBOXES.export.path],
            // A drain whose driver stays unreachable this long ends, its bytes left on the volume.
            ['EXPORT_DRAIN_GIVEUP_MS', String(orphanBoundMs(config))],
        ],
        control: [
            { name: CONTROL_URL_ENV, source: SUPERVISOR_ENV.controlUrl },
            { name: CONTROL_TOKEN_ENV, source: SUPERVISOR_ENV.exportToken },
        ],
    };
}
