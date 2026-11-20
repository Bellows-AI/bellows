import { otel } from './otel-register.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createBoard } from './board/board.js';
import { boardCredentialOf } from './board-credential.js';
import { gateAdvertiseUrlFor, loadDriverConfig } from './config.js';
import { createDockerReaper } from './docker/docker-reaper.js';
import { boardIdentity } from './task-volume.js';
import { createDriverMetrics } from './driver-metrics.js';
import { createDockerRunner, defaultExecDocker } from './docker/docker-runner.js';
import { createSupervisedGateManager } from './gate-manager.js';
import { createGateServer } from './gates.js';
import { createKubernetesReaper } from './k8s/k8s-reaper.js';
import { createKubernetesRunner } from './k8s/k8s-runner.js';
import { assertRunnerClassRuntimes } from './k8s/k8s-runtime-class.js';
import { inClusterRequest } from './k8s/k8s-transport.js';
import { createStepBroker, type SupervisorEndpoint } from './step-control.js';
import { createLoop } from './loop/loop.js';
import { createVolumeExportOpener } from './loop/loop-export.js';
import type { GateStack } from './loop/loop-types.js';
import { createReaper } from './reaper.js';
import { run } from './docker/docker-runner-support.js';
import { stripSecretStoreEnv } from './strip-secret-store-env.js';
import { createDrain } from './drain.js';
import { logger } from './log.js';
import { createFlushThenExit } from './shutdown.js';

stripSecretStoreEnv(process.env);

const config = loadDriverConfig(process.env);
// The one exit path, on a drain's normal end and on a handover alike (src/shutdown.ts).
const flushThenExit = createFlushThenExit({ otel, exit: (code) => process.exit(code) });
const log = {
    driver: logger('driver'),
    loop: logger('loop'),
    reaper: logger('reaper'),
    drain: logger('drain'),
    export: logger('export'),
};
const HEARTBEAT_INTERVAL_MS = 10_000;

// Timer-driven, not poll-driven: a drain stops polling for as long as its jobs take, and a probe
// that read that as death would kill the drain it is waiting on. What it proves is a turning
// event loop — the one failure a process that stays up would otherwise hide from the kubelet.
if (config.heartbeatFile) {
    const file = config.heartbeatFile;
    const beat = () => writeFileSync(file, `${Date.now()}\n`);
    beat();
    setInterval(beat, HEARTBEAT_INTERVAL_MS).unref();
}

const missing = config.passEnv.filter((name) => !process.env[name]);
if (missing.length === config.passEnv.length) {
    // Not fatal: an image with a login baked into a mounted volume needs none of these. Worth
    // saying out loud, because the alternative first symptom is every job failing at the CLI's
    // login prompt with an exit code and no explanation.
    log.driver.warn(`none of ${config.passEnv.join(', ')} are set; runners will have no credential`);
}

// The instruments every call below reports into; shipped over OTLP when an endpoint is configured.
const metrics = createDriverMetrics({ boardUrl: config.boardUrl });
const board = createBoard({
    url: config.boardUrl,
    leaseSeconds: config.leaseSeconds,
    // Read for every call: a rotated DRIVER_CREDENTIAL_FILE takes effect with no restart.
    credential: boardCredentialOf(config),
    fetch: metrics.fetch,
    onMalformedClaim: (fields) => {
        log.driver.error(`the board delivered a malformed claim (${fields.join(', ')}); left to its lease`);
        metrics.malformedClaim(fields);
    },
    onPoll: metrics.claimPoll,
});
// EXECUTOR picks the platform runners run on. `inClusterRequest()` is fatal here rather than on
// the first claim: a driver asked for kubernetes outside a cluster should say so at startup.
const request = config.executor === 'kubernetes' ? inClusterRequest() : null;
// A docker class runs dockerd privileged, and a class tolerating a sandbox pool's taint lands on
// that pool: refuse to boot, before anything claims or reaps, unless each such class names a
// RuntimeClass its pools list, read and proven Kata.
if (request) await assertRunnerClassRuntimes(config.runnerClasses, config.sandboxPools, request);
// The supervised-step channel: the broker the runners submit steps to and the gate server's control
// endpoint serves them from, and the endpoint a runner opens a supervisor-only token on
// for a group with no attempt (a terminal reclaim). `gates` is bound below; both read it lazily.
const steps = createStepBroker(metrics.step);
const endpoint: SupervisorEndpoint = {
    open: async () => {
        const token = randomUUID();
        steps.open(token);
        return { url: gates.advertiseUrl(await gates.server.listen()), token };
    },
    close: (token) => steps.close(token),
};
const runner =
    config.executor === 'kubernetes'
        ? createKubernetesRunner(config, metrics.k8s(request!, 'runner'), undefined, {
              leases: (ids) => board.leases(ids),
              checkpoints: board,
              steps,
              endpoint,
          })
        : createDockerRunner(config, undefined, metrics.docker(defaultExecDocker, 'runner'), {
              steps,
              endpoint,
              checkpoints: board,
          });

