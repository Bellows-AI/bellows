import type { Sql } from 'postgres';
import type { AppConfig } from '../config.js';
import { installationTokenProvider, type InstallationTokenProvider } from '../github/app-token.js';
import { startIntervalLoop } from '../interval-loop.js';
import { createMembershipReader, type MembershipReader, type MembershipVerdict } from './membership.js';
import { createMembershipStore, type MembershipStore } from './membership-store.js';
import type { AuthStore, Caller } from './store.js';

const MS_PER_MINUTE = 60_000;
/**
 * How long GitHub's last answer about a membership stands. A session or personal token used past it asks
 * again before the request proceeds, and the interval pass asks for the idle ones, so a member removed on
 * GitHub is refused at most this long (plus one pass, for an unused credential) after the removal.
 */
export const MEMBERSHIP_TTL_MS = 10 * MS_PER_MINUTE;
const MEMBERSHIP_PASS_INTERVAL_MS = MEMBERSHIP_TTL_MS / 2;
/** Memberships one pass re-checks; the next pass takes the rest, oldest check first. */
const PASS_BATCH = 200;

export interface MembershipGuard {
    /** The auth store with sign-in verdicts and the token-path re-check in front of it. */
    store: AuthStore;
    /** One re-check of every due membership (up to the batch); never throws on a GitHub failure. */
    pass(signal?: AbortSignal): Promise<void>;
}

/**
 * Puts GitHub's membership answer in front of the auth store (docs/auth.md): sign-in reads a verdict per
 * installation (`SignInCheck`), and the session and personal-token reads re-check a membership whose last
 * check is older than the TTL, refusing the credential only on a confirmed "not a member" — which has
 * already revoked it. A stale check alone, or an unanswered read, never refuses.
 */
export function createMembershipGuard({
    store,
    membership,
    reader,
    ttlMs = MEMBERSHIP_TTL_MS,
    now = Date.now,
}: {
    store: AuthStore;
    membership: MembershipStore;
    reader: MembershipReader;
    ttlMs?: number;
    now?: () => number;
}): MembershipGuard {
    // One read per membership at a time: a dashboard's parallel polls past the TTL share it.
    const inFlight = new Map<string, Promise<MembershipVerdict>>();
    const recheck = (orgId: string, userId: string, signal?: AbortSignal): Promise<MembershipVerdict> => {
        const key = `${orgId}:${userId}`;
        const running = inFlight.get(key);
        if (running) return running;
        const read = (async (): Promise<MembershipVerdict> => {
            const target = await membership.target(orgId, userId);
            if (!target) return { kind: 'unknown', reason: 'membership gone' };
            const verdict = await reader.read(target, signal);
            await membership.record(orgId, userId, verdict, new Date(now()));
            return verdict;
        })().finally(() => inFlight.delete(key));
        inFlight.set(key, read);
        return read;
    };

    const stale = (caller: Caller): boolean => {
        const checkedAt = caller.membershipCheckedAt;
        if (checkedAt === undefined) return false;
        return checkedAt === null || now() - checkedAt.getTime() > ttlMs;
    };
    const guarded = async (caller: Caller | null): Promise<Caller | null> => {
        if (!caller || !stale(caller)) return caller;
        const verdict = await recheck(caller.org.id, caller.user.id);
        return verdict.kind === 'not-member' ? null : caller;
    };

    return {
        store: {
            ...store,
            async signIn(identity, orgId, installations) {
                const at = new Date(now());
                const answers = await Promise.all(
                    installations.map(async (org) => {
                        const verdict = await reader.read({
                            org: {
                                id: org.id,
                                login: org.name,
                                accountType: org.accountType ?? null,
                                accountId: org.accountId ?? null,
                            },
                            user: { githubUserId: identity.githubUserId, login: identity.login },
                        });
                        return [org.id, verdict] as const;
                    })
                );
                return store.signIn(identity, orgId, installations, { verdicts: new Map(answers), at });
            },
            findSession: async (tokenHash) => guarded(await store.findSession(tokenHash)),
            findPersonalToken: async (tokenHash) => guarded(await store.findPersonalToken(tokenHash)),
        },

        async pass(signal) {
            const due = await membership.due(new Date(now() - ttlMs), PASS_BATCH);
            for (const check of due) {
                if (signal?.aborted) return;
                await recheck(check.orgId, check.userId, signal);
            }
        },
    };
}

/** Runs the guard's pass on every replica, now and then; a failed pass leaves the rows for the next one. */
export function startMembershipRecheck(
    guard: Pick<MembershipGuard, 'pass'>,
    timedPass: <T>(loop: string, fn: () => Promise<T>) => Promise<T>,
    intervalMs = MEMBERSHIP_PASS_INTERVAL_MS
): () => Promise<void> {
    return startIntervalLoop(
        'membership',
        (signal) => timedPass('membership_recheck', () => guard.pass(signal)),
        intervalMs
    );
}

/**
 * The production wiring: under GitHub sign-in over a GitHub App, the guarded store and a starter for its pass,
 * reading each installation's members with a token minted for that installation. In any other mode there is no
 * GitHub membership to ask: the store as given, and a pass that never starts.
 */
export function membershipGuardFor(
    config: AppConfig,
    { sql, ready, store }: { sql: Sql; ready: Promise<unknown>; store: AuthStore }
): {
    store: AuthStore;
    start: (timedPass: <T>(loop: string, fn: () => Promise<T>) => Promise<T>) => () => Promise<void>;
} {
    if (config.auth.mode !== 'github' || config.github.mode !== 'app') {
        return { store, start: () => async () => undefined };
    }
    const github = config.github;
    const providers = new Map<string, InstallationTokenProvider>();
    const tokenFor = (installationId: string): Promise<string> => {
        let provider = providers.get(installationId);
        if (!provider) {
            provider = installationTokenProvider({ github, installationId });
            providers.set(installationId, provider);
        }
        return provider.get();
    };
    const guard = createMembershipGuard({
        store,
        membership: createMembershipStore({ sql, ready }),
        reader: createMembershipReader({ apiUrl: github.apiUrl, tokenFor }),
    });
    return { store: guard.store, start: (timedPass) => startMembershipRecheck(guard, timedPass) };
}
