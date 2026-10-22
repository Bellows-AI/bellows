import { describe, expect, it } from 'vitest';
import { resolveClaimGates, resolveClaimPublish } from '../src/db/job-store-claim.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';

const definition: WorkflowDefinition = {
    entry: 'review',
    params: [],
    nodes: [
        { name: 'review', kind: 'agent', session: 'fresh', gates: false, prompt: 'review' },
        { name: 'fix', kind: 'agent', session: 'resume', publish: true, prompt: 'fix' },
    ],
    edges: [{ from: 'review', to: 'fix', when: { marker: 'CHANGES' } }],
};

const read = {
    claimGates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
    claimServices: [{ name: 'db', image: 'postgres:17', environment: [], ports: [5432] }],
    planRevision: 'rev-1',
    planRefusal: null,
};

// The plan rides with the gates — a node that opts out of the gates carries no gates, no services,
// no revision and no refusal, so the driver never launches (or refuses) a gate-less run over a
// plan it does not use.
describe('resolveClaimPublish: the execution plan', () => {
    it('drops the whole plan on a node that opts out of the gates', () => {
        expect(resolveClaimPublish(definition, 'review', read)).toEqual({
            publish: false,
            claimGates: null,
            claimServices: [],
            planRevision: null,
            planRefusal: null,
        });
    });

    it('drops a refusal with the plan on a node that opts out of the gates', () => {
        const refused = { ...read, claimGates: null, claimServices: [], planRefusal: 'ports collide' };
        expect(resolveClaimPublish(definition, 'review', refused).planRefusal).toBeNull();
        expect(resolveClaimPublish(definition, 'fix', refused).planRefusal).toBe('ports collide');
    });

    // Issue #503: only an agent-less node's claim carries `agent: false`; the plan still rides it.
    it('flags an agent-less node and leaves every other claim without the field', () => {
        const agentless: WorkflowDefinition = {
            ...definition,
            nodes: [
                { name: 'verify', kind: 'agent', session: 'resume', agent: false, publish: true, prompt: 'verify' },
            ],
        };
        expect(resolveClaimPublish(agentless, 'verify', read)).toMatchObject({ agent: false, publish: true });
        expect(resolveClaimPublish(agentless, 'verify', read).planRevision).toBe('rev-1');
        expect(resolveClaimPublish(definition, 'fix', read)).not.toHaveProperty('agent');
        expect(resolveClaimPublish(null, null, read)).not.toHaveProperty('agent');
    });

    it('keeps the plan on a gated node and on a workflow-less claim', () => {
        expect(resolveClaimPublish(definition, 'fix', read).claimServices).toHaveLength(1);
        expect(resolveClaimPublish(null, null, read).planRevision).toBe('rev-1');
    });
});

describe('resolveClaimGates: the plan reader', () => {
    const ctx = { orgId: 'o', rootJobId: 'root' };
    const row = { created_by: null, repo: 'acme/web', base_branch: 'release' };

    it('asks the reader for the repo at the thread base branch and carries the revision', async () => {
        const asked: unknown[][] = [];
        const resolved = await resolveClaimGates(
            {
                readFor: async (...args) => {
                    asked.push(args);
                    return { config: read.claimGates, services: read.claimServices, revision: 'rev-9', error: null };
                },
            },
            ctx,
            row
        );
        expect(asked).toEqual([['acme/web', 'release']]);
        expect(resolved).toMatchObject({ planRevision: 'rev-9', planRefusal: null, claimServices: read.claimServices });
    });

    it('carries a refusal as a value and withholds the half-read plan', async () => {
        const resolved = await resolveClaimGates(
            {
                readFor: async () => ({
                    config: read.claimGates,
                    services: read.claimServices,
                    revision: 'rev-9',
                    error: 'services "a" and "b" both declare port 5432',
                }),
            },
            ctx,
            row
        );
        expect(resolved.planRefusal).toMatch(/port 5432/);
        expect(resolved.claimGates).toBeNull();
        expect(resolved.claimServices).toEqual([]);
    });

    it('lets a reader outage reject so the claim is retried', async () => {
        await expect(
            resolveClaimGates({ readFor: async () => Promise.reject(new Error('rate limited')) }, ctx, row)
        ).rejects.toThrow('rate limited');
    });

    it('carries no plan without a reader or a repo label', async () => {
        expect(await resolveClaimGates(undefined, ctx, row)).toMatchObject({ claimGates: null, planRevision: null });
        const reader = { readFor: async () => Promise.reject(new Error('must not be asked')) };
        expect(await resolveClaimGates(reader, ctx, { ...row, repo: null })).toMatchObject({ planRefusal: null });
    });
});
