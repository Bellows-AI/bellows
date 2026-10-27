import { randomUUID } from 'node:crypto';
import { VOLUME_EXPORT_RUN_LABEL } from '../labels.js';
import { generationOfName } from '../task-volume.js';
import type { OpenVolumeExport, VolumeExportChannel } from '../loop/loop-export.js';
import {
    exportWorkloadStale,
    newestVolume,
    VOLUME_EXPORT_CLEANUP_MS,
    type VolumeExport,
    type VolumeExportAttempt,
    type VolumeExportClock,
    volumeExportClock,
    volumeExportEnv,
    volumeExportName,
} from '../reaper-export.js';
import type { ReaperArm } from '../reaper.js';
import { SUPERVISOR_DRAIN_MS } from '../supervisor-contract.js';
import { jobPodsPath, secretsPath } from './k8s-auxspec.js';
import {
    type JobOwner,
    jobsPath,
    volumeExportJobSpec,
    volumeExportSecretBody,
    volumeExportSecretName,
} from './k8s-podspec.js';
import { deleteSecretAcked } from './k8s-teardown.js';
import { taskVolumesPath } from './k8s-task-volume.js';
import {
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    type K8sDeps,
    type K8sResponse,
    MS_PER_SECOND,
} from './k8s-transport.js';

/**
 * The kubernetes arm of the reaper's export-before-delete (issue #938): the one-shot exporter Job
 * (`volumeExportJobSpec`) over the thread's newest task volume claim. One absolute deadline covers the claim
 * read, the create, every poll and the delete; the Job's `activeDeadlineSeconds` ends it on its own below
 * that. Only the relay's proof says `drained`, never the Job's status.
 */

/** What the arm needs to export: the relay opener and a test's compressed budget. */
export interface KubernetesVolumeExporting {
    open: OpenVolumeExport;
    /** The whole export's budget; `SUPERVISOR_DRAIN_MS` unless a test compresses it. */
    drainMs?: number;
}

const POLL_MS = 2_000;

const inconclusive = (why: string): VolumeExport => ({ result: 'inconclusive', why });

/** `job` for a Job the arm must remove (by uid when known, else by this export's label), `none` when nothing of ours exists. */
type Created = { kind: 'job'; uid: string | undefined } | { kind: 'none' };

interface Run {
    deps: K8sDeps;
    clock: VolumeExportClock;
    drainMs: number;
    signal: AbortSignal;
    channel: VolumeExportChannel;
    name: string;
    /** This export's own id: on its Job and Secret, the proof that a Job under the name is ours. */
    id: string;
    /** Whether the Secret create was sent, so its delete is owed exactly once. */
    secretSent: boolean;
    /** The created Job's uid; set once the create answered. */
    uid: string | undefined;
    /** What the create left to remove; set before anything waits on it. */
    created: Created;
}

const jobPath = (run: Pick<Run, 'deps' | 'name'>): string => `${jobsPath(run.deps.config.k8sNamespace)}/${run.name}`;
const left = (run: Pick<Run, 'clock'>): number => Math.max(1, run.clock.workEnd - Date.now());
/**
 * The bound of one cleanup call: `VOLUME_EXPORT_CLEANUP_MS`, never past the export's own deadline, with no run
 * signal — a stopped reaper or a spent work budget must not cancel the removal it owes.
 */
const cleanupMs = (run: Pick<Run, 'clock'>): number =>
    Math.max(1, Math.min(VOLUME_EXPORT_CLEANUP_MS, run.clock.deadline - Date.now()));