// The gate machinery is one on both executors: every gate and the setup run in the
// attempt's own task group, the declared image as a gate container beside the supervisor, as one
// supervised step each — the runner makes the group, the loop does not. The endpoint is NOT opened
// here — the server listens lazily on the first launched attempt (it also carries the run-control
// channel).
const manager = createSupervisedGateManager({ config, runner });
const gates: GateStack = {
    manager,
    server: createGateServer({ host: config.gateListenHost, manager, steps }),
    advertiseUrl: (port) => gateAdvertiseUrlFor(config.gateAdvertiseUrl, port),
};

const loop = createLoop({
    board,
    runner,
    config,
    gates,
    log: (m) => log.loop.info(m),
});
metrics.observeSlots(() => loop.slots());

// The orphan reaper: the periodic watcher that reaps service objects whose owning
// job can no longer use them — the fleet of a terminal, dead, board-unknown or superseded
// attempt, whose own teardown never ran. Independent of any claim: its deletes are board-gated
// and attempt-scoped, so it can share the executor with the fence without ever racing it, and
// it is idempotent, so every replica may run one. Zero interval is the off switch.
// A not-whole thread's volume is exported before it is deleted: the arms run the one-shot
// exporter, and this opener hands it a relay through the gate server on the board's behalf.
const exporting = { open: createVolumeExportOpener({ board, gates, log: (m) => log.export.info(m) }) };
const reaper = createReaper({
    board,
    arm:
        config.executor === 'kubernetes'
            ? createKubernetesReaper({ config, request: metrics.k8s(request!, 'reaper'), exporting })
            : createDockerReaper(
                  metrics.docker((args, options) => run('docker', args, { ...options, encoding: 'utf8' }), 'reaper'),
                  boardIdentity(config),
                  { config, ...exporting }
              ),
    executor: config.executor,
    exportAttempts: config.taskVolumeExportAttempts,
    intervalMs: config.reapIntervalMs,
    graceMs: config.reapGraceMs,
    volumePolicy: { ttlMs: config.taskVolumeTtlMs, boundMs: config.taskVolumeBoundMs },
    observe: metrics.reaper,
    log: (m) => log.reaper.info(m),
});
if (config.reapIntervalMs > 0) reaper.start();

// Stop claiming, then hand over. A second signal is the escape hatch. The runs in flight go back
// to the board as interruptions — claimable at once, runners left up for the next claim — at
// DRIVER_HANDOVER_MS (0: inside the signal), not with every lease held when the SIGKILL lands.
const drain = createDrain({
    loop,
    reaper,
    handoverMs: config.handoverMs,
    log: (m) => log.drain.info(m),
    exit: (code) => void flushThenExit(code),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => drain.onSignal());

await loop.start();
// The drain above lets in-flight jobs finish — including their gates, which end with their groups.
await gates.manager.stop();
// The ad-hoc socket holds the event loop open; without this the process never exits after a
// graceful drain once any gated job has run.
await gates.server.close();
// A handed-over run's poll is still pending in this process, and is no longer this driver's: it exits at once. A
// drain that ended with no handover (no task running, or every one finished first) flushes the SDK all the same,
// or its buffered logs, spans and last metrics are lost.
await flushThenExit(0);
