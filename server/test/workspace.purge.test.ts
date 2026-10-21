import { execFileSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FactsCache, createFactsCache } from '../src/workspace/facts.js';
import { PURGE_STALE_MS, PURGE_TIMEOUT_MS, removeTree, createPurger } from '../src/workspace/purge.js';
import { memoryUserRepoStore } from './helpers-user-repo-store.js';

/**
 * The purger against real directories, with the removal child itself real on the happy path and
 * faked everywhere a fault must be injected (a hung child, a failing one). The facts cache is the
 * real one — invalidation is part of what a purge owes the next clone.
 */

const ALICE = '00000000-0000-4000-8000-00000000a11c';
const ORG = 'org';
const web = { owner: 'acme', name: 'web' };

let root: string;
let userDir: string;
let checkout: string;

const TOMB = /~purge-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Polls to an absolute deadline: nothing here waits on a bare sleep for a condition. */
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** The tombstones now under the member's directory; the suite shares one root, so tests compare before and after. */
const tombstones = () => readdirSync(userDir).filter((entry) => TOMB.test(entry));

const gate = () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { held, release };
};

const tick = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

// A fresh root per test: the tombstones are listed from the disk, so a neighbour's residue must not be in it.
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-purge-'));
    userDir = join(root, ORG, ALICE);
    checkout = join(userDir, 'web');
});

afterEach(() => {
    execFileSync('rm', ['-rf', '--', root]);
});

async function seedDeselected(store: ReturnType<typeof memoryUserRepoStore>) {
    await store.select(ALICE, [web]);
    await store.select(ALICE, []);
}

function makeCheckout() {
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'file.txt'), 'work\n');
}

/**
 * The real cache with a tripwire on invalidate, so a test can pin the call itself — the failing
 * paths leave the entry in place, and reading it back would race the refresh that repopulates it.
 */
function spyInvalidation(): { facts: FactsCache; invalidated: string[] } {
    const facts = createFactsCache();
    const invalidated: string[] = [];
    return {
        facts: {
            get: (dir, owner) => facts.get(dir, owner),
            sizeOf: (dir, owner) => facts.sizeOf(dir, owner),
            invalidate: (dir) => {
                invalidated.push(dir);
                facts.invalidate(dir);
            },
        },
        invalidated,
    };
}

describe('removeTree', () => {
    it('removes a real directory', async () => {
        makeCheckout();
        await removeTree(checkout);
        expect(existsSync(checkout)).toBe(false);
    });

    it('kills and reaps a child that outlives the timeout, then refuses', async () => {
        makeCheckout();
        const signals: string[] = [];
        // A child that ignores every kill until SIGKILL — the shape the issue calls out: the
        // timeout must terminate AND reap before the failure is reported.
        const fake = ((_command: string, _args: string | readonly string[], _options?: SpawnOptions) => {
            const child = new EventEmitter() as EventEmitter & Pick<ChildProcess, 'kill'> & { pid: number | undefined };
            child.pid = process.pid;
            child.kill = (signal?: NodeJS.Signals) => {
                signals.push(String(signal));
                if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
                return true;
            };
            return child as unknown as ChildProcess;
        }) as unknown as typeof spawn;

        await expect(removeTree(checkout, 10, fake)).rejects.toThrow(/timed out/);
        expect(signals).toEqual(['SIGKILL']);
        // The directory survives — the failure must be honest about what is still on disk.
        expect(existsSync(checkout)).toBe(true);
    });

    it('reports a non-zero exit with the child\u2019s own words', async () => {
        const fake = ((_command: string, _args: string | readonly string[], _options?: SpawnOptions) => {
            const child = new EventEmitter() as EventEmitter &
                Pick<ChildProcess, 'kill'> & { pid: number | undefined } & {
                    stderr: EventEmitter | null;
                };
            child.pid = process.pid;
            child.stderr = new EventEmitter();
            child.kill = () => false;
            queueMicrotask(() => {
                child.stderr?.emit('data', Buffer.from('rm: permission denied'));
                child.emit('exit', 1, null);
            });
            return child as unknown as ChildProcess;
        }) as unknown as typeof spawn;

        await expect(removeTree(join(root, 'nowhere'), 1000, fake)).rejects.toThrow(/permission denied/);
    });

    it('bounds the removal by default', () => {
        // Not a behavior test — a pin, so nobody lowers the bound silently.
        expect(PURGE_TIMEOUT_MS).toBeGreaterThan(30_000);
    });
});