const record = (body: string): Record<string, unknown> | null => {
    try {
        const value: unknown = JSON.parse(body);
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);

/** A Job answer: `ended` once it succeeded or failed, or why it is no answer to act on. */
function jobFacts(body: string, uid: string | undefined): { ended: 'succeeded' | 'failed' | null } | string {
    const job = record(body);
    const status = objectOf(job?.status);
    if (!status) return 'the export job answered no status';
    if (uid !== undefined && objectOf(job?.metadata)?.uid !== uid) {
        return 'the export job under the name is not the one created';
    }
    if (count(status.succeeded) > 0) return { ended: 'succeeded' };
    return { ended: count(status.failed) > 0 ? 'failed' : null };
}

/** Whether the Job's pods ever ran a container: none, or all still Pending and waiting, is never started. */
async function podsStarted(run: Run): Promise<boolean | string> {
    let response: K8sResponse;
    try {
        response = await run.deps.request('GET', jobPodsPath(run.deps.config.k8sNamespace, run.name), undefined, {
            signal: run.signal,
            timeoutMs: left(run),
        });
    } catch (e) {
        return `the export pod could not be listed: ${(e as Error).message}`;
    }
    if (response.status >= HTTP_ERROR_STATUS) return `listing the export pod answered ${response.status}`;
    const items = record(response.body)?.items;
    if (!Array.isArray(items)) return 'the export pod list answered no items';
    return items.some((item: unknown) => {
        const status = objectOf(objectOf(item)?.status);
        const statuses = status?.containerStatuses;
        return (
            (status !== null && status.phase !== 'Pending') ||
            (Array.isArray(statuses) &&
                statuses.some((entry: unknown) => {
                    const state = objectOf(objectOf(entry)?.state);
                    return Boolean(state?.running || state?.terminated);
                }))
        );
    });
}

/** What a Job still alive at the work's end says: one whose pod never started never ran. */
async function outOfTime(run: Run): Promise<VolumeExport> {
    const started = await podsStarted(run);
    if (typeof started === 'string') return inconclusive(started);
    return started
        ? inconclusive('the export job did not end before the deadline')
        : { result: 'never_started', why: 'the export pod was not running by the deadline' };
}

/** What a Job that ended proved: the relay's proof, never the Job's status. */
function endedJob(run: Run, ended: string): VolumeExport {
    const proof = run.channel.proof();
    return proof.drained ? { result: 'drained' } : inconclusive(`${proof.why} (job ${ended})`);
}

/** One Job read: whether it ended, or why it could not be read. */
async function readJob(run: Run): Promise<{ ended: 'succeeded' | 'failed' | null } | string> {
    let response: K8sResponse;
    try {
        response = await run.deps.request('GET', jobPath(run), undefined, { signal: run.signal, timeoutMs: left(run) });
    } catch (e) {
        return `the export job could not be read: ${(e as Error).message}`;
    }
    if (response.status >= HTTP_ERROR_STATUS) return `reading the export job answered ${response.status}`;
    return jobFacts(response.body, run.uid);
}

/** Polls the Job to its end or the work's end. */
async function awaitJob(run: Run): Promise<VolumeExport> {
    for (;;) {
        if (run.signal.aborted) return inconclusive('the reaper stopped mid-export');
        const seen = await readJob(run);
        if (typeof seen === 'string') return inconclusive(seen);
        if (seen.ended) return endedJob(run, seen.ended);
        if (Date.now() >= run.clock.workEnd) return outOfTime(run);
        await run.deps.sleep(Math.min(POLL_MS, left(run)));
    }
}

const contended = (why: string): VolumeExport => ({ result: 'contended', why });
/** A held workload that cannot be read or removed: counts as a failed attempt, so the thread's attempts stay bounded. */
const failedAttempt = (why: string): VolumeExport => inconclusive(why);

interface Held {
    uid: string | undefined;
    createdMs: number;
    ours: boolean;
    /** The run id the held Job is labelled with, which names its Secret. */
    run: string | undefined;
}

/**
 * The Job under the name, read: its uid, creation time and run label; or why it could not be read (absent = `null`).
 * `cleanup` reads under its own bound and no signal, for the removal owed after the work's budget is spent.
 */
async function readHeld(run: Run, cleanup = false): Promise<Held | null | string> {
    let response: K8sResponse;
    try {
        response = await run.deps.request(
            'GET',
            jobPath(run),
            undefined,
            cleanup ? { timeoutMs: cleanupMs(run) } : { signal: run.signal, timeoutMs: left(run) }
        );
    } catch (e) {
        return `the export job under the name could not be read: ${(e as Error).message}`;
    }
    if (response.status === HTTP_NOT_FOUND) return null;
    if (response.status >= HTTP_ERROR_STATUS)
        return `reading the export job under the name answered ${response.status}`;
    const metadata = objectOf(record(response.body)?.metadata);
    const labels = objectOf(metadata?.labels);
    const uid = metadata?.uid;
    const heldRun = labels?.[VOLUME_EXPORT_RUN_LABEL];
    return {
        uid: typeof uid === 'string' ? uid : undefined,
        createdMs: Date.parse(String(metadata?.creationTimestamp)),
        ours: heldRun === run.id,
        run: typeof heldRun === 'string' && /^[a-z0-9-]+$/.test(heldRun) ? heldRun : undefined,
    };
}

/**
 * Another export's Job holds the name. It is read first and removed only when provably stale (past the whole
 * budget an export has, and by the uid just read); one within its deadline is a live export of another replica.
 */
async function nameHeld(run: Run): Promise<VolumeExport> {
    const held = await readHeld(run);
    if (typeof held === 'string') return failedAttempt(held);
    if (held === null) return contended('the export job under the name just ended');
    if (!Number.isFinite(held.createdMs))
        return failedAttempt('the export job under the name has no readable creation time');
    if (!exportWorkloadStale(held.createdMs, run.drainMs, Date.now())) {
        return contended('another export holds the name and is within its deadline');
    }
    if (held.uid === undefined) return failedAttempt('the stale export job under the name carries no uid');
    // Its Secret first, by the run label the Job carries: the Job's TTL would otherwise leave the Secret for good.
    if (held.run !== undefined) {
        await deleteSecretAcked(run.deps, volumeExportSecretName(held.run), undefined, cleanupMs(run));
    }
    if (!(await deleteByUid(run, held.uid)))
        return failedAttempt('the stale export job under the name could not be removed');
    return contended('removed a stale export job; the next round exports');
}

/** Creates the Secret carrying the token; the result, when it ended the export. */
async function createSecret(run: Run, target: { root: string }, owner: JobOwner): Promise<VolumeExport | null> {
    run.secretSent = true;
    let response: K8sResponse;
    try {
        response = await run.deps.request(
            'POST',
            secretsPath(run.deps.config.k8sNamespace),
            volumeExportSecretBody({ root: target.root, run: run.id }, run.channel.token, owner),
            { signal: run.signal, timeoutMs: left(run) }
        );
    } catch (e) {
        return inconclusive(`creating the export secret failed: ${(e as Error).message}`);
    }
    return response.status >= HTTP_ERROR_STATUS
        ? { result: 'never_started', why: `creating the export secret answered ${response.status}` }
        : null;
}

/** Creates the Job. The `Created` says whether anything of ours exists to remove; the result, when it ended the export. */
async function createJob(run: Run, job: object): Promise<{ created: Created; ended?: VolumeExport }> {
    let response: K8sResponse;
    try {
        response = await run.deps.request('POST', jobsPath(run.deps.config.k8sNamespace), job, {
            signal: run.signal,
            timeoutMs: left(run),
        });
    } catch (e) {
        // A timed-out create may have made the Job: it is removed if it carries this export's label.
        return {
            created: { kind: 'job', uid: undefined },
            ended: inconclusive(`creating the export job failed: ${(e as Error).message}`),
        };
    }
    if (response.status === HTTP_CONFLICT) return { created: { kind: 'none' }, ended: await nameHeld(run) };
    if (response.status >= HTTP_ERROR_STATUS) {
        return {
            created: { kind: 'none' },
            ended: { result: 'never_started', why: `creating the export job answered ${response.status}` },
        };
    }
    const uid = objectOf(record(response.body)?.metadata)?.uid;
    return { created: { kind: 'job', uid: typeof uid === 'string' ? uid : undefined } };
}

/** Deletes one Job incarnation (Foreground, so its pod goes with it) under a uid precondition. */
async function deleteByUid(run: Run, uid: string): Promise<boolean> {
    try {
        const response = await run.deps.request(
            'DELETE',
            `${jobPath(run)}?propagationPolicy=Foreground`,
            { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } },
            { timeoutMs: cleanupMs(run) }
        );
        return response.status < HTTP_ERROR_STATUS || response.status === HTTP_NOT_FOUND;
    } catch {
        // The Job's activeDeadlineSeconds and ttl end it; the next round's name check clears what is left.
        return false;
    }
}

