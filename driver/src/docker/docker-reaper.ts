import { type BoardJob, UUID_SHAPE } from '../board/board.js';
import { containerName } from './docker.js';
import { createDockerVolumeExporter, type DockerVolumeExporting } from './docker-volume-export.js';
import { BOARD_LABEL, JOB_LABEL, LEASE_LABEL, ROLE_LABEL, SERVICE_LABEL } from '../labels.js';
import { CONTAINER_ID, DOCKER_NAME, type ExecDocker, noSuchObject, readDocker } from './docker-runner-support.js';
import { Inconclusive } from '../runner.js';
import type { OrphanGroup, OrphanObject, ReapInconclusive, ReaperArm, VolumeListing, VolumeThread } from '../reaper.js';
import { TASK_BOARD_LABEL, TASK_ROOT_LABEL, generationOfName } from '../task-volume.js';
import { parseDockerTimestamp, parseRfc3339 } from '../timestamps.js';

/**
 * The docker half of the orphan reaper (issue #301): label-filtered `docker ps` and `volume ls`,
 * and container and volume removal — the twin of `dockerServiceTeardown` and the docker fence
 * acting on what an attempt can never tear down itself. No network is an attempt's: its group
 * shares its supervisor's namespace (issue #773). Scope: the SERVICE and GATE labels (issue #667) and an attempt's task group (issue
 * #821) — every container carrying the ROLE label (agent, supervisor, exporter) and every volume
 * carrying the job and lease labels (its mailboxes and kill markers). An exited runner container
 * is unread: the next claim adopts it. A scan any one list or inspect of which the daemon refused
 * answers nothing.
 */

/**
 * Docker's `CreatedAt` spelling — `2026-09-14 10:00:00 +0000 UTC` — into epoch millis. Not a
 * RFC3339 string, so `Date.parse` alone would be gambling on the engine. Unparsable answers null,
 * never the epoch: a date that cannot be read must not put a group out of its grace window and
 * license a reap (#869) — the scan that met it is inconclusive.
 */
export const parseDockerCreatedAt = parseDockerTimestamp;

/** One listed row the reaper can use — a container or a volume — or null for junk. */
interface PsRow {
    object: OrphanObject;
    name: string;
    jobId: string;
    leaseToken: string;
    createdAtMs: number;
}

/** The value of one k=v label in docker's comma-spelled `Labels` field. */
const labelOf = (labels: string, name: string): string | undefined => {
    const prefix = `${name}=`;
    const pair = labels.split(',').find((candidate) => candidate.startsWith(prefix));
    return pair?.slice(prefix.length);
};