describe('the purger', () => {
    it('stamps, removes a real checkout, then deletes the row and invalidates the facts', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const facts = createFactsCache();
        facts.get(checkout, userDir); // warm the cache with the doomed tree
        const purger = createPurger({ store, root, orgId: ORG, facts });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });

        await purger.settle();
        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        // The predecessor's facts must not survive its tree.
        expect(facts.get(checkout, userDir)).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
    });

    it('cleans a stale row whose directory is already gone, spawning no child', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        let removals = 0;
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                removals += 1;
            },
        });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'cleaned' });
        expect(removals).toBe(0);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('propagates every store refusal untouched', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });

        // A selected row is refused regardless of its clone status.
        await store.select(ALICE, [web]);
        expect(await purger.purge(ALICE, web)).toEqual({ refused: 'selected' });

        // A row still owned by a clone — deselected mid-clone, which is how it became an orphan.
        await store.claimPending(1);
        await store.select(ALICE, []);
        expect(await purger.purge(ALICE, web)).toEqual({ refused: 'cloning' });

        // A duplicate request while a stamp is held.
        const stuck = memoryUserRepoStore();
        await seedDeselected(stuck);
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const stuckPurger = createPurger({
            store: stuck,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: () => gated,
        });
        makeCheckout();
        expect(await stuckPurger.purge(ALICE, web)).toEqual({ result: 'started' });
        expect(await stuckPurger.purge(ALICE, web)).toEqual({ refused: 'purging' });
        release();
        await stuckPurger.settle();

        // Unfinished tasks, with the count.
        const blocked = memoryUserRepoStore({ blockingTasks: () => 3 });
        await seedDeselected(blocked);
        const blockedPurger = createPurger({ store: blocked, root, orgId: ORG, facts: createFactsCache() });
        expect(await blockedPurger.purge(ALICE, web)).toEqual({ refused: 'tasks', count: 3 });

        // A row that is not there.
        expect(await purger.purge(ALICE, { owner: 'acme', name: 'nope' })).toBe('missing');
    });

    it('marks the row failed with the reason and keeps the directory when the removal fails', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                throw new Error('rm: permission denied');
            },
        });

        const before = tombstones();
        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });
        await purger.settle();

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('failed');
        expect(row!.error).toBe('rm: permission denied');
        // The row outlives the partial directory — visible and retryable. The tree sits in its
        // tombstone, out of the member's path; a retry finds dest absent and cleans the row.
        expect(existsSync(checkout)).toBe(false);
        expect(tombstones().filter((entry) => !before.includes(entry))).toHaveLength(1);
    });

    it('leaves no tombstone behind when two removals fail in a row and the third retry succeeds', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        let failures = 2;
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async (dir) => {
                if (failures-- > 0) throw new Error('rm: permission denied');
                execFileSync('rm', ['-rf', '--', dir]);
            },
        });

        await purger.purge(ALICE, web);
        await purger.settle();
        expect(tombstones()).toHaveLength(1);
        // The retry finds the checkout absent and its own removal of the leftover fails too.
        expect(await purger.purge(ALICE, web)).toEqual({ result: 'started' });
        expect((await store.orphaned(ALICE))[0]!.status).toBe('failed');

        // The disk, not the row's memory of the last token, says what is owed.
        expect(await purger.purge(ALICE, web)).toEqual({ result: 'cleaned' });
        expect(tombstones()).toEqual([]);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('invalidates the facts even when the removal fails', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const { facts, invalidated } = spyInvalidation();
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts,
            remove: async () => {
                throw new Error('rm: permission denied');
            },
        });

        await purger.purge(ALICE, web);
        await purger.settle();

        // The row landed on failed, but the tree at this path is already partly gone: the old
        // measurements must not answer for it.
        expect(invalidated).toContain(checkout);
    });

    it('survives failing to RECORD the failure — the detached chain never rejects', async () => {
        // The finisher runs detached after the 202. A database that is down fails the removal
        // recording AND the failure recording; letting either rejection escape the chain would
        // be an unhandled rejection, and Node's default for one of those is to kill the process.
        // The row stays `purging`, which boot recovery finishes.
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const failing: typeof store = {
            ...store,
            deletePurged: async () => {
                throw new Error('database is down');
            },
            markPurgeFailed: async () => {
                throw new Error('database is down');
            },
        };
        const purger = createPurger({
            store: failing,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {},
        });

        expect(await purger.purge(ALICE, web)).toEqual({ result: 'started' });
        // settle() must resolve, and this whole suite must not die of an unhandled rejection.
        await purger.settle();

        expect((await store.orphaned(ALICE))[0]?.status).toBe('purging');
    });

    it('invalidates the facts even when recording the deletion throws', async () => {
        // remove() resolved — the directory is gone — but the row delete failed. A re-select
        // re-clones into the same path and must not inherit the predecessor's measurements.
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const failing: typeof store = {
            ...store,
            deletePurged: async () => {
                throw new Error('database is down');
            },
        };
        const { facts, invalidated } = spyInvalidation();
        const purger = createPurger({ store: failing, root, orgId: ORG, facts, remove: async () => {} });

        await purger.purge(ALICE, web);
        await purger.settle();

        expect(invalidated).toContain(checkout);
    });

    it('holds the stamp until the removal child is observed to exit', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: () => gated,
        });

        const before = tombstones();
        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });
        await tick();

        // Deletion still running: the row is stamped, not deleted, and the tree is still on disk, in
        // its tombstone.
        expect((await store.orphaned(ALICE))[0]?.status).toBe('purging');
        expect(tombstones().filter((entry) => !before.includes(entry))).toHaveLength(1);

        release();
        await purger.settle();
        // The row is deleted only once the (seamed) removal resolved — the real-directory case
        // is the test above; this one pins the ORDER, not the unlink.
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('finishes an interrupted purge at recovery: residue removed, row deleted', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web); // a crash left the stamp held
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.recoverInterrupted();

        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('finishes an interrupted purge whose directory is already gone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        await store.stampPurge(ALICE, web);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.recoverInterrupted();

        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('marks recovery failures failed with the reason', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const lost = (await store.stampPurge(ALICE, web)) as { token: string };
        renameSync(checkout, `${checkout}~purge-${lost.token}`);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                throw new Error('rm: device busy');
            },
        });

        await purger.recoverInterrupted();

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('failed');
        expect(row!.error).toBe('rm: device busy');
    });

    it('invalidates the facts when a recovery removal fails', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        const { facts, invalidated } = spyInvalidation();
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts,
            remove: async () => {
                throw new Error('rm: device busy');
            },
        });

        await purger.recoverInterrupted();

        expect(invalidated).toContain(checkout);
    });

    it('never plans to touch the sibling .worktrees directory', async () => {
        // The driver's worktrees live beside the checkouts; a purge removes one checkout only.
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        mkdirSync(join(userDir, '.worktrees', 'some-job'), { recursive: true });
        writeFileSync(join(userDir, '.worktrees', 'some-job', 't.txt'), 'driver\n');

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.purge(ALICE, web);
        await purger.settle();

        expect(existsSync(join(userDir, '.worktrees', 'some-job', 't.txt'))).toBe(true);
    });
});

