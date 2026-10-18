import type { BoardJob } from './board.js';
import { containerName } from './docker.js';
import { GATE_LABEL, JOB_LABEL, LEASE_LABEL, RECLAIM_LABEL, ROLE_LABEL, SERVICE_LABEL } from './labels.js';
import { networkName } from './services.js';
import { alreadyGone, linesOf, type ExecDocker } from './docker-runner-support.js';
import type { OrphanGroup, OrphanObject, ReaperArm } from './reaper.js';

/**
 * The docker half of the orphan reaper (issue #301): label-filtered `docker ps` and `volume ls`,
 * container and volume removal, and the per-attempt services network's teardown — the twin of
 * `dockerServiceTeardown` and the docker fence acting on what an attempt can never tear down
 * itself. Scope: the SERVICE and GATE labels (issue #667) and an attempt's task group (issue
 * #821) — every container carrying the ROLE label (agent, supervisor, exporter) and every volume
 * carrying the job and lease labels (its mailboxes and kill markers). An exited runner container
 * is unread: the next claim adopts it. A terminal reclaim's group (`RECLAIM_LABEL`) is never in
 * scope, and a scan any one list or inspect of which the daemon refused answers nothing.
 */

/**
 * Docker's `CreatedAt` spelling — `2026-09-14 10:00:00 +0000 UTC` — into epoch millis. Not a
 * RFC3339 string, so `Date.parse` alone would be gambling on the engine. Unparsable answers 0:
 * the board state has already decided the reap, and age only ever defers it — a format drift
 * would skip a grace window, nothing worse.
 */
export function parseDockerCreatedAt(raw: string): number {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2}) (?:[A-Z]+)$/.exec(raw.trim());
    if (!match) return 0;
    const [date, time, sign, oh, om] = match.slice(1) as [string, string, string, string, string];
    const offsetMinutes = Number(oh) * 60 + Number(om);
    const iso = `${date}T${time}${sign}${String(Math.floor(offsetMinutes / 60)).padStart(2, '0')}:${om}`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? 0 : parsed;
}

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

