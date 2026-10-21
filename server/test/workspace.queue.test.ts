import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserRepoStore } from '../src/db/user-repo-store.js';
import { createCloneQueue, sweepStaging } from '../src/workspace/queue.js';
import { memoryUserRepoStore, type MemoryUserRepoStore } from './helpers.js';

/**
 * Offline: git never runs. The `run` seam that lets workspace.reconcile.test.ts assert on argv is
 * the same one that lets this suite drive the whole queue without a network or a filesystem clone.
 */

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let root: string;
let store: MemoryUserRepoStore;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-queue-'));
    store = memoryUserRepoStore();
});

/** A queue whose `run` records what it was asked to clone and creates the staging directory. */
function queueWith(
    options: {
        fail?: (name: string) => boolean;
        hold?: (name: string) => Promise<void> | null;
        store?: UserRepoStore;
        heartbeatMs?: number;
        /** Written into the staging tree, so a test can tell whose clone ended up published. */
        marker?: string;
        log?: (message: string) => void;
    } = {}
) {
    const cloned: string[] = [];
    const dests: string[] = [];
    const idle: (() => void)[] = [];
    const queue = createCloneQueue({
        store: options.store ?? store,
        root,
        orgId: 'acme',
        ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
        ...(options.log ? { log: options.log } : {}),
        cloneUrl: (repo) => `file:///origins/${repo.name}.git`,
        run: async (args) => {
            const dest = args[args.length - 1] as string;
            dests.push(dest);
            const name = dest
                .replace(/~tmp-[0-9a-f-]+$/, '')
                .split('/')
                .pop() as string;
            cloned.push(name);
            // Stands in for a clone that takes minutes, without taking minutes.
            const wait = options.hold?.(name);
            if (wait) await wait;
            if (options.fail?.(name)) throw new Error(`fatal: repository not found\nsecond line`);
            mkdirSync(dest, { recursive: true });
            mkdirSync(join(dest, '.git'), { recursive: true });
            if (options.marker) writeFileSync(join(dest, 'marker'), options.marker);
        },
        onIdle: () =>
            idle.splice(0).forEach((resolve) => {
                resolve();
            }),
    });
    /** Resolves after the next pass finishes, so nothing here waits on a real timer. */
    const settled = () => new Promise<void>((resolve) => idle.push(resolve));
    return { queue, cloned, dests, settled };
}

