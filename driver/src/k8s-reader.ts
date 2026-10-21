import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { FINISHED_PHASES } from './k8s-adopt.js';
import { deleteJob, jobPodsPath } from './k8s-auxspec.js';
import { asPod } from './k8s-pod-shapes.js';
import { jobsPath, readerJobSpec, runnerName } from './k8s-podspec.js';
import { ABSENT, readJobPodVerdict, readJobStatus, readList, timedOutOf } from './k8s-poll.js';
import { boundedBy, HTTP_ERROR_STATUS, POLL_MS, withSignal } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import { pollFor } from './poll.js';
import type { StepResult } from './supervisor-contract.js';

/** A step's answer, and whether the log it was read from lost its head to the transport. */
export type ReaderResult = StepResult & { truncated?: boolean };

/** Hex characters of the reader Job's random name suffix. */
const NAME_HEX = 16;

/**
 * A close-time readout of a group that has ended, as a one-shot reader Job over its task volume. An
 * adopted finished group has no supervisor left to answer a `probe` step, so the readout never goes
 * through the step channel. The reader waits for the group's pods to be terminal (Succeeded or Failed,
 * or gone: a supervisor that stopped may leave a pod Running or Terminating), which a ReadWriteOncePod
 * claim does not count (the scheduler drops Succeeded and Failed pods from its volume accounting), so
 * the reader is the volume's only holder. It runs the same script, argv and env a supervised readout does, read-write
 * over the volume for the same reason (a WAL that needs recovery).
 *
 * Answers the step's shape plus `truncated` (the transport kept only the log's end): a deadline overrun,
 * the Job's own included, is `timedOut`; a refused Job, a vanished one or an
 * unreadable answer THROWS, and the caller's null contract turns it into "unmeasured". Bounded by
 * `timeoutMs` whole (scheduling included) and by the Job's own `activeDeadlineSeconds`.
 */
export async function readViaReaderJob(
    deps: K8sDeps,
    job: BoardJob,
    readout: { name: string; argv: string[]; env: Record<string, string>; timeoutMs: number }
): Promise<ReaderResult> {
    const name = `factory-read-${randomUUID().replaceAll('-', '').slice(0, NAME_HEX)}`;
    const spec = readerJobSpec(deps.config, job, name, readout);
    const what = `the ${readout.name} readout`;
    const deadline = Date.now() + readout.timeoutMs;
    const live = withSignal(boundedBy(deps, deadline), deps.signal);
    const timedOut: ReaderResult = { exitCode: null, stdout: '', stderr: '', timedOut: true };
    const poll = {
        ms: readout.timeoutMs,
        everyMs: POLL_MS,
        sleep: deps.sleep,
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
    // Before the Job exists, so a group pod still holding the volume leaves nothing to delete.
    const groupPodsPath = jobPodsPath(deps.config.k8sNamespace, runnerName(job));
    const groupOver = await pollFor(poll, async () => {
        const pods = await readList(live, groupPodsPath, `listing ${what}'s group pods`, { entry: asPod, once: true });
        const over = pods === ABSENT || pods.every((pod) => FINISHED_PHASES.includes(pod.status?.phase ?? ''));
        return over ? true : undefined;
    });
    if (groupOver === undefined) return timedOut;
    try {
        const created = await live.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        if (created.status >= HTTP_ERROR_STATUS) throw new Error(`creating ${what} answered ${created.status}`);
        const ended = await pollFor(poll, async () => {
            const status = await readJobStatus(live, name, `reading ${what}`);
            if (status.kind === 'notFound') throw new Error(`${what} no longer exists`);
            if (status.kind === 'error') throw new Error(`reading ${what} answered ${status.status}`);
            return status.kind === 'terminal' ? status : undefined;
        });
        if (ended === undefined || timedOutOf(ended.status)) return timedOut;
        const verdict = await readJobPodVerdict(
            live,
            name,
            { succeeded: ended.outcome === 'succeeded', tail: null, strict: true },
            `reading ${what}'s pod`
        );
        // One interleaved log: a failed readout's text is its error, so it rides stderr, where `detailOf` reads it.
        const failed = verdict.exitCode !== 0;
        return {
            exitCode: verdict.exitCode,
            stdout: failed ? '' : verdict.output,
            stderr: failed ? verdict.output : '',
            timedOut: false,
            truncated: verdict.truncated,
        };
    } finally {
        void deleteJob(deps, name);
    }
}
