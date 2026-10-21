import type { BoardJob } from './board.js';
import { envFileBody } from './claim.js';
import type { DriverConfig } from './config.js';
import { containerName, envFilePath } from './docker.js';
import { removeGroup } from './docker-group.js';
import {
    assertJobNotKilled,
    assertNotKilledAfterEnvWrite,
    createRunnerContainer,
    type ExecDocker,
    type RunnerFiles,
} from './docker-runner-support.js';
import type { KillLedger } from './kill-ledger.js';
import type { RunOutcome, RunSession } from './runner.js';

/** What creating the runner container needs of the docker runner's dependencies. */
export interface CreateDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    files: RunnerFiles;
    ledger: KillLedger;
    groups: Map<string, unknown>;
}

/**
 * Creates the attempt's runner container. Answers the env file the run removes when it is over (null
 * when it needs none), or the refusal the daemon gave the create.
 */
export async function createRunner(
    deps: CreateDeps,
    execDocker: ExecDocker,
    job: BoardJob,
    session: RunSession | null
): Promise<{ file: string | null; refused?: RunOutcome }> {
    const { config, files, ledger } = deps;
    const teardown = deps.execDocker;
    // The runner container is the last resource this attempt creates, and the spawn is
    // what a killed setup must never reach — see assertJobNotKilled for why a throw is
    // the right verdict here.
    assertJobNotKilled(ledger, job);

    /*
     * The env file's ride: a 0600 file in the OS temp directory, written just before the spawn
     * and removed as soon as the run is over — a crash leaves it in tmpdir at worst, never
     * in argv and never in this process's environment. The body is the claim env PLUS the
     * loop's minted gate credentials PLUS the runner's own attempt pair, so a gated job whose
     * claim resolves to nothing still carries its BELLOWS_GATE_URL/TOKEN and the credential
     * its attribution reports authenticate with.
     */
    const body = envFileBody(job, config);
    const file = body ? envFilePath(job) : null;
    if (file) await files.writeFile(file, body, { mode: 0o600 });
    // The write above is an await, so the kill-check must run once more: see
    // assertNotKilledAfterEnvWrite for why a lease lost while it was pending must not
    // reach spawnFn.
    await assertNotKilledAfterEnvWrite({ ledger, job, files }, file);

    // The run's start instant (the group's, which the exporter and both close-time turn reads key
    // on): a follow-up resumes its session's conversation, so the delta each read reports is
    // bounded to what THIS run wrote.
    const made = { config, execDocker, teardown };
    const refused = await createRunnerContainer(made, job, session, file ? { envFile: file } : {});
    if (refused && !ledger.was(job).stopped) {
        if (file) await files.rm(file).catch(() => undefined);
        return { file, refused };
    }
    // The create and the copy are awaits too: a lease lost behind them must not reach the start.
    // The created container is this attempt's leftover to remove, the group and the env file with it.
    if (ledger.was(job).stopped) {
        await teardown(['rm', '-f', containerName(job)]).catch(() => undefined);
        await removeGroup(teardown, job);
        deps.groups.delete(job.leaseToken);
        await assertNotKilledAfterEnvWrite({ ledger, job, files }, file);
    }
    return { file };
}
