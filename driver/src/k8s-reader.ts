import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { deleteJob } from './k8s-auxspec.js';
import { jobsPath, readerJobSpec } from './k8s-podspec.js';
import { readJobPodVerdict, readJobStatus } from './k8s-poll.js';
import { boundedBy, HTTP_ERROR_STATUS, POLL_MS, withSignal } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import { pollFor } from './poll.js';
import type { StepResult } from './supervisor-contract.js';

/** Hex characters of the reader Job's random name suffix. */
const NAME_HEX = 16;

/**
 * A close-time readout of a group that has ended, as a one-shot reader Job over its task volume. An
 * adopted finished group has no supervisor left to answer a `probe` step, so the readout never goes
 * through the step channel: the group's pod is terminal, which a ReadWriteOncePod claim does not
 * count (the scheduler drops Succeeded and Failed pods from its volume accounting), so the reader is
 * the volume's only holder. It runs the same script, argv and env a supervised readout does, read-write
 * over the volume for the same reason (a WAL that needs recovery).
 *
 * Answers the step's shape: a deadline overrun is `timedOut`; a refused Job, a vanished one or an
 * unreadable answer THROWS, and the caller's null contract turns it into "unmeasured". Bounded by
 * `timeoutMs` whole (scheduling included) and by the Job's own `activeDeadlineSeconds`.
 */
export async function readViaReaderJob(
    deps: K8sDeps,
    job: BoardJob,
    readout: { name: string; argv: string[]; env: Record<string, string>; timeoutMs: number }
): Promise<StepResult> {
    const name = `factory-read-${randomUUID().replaceAll('-', '').slice(0, NAME_HEX)}`;
    const spec = readerJobSpec(deps.config, job, name, readout);
    const what = `the ${readout.name} readout`;
    const deadline = Date.now() + readout.timeoutMs;
    const live = withSignal(boundedBy(deps, deadline), deps.signal);
    try {
        const created = await live.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        if (created.status >= HTTP_ERROR_STATUS) throw new Error(`creating ${what} answered ${created.status}`);
        const ended = await pollFor(
            {
                ms: readout.timeoutMs,
                everyMs: POLL_MS,
                sleep: deps.sleep,
                ...(deps.signal ? { signal: deps.signal } : {}),
            },
            async () => {
                const status = await readJobStatus(live, name, `reading ${what}`);
                if (status.kind === 'notFound') throw new Error(`${what} no longer exists`);
                if (status.kind === 'error') throw new Error(`reading ${what} answered ${status.status}`);
                return status.kind === 'terminal' ? status.outcome : undefined;
            }
        );
        if (ended === undefined) return { exitCode: null, stdout: '', stderr: '', timedOut: true };
        const verdict = await readJobPodVerdict(
            live,
            name,
            { succeeded: ended === 'succeeded', tail: null, strict: true },
            `reading ${what}'s pod`
        );
        return { exitCode: verdict.exitCode, stdout: verdict.output, stderr: '', timedOut: false };
    } finally {
        void deleteJob(deps, name);
    }
}
