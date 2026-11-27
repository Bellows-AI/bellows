import { describe, expect, it } from 'vitest';
import { gitlabAuthorOf } from '../src/db/jobs/job-store-claim-author.js';
import { gitlabProfileOf, parseForgeProfile } from '../src/integrations/forge-profile.js';

/** A GitLab member's commit author from the profile captured at link (docs/connections.md), every fallback step. */
const ACCOUNT = { id: '4711', host: 'git.example.test' };
const profile = (fields: Record<string, unknown>) => gitlabProfileOf({ username: 'dev-one', ...fields })!;

describe('gitlabAuthorOf', () => {
    it('prefers the commit email, then the public email, then the id-qualified noreply address', () => {
        const both = profile({ commit_email: 'commit@example.test', public_email: 'public@example.test' });
        expect(gitlabAuthorOf(both, ACCOUNT).email).toBe('commit@example.test');
        const publicOnly = profile({ commit_email: '', public_email: 'public@example.test' });
        expect(gitlabAuthorOf(publicOnly, ACCOUNT).email).toBe('public@example.test');
        const neither = profile({ commit_email: null, public_email: '  ' });
        expect(gitlabAuthorOf(neither, ACCOUNT).email).toBe('4711-dev-one@users.noreply.git.example.test');
    });

    it('reads the private commit choice as the noreply address, never the public email', () => {
        const chosen = profile({ commit_email: '_private', public_email: 'public@example.test' });
        expect(gitlabAuthorOf(chosen, ACCOUNT).email).toBe('4711-dev-one@users.noreply.git.example.test');
    });

    it('names the author by the GitLab name, else the username', () => {
        expect(gitlabAuthorOf(profile({ name: ' Dev One ' }), ACCOUNT).name).toBe('Dev One');
        expect(gitlabAuthorOf(profile({ name: '' }), ACCOUNT).name).toBe('dev-one');
        expect(gitlabAuthorOf(profile({}), ACCOUNT).name).toBe('dev-one');
    });
});

describe('the stored profile', () => {
    it('is absent without a username or when it is not an object', () => {
        expect(parseForgeProfile(null)).toBeNull();
        expect(parseForgeProfile('x')).toBeNull();
        expect(parseForgeProfile({ name: 'No Username' })).toBeNull();
        expect(gitlabProfileOf({ name: 'No Username' })).toBeNull();
    });

    it('round-trips what the link stored', () => {
        const stored = profile({ name: 'Dev', commit_email: 'c@example.test', public_email: 'p@example.test' });
        expect(parseForgeProfile(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    });
});
