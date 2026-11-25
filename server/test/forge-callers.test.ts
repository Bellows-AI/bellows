import { githubRepo, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    BRANCH_UNCHECKED,
    readBranchHead,
    resolveForgeClient,
    INSTALLATION_CREDENTIAL,
} from '../src/forge/forge-client.js';
import { effectiveCatalog, standingOf } from '../src/skill-catalog.js';
import { githubForge } from './helpers-forge.js';
import { staticRegistry } from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * The callers that read a repository's forge, with the same path on github.com and on another forge or host: each
 * ref goes only to its own forge, and a ref no client answers for is inconclusive (never an empty list, a 404,
 * "no skills" or a missing branch) with no GitHub request. A listed repo is GitHub's (`RepoSource` lists
 * `owner/name`), so routes that check tracking refuse the twin first; the readers' own behaviour is pinned below them.
 */
const _track = trackApps();
const GITHUB = githubRepo('acme/web');
const GITLAB = parseRepoRef('gitlab:gitlab.example.test/acme/web')!;
const ENTERPRISE = parseRepoRef('github:ghe.example.test/acme/web')!;
const TWINS: readonly RepoRef[] = [GITLAB, ENTERPRISE];
const _idOf = (ref: RepoRef) =>
    encodeURIComponent(ref === GITHUB ? 'acme/web' : `${ref.forge}:${ref.host}/${ref.path}`);

const skillRead = { revision: 'r', skills: [], unreadable: [], complete: true };

/** Every GitHub read a test might trigger, recording the path it was asked for. */
function spies() {
    const calls: string[] = [];
    return {
        calls,
        reads: {
            readBranchHead: async (repo: string, branch: string) => {
                calls.push(`head ${repo}@${branch}`);
                return 'sha';
            },
            listBranches: async (repo: string) => {
                calls.push(`branches ${repo}`);
                return { names: ['main'], cursor: null };
            },
            listRepoSkills: async (repo: string) => {
                calls.push(`skills ${repo}`);
                return skillRead;
            },
            readFileAtBranchTip: async (repo: string) => {
                calls.push(`file ${repo}`);
                return null;
            },
        },
    };
}

describe('the forge readers, by complete repo ref', () => {
    it('sends each of two repos sharing a path only to its own forge', async () => {
        const { calls, reads } = spies();
        const forge = githubForge(reads);
        expect(await readBranchHead(forge, GITHUB, 'main')).toBe('sha');
        for (const twin of TWINS) {
            expect(await readBranchHead(forge, twin, 'main')).toBe(BRANCH_UNCHECKED);
            expect(resolveForgeClient(forge, twin, INSTALLATION_CREDENTIAL)).toMatchObject({
                ok: false,
                reason: 'unsupported',
                forge: twin.forge,
                host: twin.host,
            });
        }
        const client = resolveForgeClient(forge, GITHUB, INSTALLATION_CREDENTIAL);
        if (!client.ok) throw new Error('github.com resolves');
        await client.client.listBranches({});
        await client.client.listSkills(null, []);
        await client.client.readFile(null, 'x');
        // Only the github.com repo was asked, and by its own path.
        expect(calls).toEqual(['head acme/web@main', 'branches acme/web', 'skills acme/web', 'file acme/web']);
    });

    it('answers unchecked, which is no evidence of absence, when the board holds no forge at all', async () => {
        expect(await readBranchHead(undefined, GITHUB, 'main')).toBe(BRANCH_UNCHECKED);
    });

    it.each(TWINS)('reads no skills for %j through GitHub and says so as unconfirmed', async (twin) => {
        const { calls, reads } = spies();
        const catalog = await effectiveCatalog({
            builtin: [],
            forge: githubForge(reads),
            repo: twin,
            branch: null,
            executorType: { state: 'known', type: null },
            need: ['deploy'],
        });
        expect(calls).toEqual([]);
        expect(catalog.repo.state).toBe('unconfirmed');
        expect(standingOf(catalog, 'deploy')).toBe('unverified');
    });
});

describe('OrgRuntime.forge, as the org registry hands it out', () => {
    it('answers the github.com repo from its own reads and a GitLab twin with none, with zero GitHub calls', async () => {
        const { calls, reads } = spies();
        const registry = staticRegistry({
            branchHead: reads.readBranchHead,
            listBranches: reads.listBranches,
            repoSkills: reads.listRepoSkills,
        });
        const rt = await registry.for('org-1');
        expect(rt?.forge).toBeDefined();
        expect(await readBranchHead(rt?.forge, GITHUB, 'main')).toBe('sha');
        for (const twin of TWINS) {
            expect(await readBranchHead(rt?.forge, twin, 'main')).toBe(BRANCH_UNCHECKED);
            expect(resolveForgeClient(rt?.forge, twin, INSTALLATION_CREDENTIAL)).toMatchObject({
                ok: false,
                reason: 'unsupported',
                forge: twin.forge,
                host: twin.host,
            });
        }
        expect(calls).toEqual(['head acme/web@main']);
    });
});
