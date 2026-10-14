import { describe, expect, it } from 'vitest';
import type { InstallationRepo } from '../src/github/app-client.js';
import { PENDING_COOKIE, SESSION_COOKIE } from '../src/auth/session.js';
import {
    ORG,
    begin,
    beginOnboarding,
    callback,
    finishOnboarding,
    pendingRoute,
    reposRoute,
    setup,
    signIn,
} from './auth.oauth-fixtures.js';

describe('the selection screen (#125)', () => {
    const TWO = [
        { id: '888888', account: 'other-org' },
        { id: ORG, account: 'acme' },
    ];

    it('serves the pending sign-in to the screen, and 401 NO_PENDING without the cookie', async () => {
        const { app } = await setup({ installations: TWO });

        // No cookie, garbage cookie: the screen has nothing to render, and says start again.
        expect((await pendingRoute(app)).statusCode).toBe(401);
        expect((await pendingRoute(app)).json().code).toBe('NO_PENDING');

        const cookie = await beginOnboarding(app);
        const response = await pendingRoute(app, cookie);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            identity: { login: 'octocat', displayName: 'The Octocat', avatarUrl: null },
            installations: [
                { id: '888888', account: 'other-org', tracked: null },
                { id: ORG, account: 'acme', tracked: null },
            ],
            // Every reported installation pre-checked: confirming the default is today's behavior.
            selected: ['888888', ORG],
            org: null,
            returnTo: '/',
            reselect: false,
        });
    });

    it('the pending payload carries the stored repo narrowing, so a reselect shows the truth', async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        // A first sign-in that narrows ORG to one repo.
        const first = await beginOnboarding(app);
        const done = await finishOnboarding(app, first, { orgs: [ORG], repos: { [ORG]: ['acme/web'] } });
        expect(done.statusCode).toBe(200);

        // The reselect's screen must SHOW the stored narrowing — checkboxes seeded from it, not
        // from "everything" — and carry it so confirming can widen back (posting [] clears it).
        const second = await beginOnboarding(app, '/', undefined, true);
        const screen = await pendingRoute(app, second);
        const orgs = screen.json().installations as { id: string; tracked: string[] | null }[];
        expect(orgs).toEqual([
            { id: '888888', account: 'other-org', tracked: null },
            { id: ORG, account: 'acme', tracked: ['acme/web'] },
        ]);
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);
    });

    it('the pending payload reports the stored narrowing as stored — the screen intersects with the listing', async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        // A narrowing written when 'acme/gone' still existed on GitHub's side. The payload
        // carries the raw stored names — the honest stale selection; the screen holds the live
        // listing anyway and intersects when seeding and before posting, so a name the listing
        // cannot render is never seeded and never submitted (posting it would 400 UNKNOWN_REPO
        // with no checkbox anywhere to uncheck).
        await auth.replaceTrackedRepos(ORG, ['acme/gone', 'acme/web']);

        const cookie = await beginOnboarding(app, '/', undefined, true);
        const screen = await pendingRoute(app, cookie);
        const orgs = screen.json().installations as { id: string; tracked: string[] | null }[];
        expect(orgs).toEqual([
            { id: '888888', account: 'other-org', tracked: null },
            { id: ORG, account: 'acme', tracked: ['acme/gone', 'acme/web'] },
        ]);
    });

    it('a narrowing whose every entry went stale is kept and reported, never widened to track-all', async () => {
        // Every stored entry removed on GitHub's side. Retiring the dead rows would write [] —
        // which this store reads as TRACK-EVERYTHING, silently widening the org to every repo
        // its installation can see. So the rows are kept: the repo source keeps filtering
        // against names that no longer match anything and the org fails closed, and the screen
        // is told the stored names as they are — it intersects them with the listing it holds,
        // so an untouched org posts nothing and the rows stay retained; touching the live
        // checkboxes is the person's explicit revision.
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        await auth.replaceTrackedRepos(ORG, ['acme/gone', 'acme/also-gone']);

        const cookie = await beginOnboarding(app, '/', undefined, true);
        const screen = await pendingRoute(app, cookie);
        const orgs = screen.json().installations as { id: string; tracked: string[] | null }[];
        expect(orgs).toEqual([
            { id: '888888', account: 'other-org', tracked: null },
            { id: ORG, account: 'acme', tracked: ['acme/gone', 'acme/also-gone'] },
        ]);
        // The dead rows are retained — [] would read as track-everything — so the org tracks
        // nothing effective until the choice is explicitly rewritten.
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/gone', 'acme/also-gone']);
    });

    it('a partially stale narrowing rides raw in the payload — the dead entry drops in the screen', async () => {
        // One live entry, one gone: the narrowing is still meaningful, so nothing is cleared.
        // The payload carries both names as stored; the screen intersects them with the live
        // listing when seeding and before posting, so only the survivor is ever seeded or
        // submitted.
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        await auth.replaceTrackedRepos(ORG, ['acme/gone', 'acme/web']);

        const cookie = await beginOnboarding(app, '/', undefined, true);
        const screen = await pendingRoute(app, cookie);
        const orgs = screen.json().installations as { id: string; tracked: string[] | null }[];
        expect(orgs).toEqual([
            { id: '888888', account: 'other-org', tracked: null },
            { id: ORG, account: 'acme', tracked: ['acme/gone', 'acme/web'] },
        ]);
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/gone', 'acme/web']);
    });

    it('completing tracks only the chosen orgs, signs in, and spends the pending row', async () => {
        const { app, auth } = await setup({ installations: TWO });
        const cookie = await beginOnboarding(app);

        const response = await finishOnboarding(app, cookie, { orgs: [ORG] });

        expect(response.statusCode).toBe(200);
        expect(response.json().organization).toEqual({ id: ORG, name: 'acme' });
        expect(response.json().returnTo).toBe('/');
        const session = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
        expect(session).toBeTruthy();
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session! } });
        expect(me.json().organizations).toEqual([{ id: ORG, name: 'acme' }]);
        // The unchosen installation was never materialized — no row, no membership, no runtime.
        expect(await auth.findOrg('888888')).toBeNull();
        // Single-use: the row is spent, and a replayed completion starts again rather than
        // minting a second session.
        expect(auth.pendingSignIns()).toEqual([]);
        const replay = await finishOnboarding(app, cookie, { orgs: [ORG] });
        expect(replay.statusCode).toBe(401);
    });

    it('a completion failure after the claim undoes the materialization, so the choice is re-asked', async () => {
        // The claim is spent before signIn and the allowlist writes run. If a later write fails
        // and the memberships stayed, the next OAuth attempt would see a stored selection and
        // bypass onboarding — silently losing the repo choice the person made. The route rolls
        // the materialization back instead: memberships removed, allowlist rows cleared, and the
        // next sign-in parks at the screen again.
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [{ owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null }],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const cookie = await beginOnboarding(app);
        auth.failNextTrackedRepoWrite();

        const response = await finishOnboarding(app, cookie, { orgs: [ORG], repos: { [ORG]: ['acme/web'] } });
        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('COMPLETE_FAILED');

        // Nothing half-landed: no session, no membership, no allowlist row.
        expect(auth.sessions()).toEqual([]);
        expect(await auth.storedSelection(4242)).toEqual([]);
        expect(await auth.trackedRepos(ORG)).toEqual([]);

        // And the next sign-in re-enters the screen rather than bypassing it.
        const state = await begin(app);
        const next = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(next.headers.location).toBe('/onboarding');
    });

    it('a failed reselect restores the prior choice instead of destroying it', async () => {
        // The test above fails a FIRST sign-in: nothing pre-exists, so "undo" and "restore" are
        // the same thing. A RESELECT is where they differ — the account already holds memberships
        // and allowlist rows — and a rollback that clears or removes instead of restoring would
        // silently widen a narrowed org and drop standing memberships. So: both orgs chosen and
        // narrowed once, then a reselect whose first rewrite lands and whose second write fails.
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': [
                { owner: 'other-org', name: 'api', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'other-org', name: 'web', private: false, defaultBranch: null, pushedAt: null },
            ],
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const first = await beginOnboarding(app);
        const done = await finishOnboarding(app, first, {
            orgs: [ORG, '888888'],
            repos: { [ORG]: ['acme/web'], '888888': ['other-org/api'] },
        });
        expect(done.statusCode).toBe(200);
        // The standing session the first sign-in minted — the failed reselect must not add to it.
        expect(auth.sessions()).toHaveLength(1);

        // The reselect rewrites both narrowings; the injector lets the first write land and fails
        // the second, so the route's catch runs with real prior state to get back to. (Both keys
        // are numeric, so the payload iterates '888888' first — the write that succeeds.)
        const second = await beginOnboarding(app, '/', undefined, true);
        auth.failNextTrackedRepoWrite(1);
        const response = await finishOnboarding(app, second, {
            orgs: [ORG, '888888'],
            repos: { [ORG]: ['acme/other'], '888888': ['other-org/web'] },
        });
        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('COMPLETE_FAILED');

        // No half-landed session — and the PRIOR choice intact: memberships on both orgs, and
        // each org's ORIGINAL narrowing, not a cleared allowlist and not the reselect's new one.
        expect(auth.sessions()).toHaveLength(1);
        expect((await auth.storedSelection(4242)).sort()).toEqual(['888888', ORG]);
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);
        expect(await auth.trackedRepos('888888')).toEqual(['other-org/api']);
    });

    it('refuses an empty or foreign selection, an expired row, and no cookie at all', async () => {
        const { app, auth } = await setup({ installations: TWO });
        const cookie = await beginOnboarding(app);

        const empty = await finishOnboarding(app, cookie, { orgs: [] });
        expect(empty.statusCode).toBe(400);
        expect(empty.json().code).toBe('BAD_SELECTION');
        // '111111' was never reported — the selection may only narrow what GitHub reported.
        const foreign = await finishOnboarding(app, cookie, { orgs: ['111111'] });
        expect(foreign.statusCode).toBe(400);
        expect(foreign.json().code).toBe('BAD_SELECTION');
        // A forged or stale cookie is the same "start again" as an absent one.
        const forged = await finishOnboarding(app, 'forged.cookie', { orgs: [ORG] });
        expect(forged.statusCode).toBe(401);
        expect(forged.json().code).toBe('NO_PENDING');

        auth.expirePendingSignIns();
        const expired = await finishOnboarding(app, cookie, { orgs: [ORG] });
        expect(expired.statusCode).toBe(401);
        expect(expired.json().code).toBe('NO_PENDING');

        // None of the refusals signed anybody in.
        expect(auth.sessions()).toEqual([]);
    });

    it('the next sign-in with a stored selection skips the screen', async () => {
        const { app, auth } = await setup({ installations: TWO });
        const pending = await beginOnboarding(app);
        await finishOnboarding(app, pending, { orgs: [ORG] });

        // The stored choice IS the membership set: this sign-in sees it and goes straight in.
        const state = await begin(app, '/dash');
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/dash');
        // No screen on this path: no pending cookie is set.
        expect(response.cookies.find((c) => c.name === PENDING_COOKIE)).toBeUndefined();
        const session = response.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session } });
        expect(me.json().organization).toEqual({ id: ORG, name: 'acme' });
        expect(me.json().organizations).toEqual([{ id: ORG, name: 'acme' }]);
        expect(auth.pendingSignIns()).toEqual([]);
    });

    it('a stored selection intersected with a smaller report drops the unreported org and keeps the rest', async () => {
        const { app, auth, identity } = await setup({ installations: TWO });
        const pending = await beginOnboarding(app);
        await finishOnboarding(app, pending, { orgs: [ORG, '888888'] });

        // GitHub stops reporting ORG: the stored selection can no longer include it, so the
        // sign-in proceeds with '888888' alone — and the sweep ends the ORG membership.
        identity.installationsQueue.push([{ id: '888888', account: 'other-org' }]);
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.headers.location).toBe('/');

        const session = response.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session } });
        const userId = me.json().user.id as string;
        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual(['888888']);
    });

    it('the ?org= deep link preselects the org, and completion lands the session there', async () => {
        const { app } = await setup({ installations: TWO });

        const cookie = await beginOnboarding(app, '/', ORG);
        const screen = await pendingRoute(app, cookie);
        // The preference is visible on the screen, even though everything arrives pre-checked.
        expect(screen.json().org).toBe(ORG);

        const response = await finishOnboarding(app, cookie, { orgs: ['888888', ORG] });
        expect(response.statusCode).toBe(200);
        const session = response.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session } });
        // NOT the first of the selection — the one the deep link named.
        expect(me.json().organization).toEqual({ id: ORG, name: 'acme' });
    });

    it('reselect=1 reopens the screen with the stored choice pre-checked', async () => {
        const { app } = await setup({ installations: TWO });
        const first = await beginOnboarding(app);
        await finishOnboarding(app, first, { orgs: [ORG] });

        const state = await begin(app, '/account', undefined, true);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.headers.location).toBe('/onboarding');

        const cookie = response.cookies.find((c) => c.name === PENDING_COOKIE)!.value;
        const screen = await pendingRoute(app, cookie);
        expect(screen.json().reselect).toBe(true);
        // The stored choice, not everything reported: the screen opens pre-checked with it.
        expect(screen.json().selected).toEqual([ORG]);
    });

    it('reselect=1 opens the screen for a single installation too — the link is their only lever', async () => {
        // Onboarding completion is the only production writer of tracked_repo, and the account
        // page's reselect link is the only surface that re-opens it. Gating the park on
        // `reported.length >= 2` made following that link a no-op for a single-installation
        // account: it signed straight back in, and the repos it tracks could never change.
        const { app } = await setup({
            installationListing: async () => [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
            ],
        });
        await signIn(app);

        const state = await begin(app, '/account', undefined, true);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.headers.location).toBe('/onboarding');
        const cookie = response.cookies.find((c) => c.name === PENDING_COOKIE)?.value;
        expect(cookie).toBeTruthy();

        // The screen works with one org, and completing it narrows what the installation tracks.
        const done = await finishOnboarding(app, cookie!, {
            orgs: [ORG],
            repos: { [ORG]: ['acme/web'] },
        });
        expect(done.statusCode).toBe(200);
    });

    it('a first sign-in with a single installation still goes straight in', async () => {
        // The other half of the gate: with nothing stored and one installation there is nothing
        // to choose, so the round trip must not park.
        const { app } = await setup();

        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/');
        expect(response.cookies.find((c) => c.name === PENDING_COOKIE)).toBeUndefined();
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    });

    it('completing invalidates the org runtime\u2019s repo cache, so the choice is served at once', async () => {
        // The per-org runtime caches its repo list — the installation report intersected with
        // tracked_repo — on a ten-minute TTL. A reselect that rewrote the allowlist without
        // invalidating would leave stats, the picker and the validation reads serving the
        // pre-choice truth until the TTL ran out.
        const { app, orgs, repos } = await setup({ installations: TWO });
        const runtime = await orgs.for(ORG);
        expect(runtime?.repos).toBe(repos);
        const before = repos.invalidations();

        const cookie = await beginOnboarding(app);
        const done = await finishOnboarding(app, cookie, { orgs: [ORG] });
        expect(done.statusCode).toBe(200);

        // Two expires: one when the allowlist lands, and one after completion drains whatever
        // refresh was in flight — a produce that started before the write holds the pre-write
        // allowlist and would otherwise stand fresh once it lands.
        expect(repos.invalidations()).toBe(before + 2);
    });

    it("serves an installation's repos through the App seam, or source none without one", async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const cookie = await beginOnboarding(app);

        const tracked = await reposRoute(app, ORG, cookie);
        expect(tracked.statusCode).toBe(200);
        expect(tracked.json()).toEqual({ repos: ['acme/web', 'acme/other'], source: 'app' });

        // No App client for this installation (or GitHub failed): the screen can render the org
        // but not narrow it — 'none' is a fact, never an empty list pretending to be one.
        const untracked = await reposRoute(app, '888888', cookie);
        expect(untracked.statusCode).toBe(200);
        expect(untracked.json()).toEqual({ repos: [], source: 'none' });

        // Only reported installations can be listed, and only with a pending sign-in at all.
        const unknown = await reposRoute(app, '111111', cookie);
        expect(unknown.statusCode).toBe(400);
        expect(unknown.json().code).toBe('UNKNOWN_INSTALLATION');
        const anonymous = await reposRoute(app, ORG);
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.json().code).toBe('NO_PENDING');
    });

    it('completion records the repo allowlist, and refuses repos the installation cannot see', async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const cookie = await beginOnboarding(app);

        const narrowed = await finishOnboarding(app, cookie, { orgs: [ORG], repos: { [ORG]: ['acme/web'] } });
        expect(narrowed.statusCode).toBe(200);
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);

        // A second onboarding — reselect, since the account now has a stored choice — narrowing
        // to a repo the listing did not name is refused.
        const second = await beginOnboarding(app, '/', undefined, true);
        const unknownRepo = await finishOnboarding(app, second, {
            orgs: [ORG],
            repos: { [ORG]: ['acme/nope'] },
        });
        expect(unknownRepo.statusCode).toBe(400);
        expect(unknownRepo.json().code).toBe('UNKNOWN_REPO');

        // Narrowing an installation whose repos cannot be listed would silently drop the truth
        // from the screen's checkboxes — refused rather than guessed.
        const third = await beginOnboarding(app, '/', undefined, true);
        const unavailable = await finishOnboarding(app, third, {
            orgs: ['888888'],
            repos: { '888888': ['elsewhere/one'] },
        });
        expect(unavailable.statusCode).toBe(400);
        expect(unavailable.json().code).toBe('REPOS_UNAVAILABLE');
    });

    it('a repos key naming an unselected org is a bad selection, and all-checked posts nothing', async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [{ owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null }],
            '888888': [{ owner: 'other', name: 'one', private: false, defaultBranch: null, pushedAt: null }],
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const cookie = await beginOnboarding(app);

        // A narrowed org the confirmation does not select has nothing to attach to.
        const stray = await finishOnboarding(app, cookie, { orgs: [ORG], repos: { '888888': ['other/one'] } });
        expect(stray.statusCode).toBe(400);
        expect(stray.json().code).toBe('BAD_SELECTION');

        // The default confirmation — everything checked — writes no allowlist at all.
        const all = await finishOnboarding(app, cookie, { orgs: [ORG, '888888'] });
        expect(all.statusCode).toBe(200);
        expect(await auth.trackedRepos(ORG)).toEqual([]);
        expect(await auth.trackedRepos('888888')).toEqual([]);
    });

    it('an empty repos list is the widening move: it clears a stored narrowing back to everything', async () => {
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
                { owner: 'acme', name: 'other', private: false, defaultBranch: null, pushedAt: null },
            ],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const first = await beginOnboarding(app);
        await finishOnboarding(app, first, { orgs: [ORG], repos: { [ORG]: ['acme/web'] } });
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);

        // The reselect posts the org back as all-checked: an empty list, which the store writes
        // as zero rows — track everything again, future repos included.
        const second = await beginOnboarding(app, '/', undefined, true);
        const widened = await finishOnboarding(app, second, { orgs: [ORG], repos: { [ORG]: [] } });
        expect(widened.statusCode).toBe(200);
        expect(await auth.trackedRepos(ORG)).toEqual([]);
    });

    it('a reselect completion without a repos key leaves the stored narrowing standing (issue 187)', async () => {
        // The screen's preserved-not-reviewable rule: a specific org whose listing cannot be
        // read posts its org id and NO repos key, and the store must read that omission as "no
        // change" — never as a widening. Contrast the test above, where an explicit [] IS the
        // widening move.
        const listing: Record<string, InstallationRepo[] | null> = {
            [ORG]: [{ owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null }],
            '888888': null,
        };
        const { app, auth } = await setup({
            installations: TWO,
            installationListing: async (id) => listing[id] ?? null,
        });
        const first = await beginOnboarding(app);
        await finishOnboarding(app, first, { orgs: [ORG], repos: { [ORG]: ['acme/web'] } });
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);

        const second = await beginOnboarding(app, '/', undefined, true);
        const preserved = await finishOnboarding(app, second, { orgs: [ORG] });
        expect(preserved.statusCode).toBe(200);
        expect(await auth.trackedRepos(ORG)).toEqual(['acme/web']);
    });
});