/** One row's JSON fields, or null for a line that does not parse. */
const fieldsOf = (
    line: string
): { ID?: unknown; Name?: unknown; Names?: unknown; Labels?: unknown; CreatedAt?: unknown; State?: unknown } | null => {
    try {
        return JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
};

/** The job and lease pair a row's labels carry, or null for a row out of the reaper's scope. */
const pairOf = (labels: string, scopeLabel: string): { jobId: string; leaseToken: string } | null => {
    const jobId = labelOf(labels, JOB_LABEL);
    const leaseToken = labelOf(labels, LEASE_LABEL);
    // The scope label is checked here as well as in the argv filter, because the argv is the
    // daemon's instruction and this is the row's proof; a reclaim group is never in scope.
    if (!jobId || !leaseToken || !labelOf(labels, scopeLabel) || labelOf(labels, RECLAIM_LABEL)) return null;
    return { jobId, leaseToken };
};

const parsePsRow = (line: string, scopeLabel: string): PsRow | null => {
    const fields = fieldsOf(line);
    if (!fields || typeof fields.ID !== 'string' || !fields.ID) return null;
    const pair = pairOf(typeof fields.Labels === 'string' ? fields.Labels : '', scopeLabel);
    if (!pair) return null;
    const createdAtMs = typeof fields.CreatedAt === 'string' ? parseDockerCreatedAt(fields.CreatedAt) : 0;
    const name = typeof fields.Names === 'string' ? fields.Names : '';
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
 * One scope's container rows, grouped by (job, lease). `keep` spares a row the reaper must not
 * touch — a gate environment this very driver still holds, whose creation-time labels name an
 * attempt the environment has since passed from. Rejects when the daemon refused the list: the
 * daemon answering nothing is not the daemon answering "nothing is orphaned".
 */
const scanScope = async (
    execDocker: ExecDocker,
    scopeLabel: string,
    keep: (row: PsRow) => boolean,
    groups: Groups
): Promise<void> => {
    const { stdout } = await execDocker(['ps', '-a', '--filter', `label=${scopeLabel}`, '--format', '{{json .}}']);
    for (const line of stdout.split('\n')) {
        const row = parsePsRow(line.trim(), scopeLabel);
        if (row && !keep(row)) addRow(groups, row);
    }
};

/**
 * The attempts' volumes — the mailboxes and the kill markers, both labelled with the job and the
 * lease — each dated by its own `volume inspect`, since `volume ls` carries no creation time. A
 * volume gone before its inspect is skipped; rejects when any other call was refused.
 */
const scanVolumes = async (execDocker: ExecDocker, groups: Groups): Promise<void> => {
    const listed = await execDocker([
        'volume',
        'ls',
        '--filter',
        `label=${JOB_LABEL}`,
        '--filter',
        `label=${LEASE_LABEL}`,
        '--format',
        '{{json .}}',
    ]);
    const found: { name: string; pair: { jobId: string; leaseToken: string } }[] = [];
    for (const line of linesOf(listed.stdout)) {
        const fields = fieldsOf(line);
        if (!fields || typeof fields.Name !== 'string' || !fields.Name) continue;
        const pair = pairOf(typeof fields.Labels === 'string' ? fields.Labels : '', LEASE_LABEL);
        if (pair) found.push({ name: fields.Name, pair });
    }
    for (const { name, pair } of found) {
        const createdAtMs = await volumeCreatedAt(execDocker, name);
        if (createdAtMs !== null) addRow(groups, { object: { kind: 'volume', name }, name, ...pair, createdAtMs });
    }
};

/** One volume's creation time, 0 when unparsable, or null when it was removed since the list. */
const volumeCreatedAt = async (execDocker: ExecDocker, name: string): Promise<number | null> => {
    let at: string;
    try {
        at = (await execDocker(['volume', 'inspect', '--format', '{{.CreatedAt}}', name])).stdout.trim();
    } catch (e) {
        // Removed since the list: nothing left to reap. Any other refusal rejects the round.
        if (alreadyGone(e)) return null;
        throw e;
    }
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? 0 : parsed;
};

const scan = async (execDocker: ExecDocker, holdsGate: (containerName: string) => boolean): Promise<OrphanGroup[]> => {
    const groups: Groups = new Map();
    try {
        await scanScope(execDocker, SERVICE_LABEL, () => false, groups);
        await scanScope(execDocker, GATE_LABEL, (row) => holdsGate(row.name), groups);
        await scanScope(execDocker, ROLE_LABEL, () => false, groups);
        await scanVolumes(execDocker, groups);
    } catch {
        // Any one list refused: the round reaps nothing rather than a group missing its pieces.
        return [];
    }
    return [...groups.values()];
};

/** Removes a daemon object, reading its already-gone answer as success — the fence's tolerance. */
const removeTolerantly = async (execDocker: ExecDocker, args: string[]): Promise<boolean> => {
    try {
        await execDocker(args);
        return true;
    } catch (e) {
        if (alreadyGone(e)) return false;
        throw e;
    }
};

/**
 * The attempt's services network — attempt-scoped by name, so it can only ever resolve to this
 * dead attempt's own. A gate environment on its cooldown may still be attached, and docker
 * refuses to remove a network with an endpoint, so whatever is left is disconnected first — the
 * exact shape of the teardown this complements.
 */
const removeNetwork = async (execDocker: ExecDocker, network: string): Promise<boolean> => {
    try {
        const attached = await execDocker([
            'network',
            'inspect',
            '--format',
            '{{range .Containers}}{{println .Name}}{{end}}',
            network,
        ]);
        for (const name of linesOf(attached.stdout)) {
            await removeTolerantly(execDocker, ['network', 'disconnect', '-f', network, name]);
        }
    } catch {
        // Unreadable network is removed blind below; absence is the goal either way.
    }
    return removeTolerantly(execDocker, ['network', 'rm', network]);
};

const reap = async (execDocker: ExecDocker, group: OrphanGroup): Promise<readonly string[]> => {
    const removed: string[] = [];
    // The network goes first: scan lists service containers only, so a network that fails to
    // come down after the containers are gone would be undiscoverable to every later sweep.
    if (group.leaseToken) {
        const network = networkName({ id: group.jobId, leaseToken: group.leaseToken } as BoardJob);
        if (await removeNetwork(execDocker, network)) removed.push(`network ${network}`);
    }
    // The containers before the volumes they mount: docker refuses to remove a volume in use.
    for (const object of group.objects.filter((candidate) => candidate.kind === 'container')) {
        if (await removeTolerantly(execDocker, ['rm', '-f', object.name])) {
            removed.push(`container ${object.name}`);
        }
    }
    for (const object of group.objects.filter((candidate) => candidate.kind === 'volume')) {
        if (await removeTolerantly(execDocker, ['volume', 'rm', '-f', object.name])) {
            removed.push(`volume ${object.name}`);
        }
    }
    return removed;
};

/**
 * `holdsGate` is the live gate manager's answer for a container name: an environment this
 * process still holds is never an orphan, whatever its creation-time labels say. A dead
 * driver's environment is held by nobody, so it is reaped on the same lease lookup as a fleet.
 */
export function createDockerReaper(
    execDocker: ExecDocker,
    holdsGate: (containerName: string) => boolean = () => false
): ReaperArm {
    return {
        scan: () => scan(execDocker, holdsGate),
        reap: (group) => reap(execDocker, group),
    };
}
