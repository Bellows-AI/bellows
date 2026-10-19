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
