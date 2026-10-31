/**
 * The container scripts the driver ships: real files under `driver/src/scripts/`, read at load
 * time and passed to the container by content (`node -e`, `sh -c`, a git credential helper) —
 * never inline template strings in TS, and never by mounting a path (the driver talks to a remote
 * daemon or API server and has no host path into the volumes it names). Under tsx and vitest this
 * resolves into `src/scripts/`; in the built driver into `dist/scripts/`, where the build copies
 * the directory — forgetting THAT copy fails only in the container, the server/migrations trap.
 *
 * Executor-neutral: the docker and kubernetes runners hand the same bytes to their containers.
 * The run-time scripts live here; publish.ts, review.ts and services.ts load their own through
 * `containerScript`.
 */

import { readFileSync } from 'node:fs';
import { SERVICE_GENERATIONS, SUPERVISOR_BINDING } from './supervisor-contract.js';

export const containerScript = (name: string): string =>
    readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');
const script = containerScript;

/** The close-time opencode readout: see scripts/opencode-readout.cjs. */
export const opencodeReadoutScript = script('opencode-readout.cjs');

/** The close-time claude-code turn count: see scripts/claude-turns.cjs. */
export const claudeTurnsScript = script('claude-turns.cjs');

/** The continuous claude-code transcript exporter: see scripts/claude-export.cjs. */
export const claudeExportScript = script('claude-export.cjs');

/** The task supervisor, the trusted container of a run's pod: see scripts/supervisor.cjs. */
export const supervisorScript = script('supervisor.cjs');

/** The `git` every supervised step runs, execution-capable checkout config neutralized: see scripts/git-harden.cjs. */
export const gitHardenScript = script('git-harden.cjs');

/** The attempt's checkpoint at finalize (issue #775): see scripts/checkpoint.cjs. */
export const checkpointScript = script('checkpoint.cjs');

/** The task tree rebuilt from the thread's checkpoint on a replacement volume (issue #775): see scripts/checkpoint-restore.cjs. */
export const checkpointRestoreScript = script('checkpoint-restore.cjs');

/** The live cache probe: see scripts/opencode-cache-probe.cjs. */
export const opencodeCacheProbeScript = script('opencode-cache-probe.cjs');

/** A gate's shell, umask 002 for the tool uid's shared tree: see scripts/gate-shell.sh. */
export const gateShellScript = script('gate-shell.sh');

/** A gate's argv on both executors: the declared command is one element after the gate shell. */
export const gateShellArgv = (command: string): string[] => ['sh', '-c', gateShellScript, 'gate', command];

/** The gate container's loop over the gate mailbox: see scripts/gate-loop.sh. */
export const gateLoopScript = script('gate-loop.sh');

/** The gate container's command on both executors: the loop, with the gate shell it runs each request under. */
export const gateLoopArgv = (): string[] => ['sh', '-c', gateLoopScript, 'gate-loop', gateShellScript];

/** The reviewer container's loop over the review mailbox (issue #774): see scripts/review-loop.sh. */
export const reviewLoopScript = script('review-loop.sh');

/** The reviewer container's command on both executors: the loop, running each request's executor entrypoint argv. */
export const reviewLoopArgv = (): string[] => ['sh', '-c', reviewLoopScript, 'review-loop'];

/** A declared service sidecar's liveness probe (kubernetes): see scripts/service-generation-probe.sh. */
export const serviceGenerationProbeScript = script('service-generation-probe.sh');

/** The supervisor's acknowledgement read and generation bump of the services: see scripts/service-generation-bump.sh. */
export const serviceGenerationBumpScript = script('service-generation-bump.sh');

/** Writes the holder binding atomically into the supervisor's binding volume: see scripts/binding-write.sh. */
export const bindingWriteScript = script('binding-write.sh');

/** The binding write's `exec` command: the body arrives on stdin, `size` is its byte count. */
export const bindingWriteArgv = (size: number): string[] => [
    'sh',
    '-c',
    bindingWriteScript,
    'binding-write',
    SUPERVISOR_BINDING.dir,
    String(size),
];

/** The probe's `exec` command for one service's sidecar. */
export const serviceProbeArgv = (name: string): string[] => [
    'sh',
    '-c',
    serviceGenerationProbeScript,
    'service-probe',
    SERVICE_GENERATIONS.path,
    name,
    SERVICE_GENERATIONS.ackPath,
];

/** A `restart` step's argv: which services have not acknowledged (`acked`), or the bump of every one named. */
export const serviceRestartArgv = (mode: 'acked' | 'bump', names: readonly string[]): string[] => [
    'sh',
    '-c',
    serviceGenerationBumpScript,
    'service-generation',
    mode,
    SERVICE_GENERATIONS.path,
    SERVICE_GENERATIONS.ackRoot,
    ...names,
];

/** A task's input files delivered into a directory from the control endpoint: see scripts/attachment-fetch.cjs. */
export const attachmentFetchScript = script('attachment-fetch.cjs');