describe('the clone queue', () => {
    it('clones what a member selected, and marks each ready', async () => {
        await store.select(USER, [
            { owner: 'acme', name: 'web' },
            { owner: 'acme', name: 'api' },
        ]);
        const { queue, cloned, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(cloned.sort()).toEqual(['api', 'web']);
        expect(store.rows().every((row) => row.status === 'ready')).toBe(true);
        expect(readdirSync(join(root, 'acme', USER)).sort()).toEqual(['api', 'web']);
    });

    it('keeps two members apart', async () => {
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        await store.select(OTHER, [{ owner: 'acme', name: 'web' }]);
        const { queue, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(existsSync(join(root, 'acme', USER, 'web', '.git'))).toBe(true);
        expect(existsSync(join(root, 'acme', OTHER, 'web', '.git'))).toBe(true);
    });

    it('records a failure against the row rather than stopping everyone else', async () => {
        // One member's broken repository must not stall the queue, and the page shows this sentence
        // — which is why cloneRepo throws now where the boot-time reconcile counted a failure.
        await store.select(USER, [
            { owner: 'acme', name: 'web' },
            { owner: 'acme', name: 'broken' },
        ]);
        const { queue, settled } = queueWith({ fail: (name) => name === 'broken' });

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        const rows = Object.fromEntries(store.rows().map((row) => [row.name, row.status]));
        expect(rows).toEqual({ web: 'ready', broken: 'failed' });
    });

    it('refills a freed slot without waiting for the slowest clone', async () => {
        /*
         * The pass STARTS its clones and returns; it does not await them as a batch. Awaiting the
         * batch made concurrency effectively one — a pass could not finish until its slowest clone
         * did, and passes are serialised, so a single fifteen-minute monorepo clone idled the other
         * slot and held every other member's repository behind it.
         */
        await store.select(USER, [
            { owner: 'acme', name: 'aslow' },
            { owner: 'acme', name: 'b' },
            { owner: 'acme', name: 'c' },
            { owner: 'acme', name: 'd' },
        ]);

        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { queue, cloned, settled } = queueWith({ hold: (name) => (name === 'aslow' ? held : null) });

        queue.kick();
        // Long enough for several passes to come and go while `aslow` is still running.
        const QUEUE_DRAIN_DELAY_MS = 100;
        await new Promise((r) => setTimeout(r, QUEUE_DRAIN_DELAY_MS));
        expect(cloned.filter((name) => name !== 'aslow').sort()).toEqual(['b', 'c', 'd']);

        const done = settled();
        release();
        await done;
        queue.stop();
        expect(store.rows().every((row) => row.status === 'ready')).toBe(true);
    });

    it('takes at most `concurrency` rows per pass', async () => {
        // A clone is minutes of network and unbounded disk, and a burst against one origin is the
        // shape of a request nobody thanks you for.
        await store.select(USER, [
            { owner: 'acme', name: 'a' },
            { owner: 'acme', name: 'b' },
            { owner: 'acme', name: 'c' },
        ]);
        expect(await store.claimPending(2)).toHaveLength(2);
        expect(await store.claimPending(2)).toHaveLength(1);
    });

    it('returns rows a restart stranded mid-clone, so nothing is lost forever', async () => {
        /*
         * A `cloning` row is owned by a process that no longer exists, and the claim only ever
         * takes `queued` — so without this the row stays `cloning` for good while nothing is
         * cloning it, and the page shows a spinner that never resolves.
         */
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        store.strand(USER, { owner: 'acme', name: 'web' });

        const { queue, cloned, settled } = queueWith();
        const done = settled();
        await queue.start();
        await done;
        queue.stop();

        expect(cloned).toEqual(['web']);
        expect(store.rows()[0]?.status).toBe('ready');
    });

    it('does not re-clone a repo that is already ready', async () => {
        // Re-selecting something already on disk must not throw away a checkout that may hold an
        // agent's uncommitted work.
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        store.seedReady(USER, { owner: 'acme', name: 'web' });
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);

        const { queue, cloned, settled } = queueWith();
        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(cloned).toEqual([]);
    });
});

/** Polls to an absolute deadline: nothing here waits on a bare sleep for a condition. */
async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

const gate = () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { held, release };
};

const web = { owner: 'acme', name: 'web' };
const userDir = () => join(root, 'acme', USER);