/** One row's JSON fields, or null for a line that is not a JSON record. */
const fieldsOf = (
    line: string
): { ID?: unknown; Name?: unknown; Names?: unknown; Labels?: unknown; CreatedAt?: unknown; State?: unknown } | null => {
    try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

/**
 * The job and lease pair a row's labels carry; `'out-of-scope'` for a row the reaper leaves alone;
 * null for a row whose job or lease label is present but no uuid (#869) — it would become the attempt
 * identity the grouping files the row under, so the whole listing is inconclusive.
 */
const pairOf = (
    labels: string,
    scopeLabel: string,
    board: string
): { jobId: string; leaseToken: string } | 'out-of-scope' | null => {
    // The scope and board labels are checked here as well as in the argv filter, because the argv is the
    // daemon's instruction and this is the row's proof. Another board's group on a shared daemon, or a
    // group no board made, is never this reaper's to remove.
    if (!labelOf(labels, scopeLabel) || labelOf(labels, BOARD_LABEL) !== board) return 'out-of-scope';
    const jobId = labelOf(labels, JOB_LABEL);
    const leaseToken = labelOf(labels, LEASE_LABEL);
    if ([jobId, leaseToken].some((label) => label !== undefined && !UUID_SHAPE.test(label))) return null;
    return jobId === undefined || leaseToken === undefined ? 'out-of-scope' : { jobId, leaseToken };
};

/**
 * One `ps` row: null for a row that is structurally invalid — not a JSON record, no container id,
 * a name or labels that are no strings, or an in-scope row whose creation time cannot be read —
 * which makes the whole listing inconclusive; `'out-of-scope'` for a well-formed row whose labels
 * put it outside the reaper's scope.
 */
const parsePsRow = (line: string, scopeLabel: string, board: string): PsRow | 'out-of-scope' | null => {
    const fields = fieldsOf(line);
    if (!fields || typeof fields.ID !== 'string' || !CONTAINER_ID.test(fields.ID)) return null;
    // A name that is no name is none the removal argv could address.
    if (typeof fields.Names !== 'string' || !DOCKER_NAME.test(fields.Names) || typeof fields.Labels !== 'string') {
        return null;
    }
    if (scopeLabel === ROLE_LABEL && typeof fields.State !== 'string') return null;
    const pair = pairOf(fields.Labels, scopeLabel, board);
    if (pair === null || pair === 'out-of-scope') return pair;
    const createdAtMs = typeof fields.CreatedAt === 'string' ? parseDockerCreatedAt(fields.CreatedAt) : null;
    if (createdAtMs === null) return null;
    const name = fields.Names;
    // The objects are named by ID, not by container name: the id is what the removal argv uses,
    // and a name could address whatever owns it at removal time. An exited runner is the next
    // claim's to adopt (issue #792): never reaped unread.
    const exitedRunner =
        scopeLabel === ROLE_LABEL &&
        fields.State === 'exited' &&
        name === containerName({ id: pair.jobId, leaseToken: pair.leaseToken } as BoardJob);
    const object: OrphanObject = {
        kind: 'container',
        name: fields.ID,
        ...(exitedRunner ? { unread: true as const } : {}),
        // A task group's container: a live job's is its next claim's fence's, whatever the scan saw.
        ...(scopeLabel === ROLE_LABEL ? { runner: true as const } : {}),
    };
    return { object, name, ...pair, createdAtMs };
};

/** A listing's in-scope rows, or null when any row is structurally invalid. */
const psRowsOf = (stdout: string, scopeLabel: string, board: string): PsRow[] | null => {
    const rows: PsRow[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const row = parsePsRow(line.trim(), scopeLabel, board);
        if (row === null) return null;
        if (row !== 'out-of-scope') rows.push(row);
    }
    return rows;
};

type Groups = Map<string, OrphanGroup>;

/** Files one row under its (job, lease) group; the group's age is its oldest object's. */
const addRow = (groups: Groups, row: PsRow): void => {
    const key = `${row.jobId}|${row.leaseToken}`;
    const existing = groups.get(key);
    if (existing) {
        existing.objects.push(row.object);
        if (row.createdAtMs < existing.createdAtMs) existing.createdAtMs = row.createdAtMs;
        return;
    }
    groups.set(key, {
        jobId: row.jobId,
        leaseToken: row.leaseToken,
        createdAtMs: row.createdAtMs,
        objects: [row.object],
    });
};

/**
 * One scope's container rows, grouped by (job, lease). Throws `Inconclusive` when the daemon
 * refused the list or a row of it is unreadable: neither is the daemon answering "nothing is
 * orphaned".
 */
const scanScope = async (execDocker: ExecDocker, scopeLabel: string, board: string, groups: Groups): Promise<void> => {
    const read = await readDocker(
        execDocker,
        [
            'ps',
            '-a',
            '--filter',
            `label=${scopeLabel}`,
            '--filter',
            `label=${BOARD_LABEL}=${board}`,
            '--format',
            '{{json .}}',
        ],
        `listing the ${scopeLabel} containers`,
        { parse: (stdout) => psRowsOf(stdout, scopeLabel, board) }
    );
    if (read.kind !== 'value') throw new Inconclusive(read.kind === 'inconclusive' ? read.reason : 'absent');
    for (const row of read.value) addRow(groups, row);
};

/** A listing's in-scope volumes, or null when any row is structurally invalid. */
const volumeRowsOf = (
    stdout: string,
    board: string
): { name: string; pair: { jobId: string; leaseToken: string } }[] | null => {
    const found: { name: string; pair: { jobId: string; leaseToken: string } }[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const fields = fieldsOf(line.trim());
        if (!fields || typeof fields.Name !== 'string' || !DOCKER_NAME.test(fields.Name)) return null;
        if (typeof fields.Labels !== 'string') return null;
        const pair = pairOf(fields.Labels, LEASE_LABEL, board);
        if (pair === null) return null;
        if (pair !== 'out-of-scope') found.push({ name: fields.Name, pair });
    }
    return found;
};

/**
 * The attempts' volumes — the mailboxes and the kill markers, both labelled with the job and the
 * lease — each dated by its own `volume inspect`, since `volume ls` carries no creation time. A
 * volume gone before its inspect is skipped; throws `Inconclusive` when any other call was refused
 * or answered what is not a row or a date.
 */
const scanVolumes = async (execDocker: ExecDocker, board: string, groups: Groups): Promise<void> => {
    const listed = await readDocker(
        execDocker,
        [
            'volume',
            'ls',
            '--filter',
            `label=${JOB_LABEL}`,
            '--filter',
            `label=${LEASE_LABEL}`,
            '--filter',
            `label=${BOARD_LABEL}=${board}`,
            '--format',
            '{{json .}}',
        ],
        'listing the attempt volumes',
        { parse: (stdout) => volumeRowsOf(stdout, board) }
    );
    if (listed.kind !== 'value') throw new Inconclusive(listed.kind === 'inconclusive' ? listed.reason : 'absent');
    for (const { name, pair } of listed.value) {
        const createdAtMs = await volumeCreatedAt(execDocker, name);
        if (createdAtMs !== null) addRow(groups, { object: { kind: 'volume', name }, name, ...pair, createdAtMs });
    }
};

/** One volume's creation time, or null when it was removed since the list; `Inconclusive` for any other answer. */
const volumeCreatedAt = async (execDocker: ExecDocker, name: string): Promise<number | null> => {
    const read = await readDocker(
        execDocker,
        ['volume', 'inspect', '--format', '{{.CreatedAt}}', name],
        `inspecting the volume ${name}`,
        {
            parse: parseRfc3339,
            absentOn: ['volume'],
        }
    );
    if (read.kind === 'inconclusive') throw new Inconclusive(read.reason);
    return read.kind === 'absent' ? null : read.value;
};

const scan = async (execDocker: ExecDocker, board: string): Promise<OrphanGroup[] | null> => {
    const groups: Groups = new Map();
    try {
        await scanScope(execDocker, SERVICE_LABEL, board, groups);
        await scanScope(execDocker, ROLE_LABEL, board, groups);
        await scanVolumes(execDocker, board, groups);
    } catch {
        // Any one list refused: the round reaps nothing rather than a group missing its pieces, and
        // says so (null), so an empty scan is never read as "nothing is orphaned".
        return null;
    }
    return [...groups.values()];
};

/** Removes a daemon object, reading its already-gone answer as success — the fence's tolerance. */
const removeTolerantly = async (execDocker: ExecDocker, args: string[], kind: string): Promise<boolean> => {
    try {
        await execDocker(args);
        return true;
    } catch (e) {
        if (noSuchObject(e, [kind])) return false;
        throw e;
    }
};

const reap = async (execDocker: ExecDocker, group: OrphanGroup): Promise<readonly string[]> => {
    const removed: string[] = [];
    // The containers before the volumes they mount: docker refuses to remove a volume in use.
    for (const object of group.objects.filter((candidate) => candidate.kind === 'container')) {
        if (await removeTolerantly(execDocker, ['rm', '-f', object.name], 'container')) {
            removed.push(`container ${object.name}`);
        }
    }
    for (const object of group.objects.filter((candidate) => candidate.kind === 'volume')) {
        if (await removeTolerantly(execDocker, ['volume', 'rm', '-f', object.name], 'volume')) {
            removed.push(`volume ${object.name}`);
        }
    }
    return removed;
};

/**
 * One `volume ls` row of the task volume listing: the root its label names and the volume's name; null
 * for a line that is not a volume record at all, a string for a labelled volume that is no thread's
 * (skipped and logged, never a reason to delete nothing fleet-wide).
 */
const taskVolumeRow = (line: string, board: string): { root: string; name: string } | string | null | 'foreign' => {
    const fields = fieldsOf(line);
    if (!fields || typeof fields.Name !== 'string' || !DOCKER_NAME.test(fields.Name)) return null;
    // Another board's volume (or none's) on a shared daemon: never ours to delete, however absent its root is here.
    if (typeof fields.Labels !== 'string' || labelOf(fields.Labels, TASK_BOARD_LABEL) !== board) return 'foreign';
    const root = typeof fields.Labels === 'string' ? labelOf(fields.Labels, TASK_ROOT_LABEL) : undefined;
    if (root === undefined || !UUID_SHAPE.test(root) || generationOfName(root, fields.Name) === null) {
        return `task volume ${fields.Name}: its root label (${root ?? 'none'}) names no thread it is a generation of`;
    }
    return { root: root.toLowerCase(), name: fields.Name };
};

/** The task volume listing, or null when any line of it is not a volume record. */
const taskVolumeRows = (stdout: string, board: string): VolumeListing | null => {
    const threads = new Map<string, VolumeThread>();
    const skipped: string[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const row = taskVolumeRow(line.trim(), board);
        if (row === null) return null;
        if (row === 'foreign') continue;
        if (typeof row === 'string') {
            skipped.push(row);
            continue;
        }
        const thread = threads.get(row.root) ?? { root: row.root, volumes: [] };
        thread.volumes.push({ name: row.name });
        threads.set(row.root, thread);
    }
    return { threads: [...threads.values()], skipped };
};

/**
 * Every task volume (issue #775), all generations, by its root label, grouped by thread, each with its
 * creation time (null when the daemon would not say). Null when the daemon refused the list or a line of
 * it is not a volume record.
 */
const scanTaskVolumes = async (execDocker: ExecDocker, board: string): Promise<VolumeListing | null> => {
    const read = await readDocker(
        execDocker,
        ['volume', 'ls', '--filter', `label=${TASK_ROOT_LABEL}`, '--format', '{{json .}}'],
        'listing the task volumes',
        { parse: (stdout) => taskVolumeRows(stdout, board) }
    );
    if (read.kind !== 'value') return null;
    const inconclusive: string[] = [];
    for (const thread of read.value.threads) {
        for (const volume of thread.volumes) {
            // Gone since the list is a null time (nothing to keep); a refused or unreadable inspect is not.
            volume.createdAtMs = await volumeCreatedAt(execDocker, volume.name).catch((e: unknown) => {
                inconclusive.push(`inspecting volume ${volume.name} proved nothing: ${(e as Error).message}`);
                return null;
            });
        }
    }
    return inconclusive.length === 0 ? read.value : { ...read.value, inconclusive };
};

/** Removes every generation, without force: a volume a container still mounts is refused, and the next round's. */
const reapTaskVolumes = async (
    execDocker: ExecDocker,
    thread: VolumeThread
): Promise<readonly string[] | ReapInconclusive> => {
    const removed: string[] = [];
    let unconfirmed: string | null = null;
    for (const volume of thread.volumes) {
        try {
            await execDocker(['volume', 'rm', volume.name]);
            removed.push(`volume ${volume.name}`);
        } catch (e) {
            // Already gone is success; in use, or a daemon that failed, is the next round's — and not ok.
            if (!noSuchObject(e, ['volume']))
                unconfirmed ??= `removing volume ${volume.name} failed: ${(e as Error).message}`;
        }
    }
    return unconfirmed === null ? removed : { removed, inconclusive: unconfirmed };
};

/** The docker arm of the orphan reaper: every group piece of `board` (`boardIdentity`) it finds by label, reaped on the lease lookup. */
export function createDockerReaper(
    execDocker: ExecDocker,
    board: string,
    exporting?: DockerVolumeExporting
): ReaperArm {
    return {
        ...(exporting ? { exportVolume: createDockerVolumeExporter(execDocker, board, exporting) } : {}),
        scan: () => scan(execDocker, board),
        reap: (group) => reap(execDocker, group),
        scanVolumes: () => scanTaskVolumes(execDocker, board),
        reapVolumes: (thread) => reapTaskVolumes(execDocker, thread),
    };
}
