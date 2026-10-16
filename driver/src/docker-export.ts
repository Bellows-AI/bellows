import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { gateEnvFileBody, UUID, workspacePath } from './claim.js';
import { claudeExportScript } from './container-scripts.js';
import { containerHardeningArgs, containerName, workspacesMountArgs } from './docker.js';
import type { ExecDocker, RunnerFiles } from './docker-runner-support.js';
import { EXPORT_LABEL, JOB_LABEL, LEASE_LABEL } from './labels.js';
import type { RunSession } from './runner.js';
import { exportEnv, exportsTranscript } from './transcript-export.js';

/**
 * The docker half of the continuous claude-code transcript exporter: one detached container over
 * the workspaces volume, beside the runner and NOT the runner — a kill of the agent (which resolves
 * its containers by the job and lease labels, minus `factory.export`) never reaches it, so it goes
 * on draining what the agent wrote. The loop ends it with `stopDockerExporter` once it reported
 * `done`; it also exits by itself when its control token is closed or the driver stays gone.
 */

const exportName = (job: BoardJob): string => `factory-export-${job.id}-${job.leaseToken}`;

/** The exporter's env file: only the control pair, never the claim env the runner carries. */
const exportEnvFilePath = (job: BoardJob): string => {
    if (!UUID.test(job.id) || !UUID.test(job.leaseToken)) {
        throw new Error(`refusing to write an exporter env file for job ${job.id}: ids that are not uuids`);
    }
    return join(tmpdir(), `factory-export-env-${job.id}-${job.leaseToken}.env`);
};

/** The full `docker run` argv of the exporter — pure and exported, the part worth pinning. */
export function claudeExportArgs(config: DriverConfig, job: BoardJob, startedAt: string, envFile: string): string[] {
    const env = exportEnv(config, job, startedAt);
    return [
        'run',
        '-d',
        '--rm',
        ...containerHardeningArgs(),
        '--name',
        exportName(job),
        '--label',
        `${JOB_LABEL}=${job.id}`,
        '--label',
        `${LEASE_LABEL}=${job.leaseToken}`,
        '--label',
        `${EXPORT_LABEL}=true`,
        ...workspacesMountArgs(config, workspacePath(job)),
        // The control URL names the driver as the runner does; Linux needs the name mapped.
        '--add-host',
        'host.docker.internal:host-gateway',
        ...(config.network ? ['--network', config.network] : []),
        '--env-file',
        envFile,
        ...env.literals.flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        claudeExportScript,
    ];
}

/**
 * Starts the attempt's exporter. A failure throws: a run whose transcript cannot be exported is an
 * infrastructure refusal the loop leaves to its lease, never a run that silently loses its record.
 */
export async function startDockerExporter(
    deps: { config: DriverConfig; execDocker: ExecDocker; files: RunnerFiles },
    job: BoardJob,
    startedAt: string
): Promise<void> {
    const { config, execDocker, files } = deps;
    const file = exportEnvFilePath(job);
    await files.writeFile(file, gateEnvFileBody(job, exportEnv(config, job, startedAt).control), { mode: 0o600 });
    try {
        await execDocker(claudeExportArgs(config, job, startedAt, file));
    } finally {
        await files.rm(file).catch(() => undefined);
    }
}

/** The `docker ps` filter a kill of the agent adds, so the exporter is not among the containers it resolves. */
export const NOT_THE_EXPORTER = ['--filter', `label!=${EXPORT_LABEL}`];

/**
 * Starts the exporter beside the agent for a run that exports its transcript (nothing otherwise).
 * When it cannot start, the agent's created container and the claim env file are removed before the
 * failure propagates: the run never began, and the loop leaves the job to its lease.
 */
export async function startExporterBesideRunner(
    deps: { config: DriverConfig; execDocker: ExecDocker; files: RunnerFiles },
    job: BoardJob,
    session: RunSession | null,
    claimEnvFile: string | null
): Promise<void> {
    if (!exportsTranscript(job, session)) return;
    try {
        await startDockerExporter(deps, job, new Date().toISOString());
    } catch (e) {
        await deps.execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);
        if (claimEnvFile) await deps.files.rm(claimEnvFile).catch(() => undefined);
        throw e;
    }
}

/** Removes the attempt's exporter container; tolerant of it being gone already. */
export async function stopDockerExporter(execDocker: ExecDocker, job: BoardJob): Promise<void> {
    await execDocker(['rm', '-f', exportName(job)]).catch(() => undefined);
}
