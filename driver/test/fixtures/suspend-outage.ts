/**
 * A real driver process through a board outage on suspend (issue #820), run by
 * `loop-containment.test.ts` as its own Node child: job 1 is stopped in setup and every suspend of
 * it fails, job 2 runs to its verdict. The process must outlive the loop with no unhandled
 * rejection — Node exits 1 on one — and say what it saw on stdout.
 */
import type { Board, BoardJob } from '../../src/board/board.js';
import { BoardHttpError } from '../../src/board/board-retry.js';
import { loadDriverConfig } from '../../src/config.js';
import { createLoop } from '../../src/loop/loop.js';
import type { Runner } from '../../src/runner.js';
import { boardJob } from './board-job.js';

const USER = '44444444-4444-4444-8444-444444444444';
/** A valid Factory execution context: only its presence matters here. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';
const job = (n: number): BoardJob => ({
    ...boardJob(),
    id: `0000000${n}-1111-4111-8111-111111111111`,
    leaseToken: `0000000${n}-2222-4222-8222-222222222222`,
    userId: USER,
    workspacePath: `org/${USER}`,
    masterPrompt: MASTER_PROMPT,
});
const stopped = job(1);
const queue = [stopped, job(2)];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

let stop = () => {};
const calls: Partial<Board> = {
    async claim() {
        const next = queue.shift() ?? null;
        if (!next) stop();
        return next;
    },
    async heartbeat(claimed) {
        return { result: 'held', cancelRequested: claimed.id === stopped.id };
    },
    async suspend(claimed) {
        throw new BoardHttpError(503, `/api/jobs/${claimed.id}/suspend answered 503: down`);
    },
    async complete(claimed) {
        console.log(`completed ${claimed.id}`);
        return { state: 'held', reclaimId: null };
    },
    async claimReclaim() {
        return null;
    },
};
// Every other board call answers nothing: this process exercises the stop and the verdict only.
const board = new Proxy(calls, {
    get: (target, key: string) => target[key as keyof Board] ?? (async () => null),
}) as Board;

const runner = {
    async run(claimed: BoardJob) {
        if (claimed.id === stopped.id) throw new Error('the stopped job must not spawn');
        return { exitCode: 0, output: 'done', timedOut: false, started: true };
    },
    async syncCheckout() {
        return { ok: true, reason: null };
    },
    async kill() {},
    async sampleRuntime() {
        return null;
    },
    async agentStarted() {
        return false;
    },
    async deadServices() {
        return [];
    },
    async releaseServices() {},
    async restartServices() {},
    async startServices() {
        return null;
    },
    async stopAgent() {},
    async recordKill() {},
    async pauseDeadline() {},
    async publishGit() {
        const nothing = { branch: null, prUrl: null, reason: null, cause: null, repository: null, baseBranch: null };
        return { ok: true, published: false, prNumber: null, ...nothing };
    },
    async probeTree() {
        return null;
    },
    async probeGateTree() {
        return { fingerprint: null, content: null, mutatedSince: null };
    },
    async adopt() {
        return null;
    },
    async snapshotTree() {
        return { ok: false, reason: 'this process snapshots nothing' };
    },
    async finish() {},
    async reclaimWorktree() {
        return { ok: true, removed: true, reason: null };
    },
    async runHelper() {
        throw new Error('this process runs no helper');
    },
} as unknown as Runner;

const loop = createLoop({
    board,
    runner,
    config: loadDriverConfig({ DRIVER_CONCURRENCY: '2' }),
    sleep: tick,
    log: (line) => console.log(line),
});
stop = () => loop.stop();
await loop.start();
// Long enough for every suspend retry, and for a rejection the loop let go of to surface.
for (let i = 0; i < 200; i++) await tick();
console.log('alive');
