import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createBoard } from './board.js';
import { gateAdvertiseUrlFor, loadDriverConfig } from './config.js';
import { createDockerReaper } from './docker-reaper.js';
import { createDockerRunner } from './docker-runner.js';
import { createGateServer, createSupervisedGateManager } from './gates.js';
import { createKubernetesReaper } from './k8s-reaper.js';
import { createKubernetesRunner } from './k8s-runner.js';
import { inClusterRequest } from './k8s-transport.js';
import { createStepBroker, type SupervisorEndpoint } from './step-control.js';
import { createLoop } from './loop.js';
import type { GateStack } from './loop-types.js';
import { createReaper } from './reaper.js';
import { run } from './docker-runner-support.js';

const config = loadDriverConfig(process.env);
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
    console.warn(`[driver] none of ${config.passEnv.join(', ')} are set; runners will have no credential`);
}

const board = createBoard({
    url: config.boardUrl,
    leaseSeconds: config.leaseSeconds,
    token: config.boardToken,
});
// EXECUTOR picks the platform runners run on. `inClusterRequest()` is fatal here rather than on
// the first claim: a driver asked for kubernetes outside a cluster should say so at startup.
const request = config.executor === 'kubernetes' ? inClusterRequest() : null;
// The supervised-step channel: the broker the runners submit steps to and the gate server's control
// endpoint serves them from (issue #771), and the endpoint a runner opens a supervisor-only token on
// for a group with no attempt (a terminal reclaim). `gates` is bound below; both read it lazily.
const steps = createStepBroker();
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
        ? createKubernetesRunner(config, request!, undefined, {
              leases: (ids) => board.leases(ids),
              checkpoints: board,
              steps,
              endpoint,
          })
        : createDockerRunner(config, undefined, undefined, { steps, endpoint, checkpoints: board });

// The gate machinery is one on both executors (issue #773): every gate and the setup run in the
// attempt's own task group, the declared image as a gate container beside the supervisor, as one
// supervised step each — the runner makes the group, the loop does not. The endpoint is NOT opened
// here — the server listens lazily on the first launched attempt (it also carries the run-control
// channel, issue #442).
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
    log: (m) => console.log(`[driver] ${m}`),
});

// The orphan reaper (issue #301): the periodic watcher that reaps service objects whose owning
// job can no longer use them — the fleet of a terminal, dead, board-unknown or superseded
// attempt, whose own teardown never ran. Independent of any claim: its deletes are board-gated
// and attempt-scoped, so it can share the executor with the fence without ever racing it, and
// it is idempotent, so every replica may run one. Zero interval is the off switch.
const reaper = createReaper({
    board,
    arm:
        config.executor === 'kubernetes'
            ? createKubernetesReaper({ config, request: request! })
            : createDockerReaper((args, options) => run('docker', args, { ...options, encoding: 'utf8' })),
    intervalMs: config.reapIntervalMs,
    graceMs: config.reapGraceMs,
    log: (m) => console.log(`[driver] ${m}`),
});
if (config.reapIntervalMs > 0) reaper.start();

// Stop claiming, then drain. A second signal is the escape hatch, since a drain waits for a job
// that may have half an hour left on it. A drain that outlasts DRIVER_HANDOVER_MS hands its runs
// over (issue #792): their leases go back as interruptions, claimable at once, and their runners
// stay up for the next claim — rather than the SIGKILL landing with every lease still held.
let stopping = false;
let handedOver = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        if (stopping) {
            console.log('[driver] second signal, exiting now — runners are left to the lease');
            process.exit(1);
        }
        stopping = true;
        console.log('[driver] draining; signal again to exit immediately');
        loop.stop();
        reaper.stop();
        setTimeout(() => {
            handedOver = true;
            void loop.handover('the driver was drained');
        }, config.handoverMs).unref();
    });
}

await loop.start();
// The drain above lets in-flight jobs finish — including their gates, which end with their groups.
await gates.manager.stop();
// The ad-hoc socket holds the event loop open; without this the process never exits after a
// graceful drain once any gated job has run.
await gates.server.close();
// A handed-over run's poll is still pending in this process, and is no longer this driver's.
if (handedOver) process.exit(0);
