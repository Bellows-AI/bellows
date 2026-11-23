import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeForge } from '../test-db/fake-forge.js';
import { type FakeGithub, startFakeGithub } from '../test-db/fake-github.js';
import { startFakeGitlab } from '../test-db/fake-gitlab.js';

/**
 * The in-process fakes the db suites share: `fake-github.ts` (sign-in, installation token, PR list) and `fake-gitlab.ts`,
 * both over the one boot in `fake-forge.ts` (`server/test-db/`).
 */
let fake: FakeGithub;
beforeEach(async () => {
    fake = await startFakeGithub();
});
afterEach(() => fake.stop());

describe('the in-process fake GitHub helper', () => {
    it('signs a member in and mints an installation token of another kind', async () => {
        const pair = await fake.signIn();
        expect(pair.access_token).toMatch(/^ghu_/);
        expect(await fake.installationToken()).toMatch(/^ghs_/);
    });

    it('lists the PRs with the kind of token that created each, and logs every call', async () => {
        const { access_token: token } = await fake.signIn();
        await fake.send('POST', '/repos/acme/widgets/pulls', {
            token,
            body: { head: 'task/one', base: 'main', title: 'T', body: 'B', draft: false },
        });
        expect((await fake.pulls()).map((pull) => pull.createdBy)).toEqual(['user']);
        expect(fake.calls().some((call) => call.method === 'POST' && call.tokenKind === 'user')).toBe(true);
    });

    it('refuses a member’s PR create while write access is off', async () => {
        const { access_token: token } = await fake.signIn();
        const create = () =>
            fake.send('POST', '/repos/acme/widgets/pulls', {
                token,
                body: { head: 'task/one', base: 'main', title: 'T', body: 'B', draft: false },
            });

        await fake.writeAccess(false);
        expect((await create()).status).toBe(404);
        await fake.writeAccess(true);
        expect((await create()).status).toBe(201);
    });

    it('shares one boot with the fake GitLab helper, which signs in beside it', async () => {
        const forge = await startFakeForge();
        expect((await forge.read('calls')).status).toBe(200);
        await forge.stop();
        const gitlab = await startFakeGitlab();
        expect((await gitlab.signIn()).access_token).toBeTruthy();
        await gitlab.stop();
    });
});
