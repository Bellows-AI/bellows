import { describe, expect, it } from 'vitest';
import { resolveOwnership, sessionKeyId } from '../src/usage-ownership.js';
import type { Owner } from '../src/usage.js';
import { branch, ev, world } from './usage-fixtures.js';

const KEY = { agent: 'claude-code', sessionId: 's1' };
const ownerOf = (input: ReturnType<typeof world>, key = KEY): Owner =>
    resolveOwnership(input, [key]).get(sessionKeyId(key.agent, key.sessionId)) as Owner;

describe('resolveOwnership', () => {
    it('resolves a board session to its task, author and repo; a hook-less one is still owned', () => {
        expect(ownerOf(world({ board: [ev()] }))).toEqual({
            status: 'resolved',
            taskId: 'j1',
            removed: false,
            authorId: 'u1',
            authorConflict: false,
            repo: 'repo-1',
            hook: false,
        });
    });

    it('marks hook when authenticated branch evidence exists in the tenant', () => {
        const owner = ownerOf(world({ board: [ev()], branch: [branch()] }));
        expect(owner).toMatchObject({ status: 'resolved', hook: true, repo: 'repo-1' });
    });

    it('excludes a session id any other org has evidence for, before anything else', () => {
        const input = world({ board: [ev()], branch: [branch()], foreignSessionIds: new Set(['s1']) });
        expect(ownerOf(input)).toEqual({ status: 'excluded', reason: 'foreign-org' });
    });

    it('excludes a session with no board and no branch evidence (the org-less hook-less leak)', () => {
        expect(ownerOf(world())).toEqual({ status: 'excluded', reason: 'unowned' });
    });

    it('ignores evidence rows that belong to another tenant', () => {
        expect(ownerOf(world({ board: [ev({ orgId: 'org-b' })], branch: [branch({ orgId: 'org-b' })] }))).toEqual({
            status: 'excluded',
            reason: 'unowned',
        });
    });

    it('policy unowned=unattributed turns an unowned key into a task-less resolved owner', () => {
        const owners = resolveOwnership(world(), [KEY], { unowned: 'unattributed' });
        expect(owners.get(sessionKeyId(KEY.agent, KEY.sessionId))).toMatchObject({
            status: 'resolved',
            taskId: null,
            authorId: null,
            repo: null,
            hook: false,
        });
    });

    it('policy unattributed never overrides a foreign session', () => {
        const owners = resolveOwnership(world({ foreignSessionIds: new Set(['s1']) }), [KEY], {
            unowned: 'unattributed',
        });
        expect(owners.get(sessionKeyId(KEY.agent, KEY.sessionId))).toEqual({
            status: 'excluded',
            reason: 'foreign-org',
        });
    });

    it('resolves branch-only evidence with no task and no author', () => {
        expect(ownerOf(world({ branch: [branch()] }))).toEqual({
            status: 'resolved',
            taskId: null,
            removed: false,
            authorId: null,
            authorConflict: false,
            repo: 'repo-1',
            hook: true,
        });
    });

    it('marks two tasks claiming one key as a task-conflict, never the smaller id', () => {
        const input = world({
            board: [ev({ jobId: 'j1', rootJobId: 'a-root' }), ev({ jobId: 'j2', rootJobId: 'b-root' })],
        });
        expect(ownerOf(input)).toEqual({ status: 'unresolved', reason: 'task-conflict' });
    });

    it('is independent of input order', () => {
        const rows = [
            ev({ jobId: 'j1', rootJobId: 'a-root' }),
            ev({ jobId: 'j2', rootJobId: 'b-root' }),
            ev({ jobId: 'j3', rootJobId: 'b-root', claimSeq: 2 }),
        ];
        const perms = [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]], [rows[2], rows[0], rows[1]]];
        const results = perms.map((board) => JSON.stringify(ownerOf(world({ board: board as typeof rows }))));
        expect(new Set(results).size).toBe(1);
    });

    it('counts a named review to its requester: same task, no conflict with the requester rows', () => {
        const input = world({
            board: [
                ev({ jobId: 'root1', rootJobId: 'root1' }),
                ev({
                    jobId: 'rev1',
                    rootJobId: 'rev1',
                    requestingJobId: 'root1',
                    requestingRootJobId: 'root1',
                    claimSeq: 1,
                }),
            ],
        });
        expect(ownerOf(input)).toMatchObject({ status: 'resolved', taskId: 'root1' });
    });

    it('treats a repo conflict across board and branch as unresolved, including a multi-repo branch-only session', () => {
        expect(ownerOf(world({ board: [ev()], branch: [branch({ repo: 'repo-2' })] }))).toEqual({
            status: 'unresolved',
            reason: 'repo-conflict',
        });
        expect(ownerOf(world({ branch: [branch(), branch({ repo: 'repo-2' })] }))).toEqual({
            status: 'unresolved',
            reason: 'repo-conflict',
        });
    });

    it('keeps the task and drops the author on conflicting board authors', () => {
        const input = world({ board: [ev({ authorId: 'u1' }), ev({ jobId: 'j1', claimSeq: 2, authorId: 'u2' })] });
        expect(ownerOf(input)).toMatchObject({
            status: 'resolved',
            taskId: 'j1',
            authorId: null,
            authorConflict: true,
        });
    });

    it('takes the repo from the execution when there is no hook, null when no evidence names one', () => {
        expect(ownerOf(world({ board: [ev({ repo: null })] }))).toMatchObject({ repo: null });
        expect(ownerOf(world({ board: [ev({ repo: 'repo-9' })] }))).toMatchObject({ repo: 'repo-9' });
    });

    it('flags removed when any board row of the task is removed, even on another session', () => {
        const input = world({ board: [ev(), ev({ sessionId: 'other', claimSeq: 2, removed: true })] });
        expect(ownerOf(input)).toMatchObject({ taskId: 'j1', removed: true });
    });

    it('matches evidence with a null agent to every agent of the session id', () => {
        const input = world({ board: [ev({ agent: null })] });
        expect(ownerOf(input, { agent: 'claude-code', sessionId: 's1' })).toMatchObject({ status: 'resolved' });
        expect(ownerOf(input, { agent: 'opencode', sessionId: 's1' })).toMatchObject({ status: 'resolved' });
    });

    it('does not let evidence naming codex own a claude-code key', () => {
        const input = world({ board: [ev({ agent: 'codex' })], branch: [branch({ agent: 'codex' })] });
        expect(ownerOf(input)).toEqual({ status: 'excluded', reason: 'unowned' });
        expect(ownerOf(input, { agent: 'codex', sessionId: 's1' })).toMatchObject({ status: 'resolved' });
    });
});