describe('the clone queue across processes', () => {
    it("start() leaves another process's live clone alone", async () => {
        await store.select(USER, [web]);
        store.holdLive(USER, web, randomUUID());
        const { queue, cloned, settled } = queueWith();

        const done = settled();
        await queue.start();
        await done;
        queue.stop();

        expect(cloned).toEqual([]);
        expect(store.rows()[0]?.status).toBe('cloning');
    });

    it('a pass recovers a vanished holder without a restart and removes its staging', async () => {
        await store.select(USER, [web]);
        store.strand(USER, web);
        const stale = store.rows()[0]?.claimToken as string;
        const staging = join(userDir(), `web~tmp-${stale}`);
        mkdirSync(join(staging, '.git'), { recursive: true });
        const { queue, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(store.rows()[0]?.status).toBe('ready');
        expect(existsSync(staging)).toBe(false);
    });

    it('reselecting a repo mid-clone starts no second clone', async () => {
        await store.select(USER, [web]);
        const { held, release } = gate();
        const { queue, cloned, settled } = queueWith({ hold: () => held });

        queue.kick();
        await until(() => cloned.length === 1, 'the first clone to start');
        await store.select(USER, [web]);
        queue.kick();
        await new Promise((r) => setTimeout(r, 50));
        expect(cloned).toEqual(['web']);

        const done = settled();
        release();
        await done;
        queue.stop();
        expect(cloned).toEqual(['web']);
        expect(store.rows()[0]?.status).toBe('ready');
    });

    it('an expired holder finishing after its replacement publishes nothing', async () => {
        await store.select(USER, [web]);
        const slow = gate();
        const first = queueWith({ hold: () => slow.held, marker: 'first' });
        const second = queueWith({ marker: 'second' });

        first.queue.kick();
        await until(() => first.cloned.length === 1, 'the first holder to start cloning');
        store.expire(USER, web);
        const done = second.settled();
        second.queue.kick();
        await done;
        expect(store.rows()[0]?.status).toBe('ready');

        const lateDone = first.settled();
        first.queue.stop();
        slow.release();
        await lateDone;

        expect(existsSync(first.dests[0] as string)).toBe(false);
        expect(readdirSync(join(userDir(), 'web')).sort()).toEqual(['.git', 'marker']);
        expect(existsSync(join(userDir(), 'web', 'marker'))).toBe(true);
        expect(store.rows()[0]?.status).toBe('ready');
        second.queue.stop();
    });

    it('staging is named by the claim token', async () => {
        await store.select(USER, [web]);
        const { queue, dests, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        const token = store.rows()[0]?.claimToken;
        // A published row has no token left; the staging name carried the one it was claimed under.
        expect(token).toBeNull();
        expect(dests[0]).toMatch(/web~tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(dests[0]).not.toContain(`~tmp-${process.pid}`);
    });

    it('a lost lease is not recorded as the outcome', async () => {
        await store.select(USER, [web]);
        const { held, release } = gate();
        const renewed: string[][] = [];
        const lines: string[] = [];
        const watching: UserRepoStore = {
            ...store,
            renewLeases: async (tokens) => {
                renewed.push([...tokens]);
                return [];
            },
        };
        const { queue, cloned, dests, settled } = queueWith({
            store: watching,
            hold: () => held,
            heartbeatMs: 10,
            log: (m) => lines.push(m),
        });

        queue.kick();
        await until(() => cloned.length === 1, 'the clone to start');
        await until(() => renewed.length > 0, 'a heartbeat');
        store.expire(USER, web);
        await store.requeueExpired();
        queue.stop();
        const done = settled();
        release();
        await done;

        expect(lines.some((line) => /lease lost/.test(line))).toBe(true);
        expect(store.rows()[0]?.status).toBe('queued');
        expect(existsSync(join(userDir(), 'web'))).toBe(false);
        expect(existsSync(dests[0] as string)).toBe(false);
    });

    it('stop() stops the heartbeat', async () => {
        await store.select(USER, [web]);
        const { held, release } = gate();
        let calls = 0;
        const watching: UserRepoStore = {
            ...store,
            renewLeases: async (tokens, leaseMs) => {
                calls += 1;
                return store.renewLeases(tokens, leaseMs);
            },
        };
        const { queue, cloned } = queueWith({ store: watching, hold: () => held, heartbeatMs: 10 });

        queue.kick();
        await until(() => cloned.length === 1 && calls > 0, 'a heartbeat during the clone');
        queue.stop();
        const atStop = calls;
        await new Promise((r) => setTimeout(r, 80));
        expect(calls).toBe(atStop);
        release();
    });
});

describe('the staging sweep', () => {
    const noTokens = { heldTokens: async () => [] as string[] };
    const sweep = (tokens: Pick<UserRepoStore, 'heldTokens'> = noTokens) =>
        sweepStaging(root, 'acme', tokens, () => {});

    it('removes partial trees a killed clone left behind', async () => {
        // The rename into place is atomic, so a `~tmp-<token>` directory is never a finished clone and is
        // never anything anybody wants. Without the sweep each one leaks a checkout's worth of disk.
        mkdirSync(join(root, 'acme', USER, `web~tmp-${randomUUID()}`), { recursive: true });
        mkdirSync(join(root, 'acme', USER, 'api', '.git'), { recursive: true });

        expect(await sweep()).toBe(1);
        expect(readdirSync(join(root, 'acme', USER))).toEqual(['api']);
    });

    it('never sweeps a checkout whose legal repo name looks like staging', async () => {
        // GitHub names allow [A-Za-z0-9._-], so `web.tmp-<uuid>`, `web.purge-<uuid>` and `api.tmp-1234`
        // can all be selected repos. The sweep markers use `~`, which no repo name can contain.
        const names = [`web.tmp-${randomUUID()}`, `web.purge-${randomUUID()}`, 'api.tmp-1234'];
        for (const name of names) mkdirSync(join(userDir(), name, '.git'), { recursive: true });

        expect(await sweep()).toBe(0);
        expect(readdirSync(userDir()).sort()).toEqual([...names].sort());
    });

    it('keeps held staging and tombstones, removes orphans', async () => {
        const [heldClone, heldPurge, orphanClone, orphanPurge] = [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
        ];
        const names = [`a~tmp-${heldClone}`, `a~purge-${heldPurge}`, `b~tmp-${orphanClone}`, `b~purge-${orphanPurge}`];
        for (const name of [...names, 'real']) mkdirSync(join(userDir(), name), { recursive: true });

        expect(await sweep({ heldTokens: async () => [heldClone, heldPurge] })).toBe(2);

        expect(readdirSync(userDir()).sort()).toEqual([`a~purge-${heldPurge}`, `a~tmp-${heldClone}`, 'real']);
    });

    it('never sweeps a dir created after the listing', async () => {
        mkdirSync(join(userDir(), 'seed'), { recursive: true });
        const late = `x~tmp-${randomUUID()}`;
        const early = `y~tmp-${randomUUID()}`;
        mkdirSync(join(userDir(), early));

        await sweep({
            heldTokens: async () => {
                mkdirSync(join(userDir(), late));
                return [];
            },
        });

        expect(existsSync(join(userDir(), late))).toBe(true);
        expect(existsSync(join(userDir(), early))).toBe(false);
    });

    it('sweeps nothing when the held tokens cannot be confirmed', async () => {
        const orphan = join(userDir(), `x~tmp-${randomUUID()}`);
        mkdirSync(orphan, { recursive: true });
        const failing = { heldTokens: async (): Promise<string[]> => Promise.reject(new Error('db down')) };

        await expect(sweep(failing)).resolves.toBe(0);
        expect(existsSync(orphan)).toBe(true);

        // And start() carries on to its loop regardless.
        await store.select(USER, [web]);
        const { queue, cloned, settled } = queueWith({ store: { ...store, heldTokens: failing.heldTokens } });
        const done = settled();
        await queue.start();
        await done;
        queue.stop();
        expect(cloned).toEqual(['web']);
        expect(existsSync(orphan)).toBe(true);
    });

    it.skipIf(process.getuid?.() === 0)('skips an unreadable member dir, neither sweeping nor throwing', async () => {
        const open = join(root, 'acme', OTHER);
        const locked = userDir();
        const orphan = join(open, `x~tmp-${randomUUID()}`);
        mkdirSync(orphan, { recursive: true });
        mkdirSync(join(locked, `y~tmp-${randomUUID()}`), { recursive: true });
        chmodSync(locked, 0o000);
        try {
            expect(await sweep()).toBe(1);
        } finally {
            chmodSync(locked, 0o755);
        }
        expect(existsSync(orphan)).toBe(false);
        expect(readdirSync(locked)).toHaveLength(1);
    });

    it('is a no-op when nothing has been provisioned yet', async () => {
        expect(await sweepStaging(join(root, 'nope'), 'acme', noTokens, () => {})).toBe(0);
    });

    it('reads a file where the org dir should be as nothing to sweep', async () => {
        writeFileSync(join(root, 'acme'), 'not a directory');
        expect(await sweep()).toBe(0);
    });
});