/**
 * Removes the Job this export created, once: by the uid its create answered, or — for a create that ended
 * unanswered — by the uid of the Job under the name, only if that Job carries this export's label.
 */
async function deleteJob(run: Run, created: Created): Promise<void> {
    if (created.kind === 'none') return;
    if (created.uid !== undefined) {
        await deleteByUid(run, created.uid);
        return;
    }
    const held = await readHeld(run, true);
    if (typeof held === 'object' && held !== null && held.ours && held.uid !== undefined) {
        await deleteByUid(run, held.uid);
    }
}

/** Deletes the export's Secret once, if its create was sent; a refusal leaves a token the closed channel already revoked. */
async function deleteSecret(run: Run): Promise<void> {
    if (run.secretSent) await deleteSecretAcked(run.deps, volumeExportSecretName(run.id), undefined, cleanupMs(run));
}

/** Whether the claim exists: `false` on a 404, an Error for any other answer. */
async function claimPresent(run: Pick<Run, 'deps' | 'clock' | 'signal'>, claim: string): Promise<boolean | Error> {
    try {
        const response = await run.deps.request(
            'GET',
            `${taskVolumesPath(run.deps.config.k8sNamespace)}/${claim}`,
            undefined,
            { signal: run.signal, timeoutMs: left(run) }
        );
        if (response.status === HTTP_NOT_FOUND) return false;
        return response.status >= HTTP_ERROR_STATUS ? new Error(`the claim read answered ${response.status}`) : true;
    } catch (e) {
        return e as Error;
    }
}

