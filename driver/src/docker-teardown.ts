import type { BoardJob } from './board.js';
import type { KillLedger } from './kill-ledger.js';
import type { DriverConfig } from './config.js';
import { awaitSupervisor } from './docker-group.js';
import { killMarkName } from './docker-mailbox.js';
import type { ExecDocker } from './docker-runner-support.js';
import { idLines, noSuchObject, readDocker } from './docker-runner-support.js';
import { JOB_LABEL, LEASE_LABEL, ROLE_LABEL, SERVICE_LABEL } from './labels.js';
import { Inconclusive } from './runner.js';
import { forgetDeclaredServices } from './services.js';
import type { StepSink } from './step-control.js';
import { releaseSteps } from './supervised-steps.js';
import { AGENT_CONTAINER, KILL_WINDDOWN_MS } from './supervisor-contract.js';
import { KILL_REASONS, type KillRecord, killMarkOf, killRecordsOf } from './termination.js';

/** How long recording a kill's reason may hold the kill back; a record that fails never holds it. */
const RECORD_KILL_TIMEOUT_MS = 5_000;

/**
 * The docker runner's teardowns: this attempt's services, the hard kill of its whole
 * container group (agent, supervisor, exporter), and the supervised stop that tries the
 * supervisor's own wind-down first. Split from `docker-runner.ts`, which hands them its deps.
 */

/** What a teardown needs of the runner: the daemon, the config, and the attempt kill set. */
export interface TeardownDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    /**
     * What this driver did to each attempt: a hard kill (`dockerKill`) makes their supervisor's exit
     * the kill's, never a loss; a supervised stop (`dockerStopAgent`) is not one.
     */
    ledger: KillLedger;
    /** The attempt groups the runner remembers (`docker-runner.ts`): a killed group is gone from it. */
    groups?: Map<BoardJob['leaseToken'], unknown>;
    /** The step channel the groups serve: a group gone leaves no step waiting on it. */
    steps?: StepSink;
}

/**
 * Records why the driver is ending the attempt, on a marker volume of its own that outlives the
 * driver: the claim adopting the run reads it back (`readDockerKills`), and the re-claim fence
 * sweeps it with the attempt's other volumes. One volume per reason, so two that both fired are
 * both kept. Rejects when the daemon refuses.
 */
export async function recordDockerKill(execDocker: ExecDocker, job: BoardJob, kill: KillRecord): Promise<void> {
    await execDocker(
        [
            'volume',
            'create',
            '--label',
            `${JOB_LABEL}=${job.id}`,
            '--label',
            `${LEASE_LABEL}=${job.leaseToken}`,
            '--label',
            `${killMarkOf(kill.reason)}=${kill.detail}`,
            killMarkName(job, kill.reason),
        ],
        { timeout: RECORD_KILL_TIMEOUT_MS }
    );
}

/** The reasons recorded on an attempt; a reason never recorded reads absent, any other refusal throws. */
export async function readDockerKills(execDocker: ExecDocker, job: BoardJob): Promise<KillRecord[]> {
    const records: KillRecord[] = [];
    for (const reason of KILL_REASONS) {
        const read = await execDocker(['volume', 'inspect', '--format', '{{json .Labels}}', killMarkName(job, reason)])
            .then((out) => out.stdout)
            .catch((e: unknown) => {
                if (noSuchObject(e, ['volume'])) return null;
                throw e;
            });
        const labels = read === null ? null : labelsOf(read);
        // The name carries the attempt; the label pair says so too, or it is no record of this one.
        if (labels?.[JOB_LABEL] !== job.id || labels[LEASE_LABEL] !== job.leaseToken) continue;
        records.push(...killRecordsOf(labels).filter((record) => record.reason === reason));
    }
    return records;
}

/**
 * A volume's labels as `inspect` answers them; null for a volume that carries none. Anything else
 * is `Inconclusive` — a record that cannot be read is no proof there is none (#824).
 */
function labelsOf(read: string): Record<string, string> | null {
    let labels: unknown;
    try {
        labels = JSON.parse(read);
    } catch {
        throw new Inconclusive('a kill marker answered labels that are not JSON');
    }
    if (labels === null) return null;
    if (
        typeof labels !== 'object' ||
        Array.isArray(labels) ||
        !Object.values(labels).every((v) => typeof v === 'string')
    ) {
        throw new Inconclusive('a kill marker answered labels that are not a label map');
    }
    return labels as Record<string, string>;
}

/** Records the reason, then hard-kills the group: a record that fails never holds the kill back. */
export async function dockerKillFor(deps: TeardownDeps, job: BoardJob, kill: KillRecord): Promise<void> {
    await deps.ledger.record(job, kill).catch(() => undefined);
    await dockerKill(deps, job);
}

