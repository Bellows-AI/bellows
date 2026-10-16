import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { awaitSupervisor } from './docker-group.js';
import type { ExecDocker } from './docker-runner-support.js';
import { linesOf } from './docker-runner-support.js';
import { JOB_LABEL, LEASE_LABEL, ROLE_LABEL, SERVICE_LABEL } from './labels.js';
import { forgetDeclaredServices, networkName } from './services.js';
import { AGENT_CONTAINER, KILL_WINDDOWN_MS } from './supervisor-contract.js';

/**
 * The docker runner's teardowns: this attempt's services and network, the hard kill of its whole
 * container group (agent, supervisor, exporter), and the supervised stop that tries the
 * supervisor's own wind-down first. Split from `docker-runner.ts`, which hands them its deps.
 */

/** What a teardown needs of the runner: the daemon, the config, and the attempt kill set. */
export interface TeardownDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    killed: Set<BoardJob['leaseToken']>;
    /** The attempt groups the runner remembers (`docker-runner.ts`): a killed group is gone from it. */
    groups?: Map<BoardJob['leaseToken'], unknown>;
}

/**
 * Tears down THIS attempt's services and network — and, by construction, nothing else. The `ps`
 * filters carry this attempt's lease token beside the job id, and the network it removes is named
 * after the token too, so every call here resolves only to resources this attempt created. That
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
    const found = await deps
        .execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
            '--filter',
            `label=${SERVICE_LABEL}`,
        ])
        .catch(() => ({ stdout: '' }));
    for (const id of linesOf(found.stdout)) {
        await deps.execDocker(['rm', '-f', id]).catch(() => undefined);
    }
    // The gate environment joins this network to reach the fleet, and outlives the attempt on
    // its cooldown; docker refuses to remove a network with an endpoint still attached, so
    // whatever is left on it is detached first.
    const attached = await deps
        .execDocker([
            'network',
            'inspect',
            '--format',
            '{{range .Containers}}{{println .Name}}{{end}}',
            networkName(job),
        ])
        .catch(() => ({ stdout: '' }));
    for (const name of linesOf(attached.stdout)) {
        await deps.execDocker(['network', 'disconnect', '-f', networkName(job), name]).catch(() => undefined);
    }
    await deps.execDocker(['network', 'rm', networkName(job)]).catch(() => undefined);
}

export async function dockerKill(deps: TeardownDeps, job: BoardJob): Promise<void> {
    // Recorded before anything is torn down: this attempt, sitting in its services setup,
    // reads this between awaited steps and aborts instead of creating more resources or
    // spawning the runner over a lease that is already gone. The token, not the id, is what
    // is recorded — a sibling attempt of the same job carries a different token and must
    // not read this one's cancellation.
    deps.killed.add(job.leaseToken);
    deps.groups?.delete(job.leaseToken);
    // Killing the attached `docker start` process would only detach the CLI; the container keeps running
    // and the workspace keeps being written to. The daemon has to be told — by ID, resolved
    // through this attempt's own lease label, never by name: a kill that resolved a
    // job-derived name would address whatever owns that name at daemon-execution time, and
    // names are attempt-scoped now precisely so no such ambiguity exists. The label pair
    // (job, lease) resolves to this attempt's containers alone; a stale kill that finds
    // nothing has nothing of its own left to kill.
    const found = await deps
        .execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
        ])
        .catch(() => ({ stdout: '' }));
    // The whole group — the agent, the supervisor and the exporter: this is the hard kill. The
    // supervised one (`dockerStopAgent`) lets the supervisor end the agent and drain the exporter
    // first, and only comes here past its bound.
    for (const id of linesOf(found.stdout)) {
        await deps.execDocker(['kill', id]).catch(() => undefined);
    }
    // The declared services go with the runner: a killed job's database has no reason to
    // outlive the job, and the close handler's teardown would catch them anyway — this is so
    // a kill while nothing is reading the outcome (lost lease, shutdown) still reclaims them.
    // Attempt-scoped, like every teardown: whatever a replacement attempt is running is
    // invisible to these filters.
    await dockerServiceTeardown(deps, job);
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
 */
export async function dockerStopAgent(deps: TeardownDeps, job: BoardJob): Promise<void> {
    deps.killed.add(job.leaseToken);
    const exit = await awaitSupervisor(deps.execDocker, job, KILL_WINDDOWN_MS);
    if (exit === null) return dockerKill(deps, job);
    const running = await deps
        .execDocker([
            'ps',
            '-q',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
            '--filter',
            `label=${ROLE_LABEL}=${AGENT_CONTAINER}`,
        ])
        .catch(() => ({ stdout: '' }));
    for (const id of linesOf(running.stdout)) {
        await deps.execDocker(['kill', id]).catch(() => undefined);
    }
    await dockerServiceTeardown(deps, job);
}