/** The channel for the exporter, or the result that ends the export when there is none. */
async function openChannel(
    exporting: KubernetesVolumeExporting,
    attempt: VolumeExportAttempt
): Promise<VolumeExportChannel | VolumeExport> {
    try {
        return (
            (await exporting.open(attempt)) ?? {
                result: 'never_started',
                why: 'the driver has no control endpoint for the exporter',
            }
        );
    } catch (e) {
        return { result: 'never_started', why: `the control endpoint did not open: ${(e as Error).message}` };
    }
}

/**
 * Creates the Job, then the Secret owned by it, and waits it out; the caller removes both. The Job's pod waits on
 * its `secretKeyRef` until the Secret exists (the kubelet retries a missing one, it does not fail the pod).
 */
async function exportOnJob(run: Run, target: { root: string; generation: number }): Promise<VolumeExport> {
    const env = volumeExportEnv(target.root, run.channel, run.clock.giveUpMs);
    const deadline = Math.max(1, Math.ceil((run.clock.workEnd - Date.now()) / MS_PER_SECOND));
    const spec = volumeExportJobSpec(run.deps.config, { ...target, name: run.name, run: run.id }, env, deadline);
    const made = await createJob(run, spec);
    run.created = made.created;
    if (made.ended) return made.ended;
    run.uid = made.created.kind === 'job' ? made.created.uid : undefined;
    if (run.uid === undefined) return inconclusive('the export job answered no uid for its secret to be owned by');
    const refused = await createSecret(run, target, { name: run.name, uid: run.uid });
    return refused ?? awaitJob(run);
}

export function createKubernetesVolumeExporter(
    deps: K8sDeps,
    exporting: KubernetesVolumeExporting
): NonNullable<ReaperArm['exportVolume']> {
    return async (thread, attempt, signal) => {
        const volume = newestVolume(thread);
        if (!volume) return inconclusive('no volume of the thread reads as a generation');
        const drainMs = exporting.drainMs ?? SUPERVISOR_DRAIN_MS;
        const clock = volumeExportClock(drainMs, Date.now());
        const present = await claimPresent({ deps, clock, signal }, volume.name);
        if (present instanceof Error) return inconclusive(`the volume claim could not be read: ${present.message}`);
        if (!present) return { result: 'gone' };
        const opened = await openChannel(exporting, attempt);
        if (!('proof' in opened)) return opened;
        const name = volumeExportName(thread.root);
        const run: Run = {
            deps,
            clock,
            drainMs,
            signal,
            channel: opened,
            name,
            id: randomUUID(),
            secretSent: false,
            uid: undefined,
            created: { kind: 'none' },
        };
        try {
            const generation = generationOfName(thread.root, volume.name) ?? 1;
            return await exportOnJob(run, { root: thread.root, generation });
        } finally {
            opened.close();
            await deleteJob(run, run.created);
            await deleteSecret(run);
        }
    };
}
