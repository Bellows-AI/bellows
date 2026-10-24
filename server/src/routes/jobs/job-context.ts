import type { FastifyRequest } from 'fastify';
import { orgOf } from '../../auth/plugin.js';
import type { ClaimOptions, JobAdmissionStore } from '../../db/jobs/job-store-admission.js';
import type { JobStore } from '../../db/jobs/job-store-types.js';
import type { OrgRegistry } from '../../orgs.js';

/**
 * The job board a request lands on is its caller's org's (#99): the session, the personal
 * token or the worker secret's resolved org each names one, and the runtime resolved from
 * it carries that org's store. Absent in the route-test mode with no stores behind the
 * registry.
 */
export async function storeFor<K extends keyof JobStore = keyof JobStore>(
    orgs: OrgRegistry,
    request: FastifyRequest
): Promise<Pick<JobStore, K> | null> {
    const rt = await orgs.for(orgOf(request));
    return rt?.jobs ?? null;
}

/** The caller's org's tracked repository list, absent when the org has no runtime. */
export async function reposFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.repos ?? null;
}

/** The artifact index the caller's org writes through (070), absent when no object store was configured. */
export async function artifactsFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.artifacts ?? null;
}

/** The telemetry client the caller's org reads through (#99), mirroring `storeFor`. */
export async function telemetryFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.telemetry ?? null;
}

/**
 * The boards a WORKER call may reach. The shared secret authenticates the driver, not an
 * org, so a claim names no row and no org: it is offered EVERY org's queue, first claim
 * wins and the empty orgs cost one idle poll each. Every other worker route arrives with
 * the org the auth hook read from the row its URL names, and is a one-element list.
 */
export async function boardsFor<K extends keyof JobStore = keyof JobStore>(
    orgs: OrgRegistry,
    request: FastifyRequest
): Promise<Pick<JobStore, K>[]> {
    if (request.auth?.kind === 'worker' && request.auth.orgId === null) {
        // Resolved in parallel — the lookups are independent, and this runs on every driver poll.
        // Warm runtimes are cached promises and cost nothing; a cold start would otherwise
        // serialise every org's build behind the first. The registry's order is preserved, which
        // is what `boardScan`'s rotation counts positions against.
        const runtimes = await Promise.all((await orgs.list()).map((org) => orgs.for(org.id)));
        return runtimes.flatMap((rt) => (rt?.jobs ? [rt.jobs] : []));
    }
    const store = await storeFor(orgs, request);
    return store ? [store] : [];
}

/** The workflow definitions the create may resolve against — the caller's org's (#99). */
export async function workflowsFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.workflows ?? null;
}

/** The caller's configured executor rows — read at launch for the suspended-profile refusal. */
export async function executorsFor(orgs: OrgRegistry, request: FastifyRequest) {
    const rt = await orgs.for(orgOf(request));
    return rt?.userExecutors ?? null;
}

export type BoardScanner = <Board, T>(
    boards: readonly Board[],
    log: (e: Error) => void,
    claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
) => Promise<T | null>;

/** The fair scan orders boards by their `demand()`, so its boards must carry it. */
export type FairBoardScanner = <Board extends JobAdmissionStore, T>(
    boards: readonly Board[],
    log: (e: Error) => void,
    claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
) => Promise<T | null>;

async function scanBoards<Board, T>(
    boards: readonly Board[],
    order: readonly number[],
    log: (e: Error) => void,
    claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
): Promise<T | null> {
    let failed: Error | null = null;
    for (const index of order) {
        const board = boards[index]!;
        try {
            const claimed = await claimOf(board, {});
            if (claimed !== null) return claimed;
        } catch (e) {
            failed = e as Error;
            log(failed);
        }
    }
    if (failed) throw failed;
    return null;
}

/**
 * The scan a worker poll walks across the org boards. The registry lists organizations in
 * a stable order, so the starting board rotates one position per poll — a fixed first
 * board would let one busy org fill every driver slot while later orgs starve. The job
 * and the reclaim scans each carry their OWN counter: the driver polls both queues
 * concurrently, and one shared counter would let every interleaved poll advance the
 * other's phase — with two orgs and one reclaim poll per job poll, every job claim would
 * start at the same org and starve the other. A board that throws costs itself the poll,
 * not the others: claim preparation can fail for one org alone (an installation-token
 * mint), and one unhealthy org must not block the rest. Every board failing is still a
 * broken board, not an idle one: the last error is rethrown, so the guard's 503 — the
 * driver's log-and-repoll signal — survives.
 */
export function boardScan(): BoardScanner {
    let turn = 0;
    return async <Board, T>(
        boards: readonly Board[],
        log: (e: Error) => void,
        claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
    ): Promise<T | null> => {
        const start = turn++ % boards.length;
        const order = Array.from({ length: boards.length }, (_, i) => (start + i) % boards.length);
        return scanBoards(boards, order, log, claimOf);
    };
}

/**
 * The fair scan's walk. Once any board of the poll was refused by the global budget — reported by the claim
 * itself, also when it then threw — every later board is claimed takeover-only whatever its demand read said:
 * the order came from demand read at the start, and a slot freed meanwhile would go to whichever board the scan
 * reaches next instead of the org the order put first. A takeover keeps the slot its row holds, so recovery is
 * still offered everywhere.
 */
async function scanUnderBudget<Board, T>(
    boards: readonly Board[],
    order: readonly number[],
    log: (e: Error) => void,
    claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
): Promise<T | null> {
    let failed: Error | null = null;
    let full = false;
    for (const index of order) {
        const board = boards[index]!;
        const refusal = { global: false };
        try {
            const claimed = await claimOf(board, { takeoverOnly: full, refusal });
            if (claimed !== null) return claimed;
        } catch (e) {
            failed = e as Error;
            log(failed);
        }
        if (refusal.global) full = true;
    }
    if (failed) throw failed;
    return null;
}

/**
 * The job claim's scan (issue #831): the boards in the order their rows give, so every board
 * replica and every driver sees the same priority instead of each replica's own rotation. An org
 * whose lost attempt waits for its takeover comes first — recovery needs no budget slot, and a
 * takeover window is bounded — then the org with the fewest running rows, then the one whose
 * oldest waiting row queued first. Only an exact tie falls back to the rotation. A board whose
 * demand read fails goes last, still scanned, so one unhealthy org never blocks the others.
 */
export function fairBoardScan(): FairBoardScanner {
    let turn = 0;
    return async <Board extends JobAdmissionStore, T>(
        boards: readonly Board[],
        log: (e: Error) => void,
        claimOf: (board: Board, options: ClaimOptions) => Promise<T | null>
    ): Promise<T | null> => {
        const start = turn++ % boards.length;
        const demands = await Promise.all(
            boards.map((board) =>
                // Through a promise, so a demand read that throws before it returns one is caught too.
                Promise.resolve()
                    .then(() => board.demand())
                    .catch((e: unknown) => {
                        log(e as Error);
                        return null;
                    })
            )
        );
        const rank = (index: number) => {
            const demand = demands[index];
            if (!demand) return [2, 0, Number.POSITIVE_INFINITY];
            const waited = demand.oldestWaiting?.getTime() ?? Number.POSITIVE_INFINITY;
            return [demand.takeover ? 0 : 1, demand.running, waited];
        };
        const rotation = (index: number) => (index - start + boards.length) % boards.length;
        const order = boards
            .map((_, index) => index)
            .sort((a, b) => {
                const [ra, rb] = [rank(a), rank(b)];
                for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
                return rotation(a) - rotation(b);
            });
        return scanUnderBudget(boards, order, log, claimOf);
    };
}