describe('the purger across processes', () => {
    const recording = () => {
        const removed: string[] = [];
        return { removed, remove: async (dir: string) => void removed.push(dir) };
    };

    it('a live purge removes only its tombstone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const { removed, remove } = recording();
        const { facts, invalidated } = spyInvalidation();
        const purger = createPurger({ store, root, orgId: ORG, facts, remove });

        expect(await purger.purge(ALICE, web)).toEqual({ result: 'started' });
        await purger.settle();

        expect(removed).toHaveLength(1);
        expect(removed[0]).toMatch(TOMB);
        expect(removed[0]?.startsWith(`${checkout}~purge-`)).toBe(true);
        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        expect(invalidated).toContain(checkout);
        expect(invalidated.every((dir) => !TOMB.test(dir))).toBe(true);
    });

    it('boot recovery leaves a fresh stamp alone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web);
        const { removed, remove } = recording();

        await createPurger({ store, root, orgId: ORG, facts: createFactsCache(), remove }).recoverInterrupted();

        expect(removed).toEqual([]);
        expect((await store.orphaned(ALICE))[0]?.status).toBe('purging');
        expect(existsSync(checkout)).toBe(true);
    });

    it("recovery finishes a stale stamp and a lost holder's tombstone found on the disk", async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const lost = `${checkout}~purge-${((await store.stampPurge(ALICE, web)) as { token: string }).token}`;
        renameSync(checkout, lost); // the holder moved the tree, then died
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        const { removed, remove } = recording();

        await createPurger({ store, root, orgId: ORG, facts: createFactsCache(), remove }).recoverInterrupted();

        expect(removed).toContain(lost);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('a recoverer lost right after claiming leaves the next one the original tombstone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const original = `${checkout}~purge-${((await store.stampPurge(ALICE, web)) as { token: string }).token}`;
        renameSync(checkout, original);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        expect(await store.claimStalePurges(PURGE_STALE_MS)).toHaveLength(1); // restamped, then the recoverer died
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);

        await createPurger({ store, root, orgId: ORG, facts: createFactsCache() }).recoverInterrupted();

        expect(tombstones()).toEqual([]);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it.each([
        [
            'the tombstone listing',
            {
                list: () => {
                    throw Object.assign(new Error('EIO'), { code: 'EIO' });
                },
            },
            {},
        ],
        [
            'the held-token read',
            {},
            {
                heldTokens: async () => {
                    throw new Error('connection reset');
                },
            },
        ],
    ])('keeps the row when %s is unconfirmed, in a purge and in a recovery', async (_what, deps, storeFault) => {
        const store = Object.assign(memoryUserRepoStore(), storeFault);
        await seedDeselected(store);
        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache(), ...deps });

        expect(await purger.purge(ALICE, web)).not.toEqual({ result: 'cleaned' });
        await purger.settle();
        expect(await store.orphaned(ALICE)).toHaveLength(1);

        await store.stampPurge(ALICE, web);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        await purger.recoverInterrupted();
        expect(await store.orphaned(ALICE)).toHaveLength(1);
    });

    it('two recoverers with a reselection between completions never touch the fresh clone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        const slow = gate();
        const first = recording();
        const second = recording();
        const r1 = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async (dir) => {
                first.removed.push(dir);
                await slow.held;
            },
        });
        const r2 = createPurger({ store, root, orgId: ORG, facts: createFactsCache(), remove: second.remove });

        const running = r1.recoverInterrupted();
        await until(() => first.removed.length === 1, 'the first recoverer to start removing');
        await r2.recoverInterrupted();
        expect(second.removed).toEqual([]);

        slow.release();
        await running;
        await store.select(ALICE, [web]);
        mkdirSync(join(checkout, '.git'), { recursive: true });
        await r2.recoverInterrupted();

        expect(second.removed).toEqual([]);
        expect(existsSync(join(checkout, '.git'))).toBe(true);
        expect((await store.list(ALICE))[0]?.status).toBe('queued');
    });

    it('a purger lost mid-removal never deletes a fresh clone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const hang = gate();
        const lines: string[] = [];
        let p1Dir: string | undefined;
        const p1 = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            log: (m) => lines.push(m),
            remove: async (dir) => {
                p1Dir = dir;
                await hang.held;
                // The paused child finally runs, on exactly what it was handed.
                rmSync(dir, { recursive: true, force: true });
            },
        });
        const p2 = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: (dir) => removeTree(dir),
        });

        await p1.purge(ALICE, web);
        await until(() => p1Dir !== undefined, 'the first purger to start removing');
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        await p2.recoverInterrupted();
        expect(await store.orphaned(ALICE)).toHaveLength(0);

        await store.select(ALICE, [web]);
        mkdirSync(join(checkout, '.git'), { recursive: true });
        writeFileSync(join(checkout, 'fresh.txt'), 'new work\n');

        hang.release();
        await p1.settle();

        expect(existsSync(join(checkout, 'fresh.txt'))).toBe(true);
        expect(existsSync(join(checkout, '.git'))).toBe(true);
        expect((await store.list(ALICE))[0]?.status).toBe('queued');
        expect(lines.some((line) => /moved behind/.test(line))).toBe(true);
    });

    it('a purge whose claim is taken before the move never moves the tree', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const lines: string[] = [];
        const { facts, invalidated } = spyInvalidation();
        const racing: typeof store = {
            ...store,
            holdPurge: async (userId, repo, token, move) => {
                store.backdatePurge(userId, repo, PURGE_STALE_MS + 1);
                await store.claimStalePurges(PURGE_STALE_MS);
                return store.holdPurge(userId, repo, token, move);
            },
        };
        const { removed, remove } = recording();
        const purger = createPurger({ store: racing, root, orgId: ORG, facts, remove, log: (m) => lines.push(m) });

        expect(await purger.purge(ALICE, web)).toEqual({ result: 'started' });
        await purger.settle();

        expect(existsSync(join(checkout, 'file.txt'))).toBe(true);
        expect(removed).toEqual([]);
        expect(lines.some((line) => /claim/.test(line))).toBe(true);
        expect(invalidated).toContain(checkout);
    });

    it('a move that fails with a non-absence error records a failure and keeps the checkout', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const { facts, invalidated } = spyInvalidation();
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts,
            rename: () => {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
        });

        await purger.purge(ALICE, web);
        await purger.settle();

        const [row] = await store.orphaned(ALICE);
        expect(row?.status).toBe('failed');
        expect(row?.error).toMatch(/EACCES/);
        expect(existsSync(join(checkout, 'file.txt'))).toBe(true);
        expect(invalidated).toContain(checkout);
    });

    it('a stale stamp is recovered without a restart', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web);
        store.backdatePurge(ALICE, web, PURGE_STALE_MS + 1);
        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });

        purger.start(20);
        try {
            await until(async () => (await store.orphaned(ALICE)).length === 0, 'the stale stamp to be recovered');
        } finally {
            purger.stop();
        }
        expect(existsSync(checkout)).toBe(false);
    });
});