/**
 * Tears down THIS attempt's services — and, by construction, nothing else. The `ps` filters carry
 * this attempt's lease token beside the job id, so every call here resolves only to containers
 * this attempt created; they share their group supervisor's namespace, so no network is theirs. That
 * is what makes it safe to run UNCONDITIONALLY, from every closing path: a close that lands late,
 * a kill that lands after a replacement claim stood its own fleet up, a spawn error racing a newer
 * attempt's setup — none of them can NAME anything but this attempt's own fleet, so none of them
 * needs an ownership gate. Daemon calls are arbitrarily slow and attempts can supersede each other
 * mid-call; attempt scoping is what holds at execution time, because it is not a snapshot but a
 * property of the argv itself.
 *
 * Every removal tolerates the thing already being gone, which makes the whole teardown
 * idempotent — it runs twice per attempt by design, as the fence's service half before the run
 * and as the teardown after it.
 */
export async function dockerServiceTeardown(deps: TeardownDeps, job: BoardJob): Promise<void> {
    if (!deps.config.servicesEnabled) return;
    forgetDeclaredServices(job);
    // A listing that is refused or is no list of ids removes nothing (#869): no read is a target.
    const found = await readDocker(
        deps.execDocker,
        [
            'ps',
            '-aq',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
            '--filter',
            `label=${SERVICE_LABEL}`,
        ],
        'listing the attempt services',
        { parse: idLines }
    );
    for (const id of found.kind === 'value' ? found.value : []) {
        await deps.execDocker(['rm', '-f', id]).catch(() => undefined);
    }
}

export async function dockerKill(deps: TeardownDeps, job: BoardJob): Promise<void> {
    // Recorded before anything is torn down: this attempt, sitting in its services setup,
    // reads this between awaited steps and aborts instead of creating more resources or
    // spawning the runner over a lease that is already gone. The token, not the id, is what
    // is recorded — a sibling attempt of the same job carries a different token and must
    // not read this one's cancellation.
    deps.ledger.note(job, 'hard');
    deps.groups?.delete(job.leaseToken);
    if (deps.steps) releaseSteps({ sink: deps.steps }, job);
    // Killing the attached `docker start` process would only detach the CLI; the container keeps running
    // and the workspace keeps being written to. The daemon has to be told — by ID, resolved
    // through this attempt's own lease label, never by name: a kill that resolved a
    // job-derived name would address whatever owns that name at daemon-execution time, and
    // names are attempt-scoped now precisely so no such ambiguity exists. The label pair
    // (job, lease) resolves to this attempt's containers alone; a stale kill that finds
    // nothing has nothing of its own left to kill.
    const found = await readDocker(
        deps.execDocker,
        ['ps', '-aq', '--filter', `label=${JOB_LABEL}=${job.id}`, '--filter', `label=${LEASE_LABEL}=${job.leaseToken}`],
        'listing the attempt group',
        { parse: idLines }
    );
    // The whole group — the agent, the supervisor and the exporter: this is the hard kill. The
    // supervised one (`dockerStopAgent`) lets the supervisor end the agent and drain the exporter
    // first, and only comes here past its bound.
    for (const id of found.kind === 'value' ? found.value : []) {
        await deps.execDocker(['kill', id]).catch(() => undefined);
    }
    // The declared services stay: the kill is the immediate safety stop, and reclamation is
    // `end()`'s `releaseServices`, once the board holds the outcome and unless the runner is retained.
}

/**
 * Ends the agent under its supervisor — the docker twin of the kubernetes `stopAgent`. The loop
 * has raised the kill order on the control channel, so the supervisor ends the agent, has the
 * exporter drain and finalizes, and the group ends by itself: this waits (bounded) for the
 * supervisor to exit, and past the bound — or when there is no supervisor to wait for — falls back
 * to the hard kill. The attached run resolves with the real outcome meanwhile.
 *
 * A supervisor exit is no sign the agent ended: one that crashed or was lost answers the wait at
 * once, with nobody left to deliver the kill order. Whatever it exited with, the agent still
 * running is killed — the agent alone, so the group stays for the close path to finish, and a lost
 * supervisor stays an interruption for the next claim (`supervisorLossOf`), never a failed run.
 * Never throws, like `dockerKill`: a lookup the daemon refused falls back to the hard kill, and a
 * refused kill to force-removing the agent.
 */
export async function dockerStopAgent(deps: TeardownDeps, job: BoardJob): Promise<void> {
    deps.ledger.note(job, 'stopped');
    const exit = await awaitSupervisor(deps.execDocker, job, KILL_WINDDOWN_MS);
    if (exit === null) return dockerKill(deps, job);
    // The supervisor ended the group: nobody is left to answer its steps.
    if (deps.steps) releaseSteps({ sink: deps.steps }, job);
    const running = await readDocker(
        deps.execDocker,
        [
            'ps',
            '-q',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
            '--filter',
            `label=${ROLE_LABEL}=${AGENT_CONTAINER}`,
        ],
        'listing the attempt agent',
        { parse: idLines }
    );
    if (running.kind !== 'value') return dockerKill(deps, job);
    for (const id of running.value) {
        await deps
            .execDocker(['kill', id])
            .catch(() => deps.execDocker(['rm', '-f', id]))
            .catch(() => undefined);
    }
}
