import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { classifyTranscript, type ToolActivity } from '../src/telemetry/transcript-tools.js';

/**
 * Issue #983: gate runs and pull-request operations are read out of an executor's own transcript.
 * An activity is successful only when its result is paired with the call and parses; a call with no
 * result, a garbled result, prose, or a PR URL in discussion is unknown or nothing, never success.
 * The fixtures are synthetic: no real repository, host or task id.
 */
const REPO = 'example-org/example-repo';
const exec = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/transcripts/${name}`, import.meta.url), 'utf8');
const read = (executor: string, name: string, repo: string | null = REPO): ToolActivity[] =>
    classifyTranscript({ executor, chunks: [{ offset: 0, text: fixture(name) }], repo });
const byId = (all: ToolActivity[], id: string) => all.filter((a) => a.toolCallId === id);

describe('claude gate calls', () => {
    const all = read(CLAUDE_CODE, 'claude-gates.jsonl');

    it('a paired result with an integer exit code is the outcome, and carries the execution id', () => {
        const [pass] = byId(all, 'toolu_gate_pass');
        expect(pass).toMatchObject({
            session: 'claude-session-1',
            kind: 'gate',
            operation: 'run',
            gate: 'test',
            filtered: false,
            result: { outcome: 'passed', exitCode: 0, executionId: exec(1) },
        });
        const [fail] = byId(all, 'toolu_gate_fail');
        expect(fail?.result).toMatchObject({ outcome: 'failed', exitCode: 1, executionId: exec(2) });
        expect(fail?.gate).toBe('lint');
    });

    it('a filtered call is marked filtered', () => {
        expect(byId(all, 'toolu_gate_filtered')[0]).toMatchObject({ gate: 'test', filtered: true });
    });

    it('a call with no result is interrupted: the call is recorded, no result, no outcome', () => {
        expect(byId(all, 'toolu_gate_interrupted')[0]).toMatchObject({ kind: 'gate', gate: 'build', result: null });
    });

    it('a result that does not parse is unknown, never a pass or a failure', () => {
        const [garbled] = byId(all, 'toolu_gate_garbled');
        expect(garbled?.result).toMatchObject({ outcome: 'unknown', exitCode: null, executionId: null });
    });

    it('a result with no call yields nothing', () => {
        expect(byId(all, 'toolu_orphan_result')).toEqual([]);
    });

    it('a result written before its call still pairs', () => {
        expect(byId(all, 'toolu_gate_reordered')[0]?.result).toMatchObject({ outcome: 'passed', exitCode: 0 });
    });

    it('ordinary commands and prose that says tests passed yield nothing', () => {
        expect(byId(all, 'toolu_plain_tests')).toEqual([]);
        expect(all.every((a) => a.kind === 'gate')).toBe(true);
    });

    it('a history replayed in the same transcript counts once', () => {
        expect(byId(all, 'toolu_gate_pass')).toHaveLength(1);
    });
});

describe('claude pull request calls', () => {
    const all = read(CLAUDE_CODE, 'claude-pr.jsonl');

    it('gh pr create whose last line is a URL of the job repo is a confirmed creation', () => {
        const [created] = byId(all, 'toolu_pr_create');
        expect(created).toMatchObject({
            kind: 'pr',
            operation: 'create',
            result: { outcome: 'passed', repo: REPO, prNumber: 12, prUrl: `https://github.com/${REPO}/pull/12` },
        });
        expect(byId(all, 'toolu_pr_create')).toHaveLength(1);
    });

    it('a URL of another repository is not this job’s PR: unknown, with no PR fields', () => {
        const [foreign] = byId(all, 'toolu_pr_foreign');
        expect(foreign?.result).toMatchObject({ outcome: 'unknown', repo: null, prNumber: null, prUrl: null });
    });

    it('with no job repo known nothing can be confirmed', () => {
        const none = read(CLAUDE_CODE, 'claude-pr.jsonl', null);
        expect(byId(none, 'toolu_pr_create')[0]?.result?.outcome).toBe('unknown');
    });

    it('an errored create is failed; one that names an existing PR is not a creation either', () => {
        expect(byId(all, 'toolu_pr_failed')[0]?.result?.outcome).toBe('failed');
        const [exists] = byId(all, 'toolu_pr_exists');
        expect(exists?.result).toMatchObject({ outcome: 'failed', prNumber: null, prUrl: null });
    });

    it('a create with no result is recorded with no outcome', () => {
        expect(byId(all, 'toolu_pr_unfinished')[0]).toMatchObject({ operation: 'create', result: null });
    });

    it('gh pr view and gh pr list are lookups, never creations', () => {
        for (const id of ['toolu_pr_view', 'toolu_pr_list']) {
            const [lookup] = byId(all, id);
            expect(lookup).toMatchObject({ kind: 'pr', operation: 'lookup' });
            expect(lookup?.result?.outcome).toBe('unknown');
            expect(lookup?.result?.prUrl).toBeNull();
        }
    });

    it('a publish reply carries the operation id and the PR it confirmed', () => {
        const [publish] = byId(all, 'toolu_publish');
        expect(publish).toMatchObject({
            operation: 'publish',
            result: { outcome: 'passed', operationId: exec(7), repo: REPO, prNumber: 12 },
        });
        const [noop] = byId(all, 'toolu_publish_noop');
        expect(noop?.result).toMatchObject({ outcome: 'unknown', operationId: null, prUrl: null });
    });

    it('a PR URL in assistant text creates no activity', () => {
        expect(all.map((a) => a.toolCallId)).not.toContain('text');
        expect(all.filter((a) => a.result?.prNumber === 99)).toEqual([]);
    });
});

describe('opencode export', () => {
    const all = read(OPENCODE, 'opencode-export.jsonl');

    it('reads the gate result off the tool part, with the session of the record', () => {
        expect(
            byId(all, 'call_pass')
                .map((a) => a.session)
                .sort()
        ).toEqual(['opencode-session-A', 'opencode-session-B']);
        const a = byId(all, 'call_pass').find((x) => x.session === 'opencode-session-A');
        expect(a).toMatchObject({ gate: 'test', result: { outcome: 'passed', exitCode: 0, executionId: exec(1) } });
        expect(byId(all, 'call_fail')[0]?.result).toMatchObject({ outcome: 'failed', exitCode: 1 });
    });

    it('a part still running is interrupted; an errored part is unknown', () => {
        expect(byId(all, 'call_running')[0]?.result).toBeNull();
        expect(byId(all, 'call_error')[0]?.result?.outcome).toBe('unknown');
    });

    it('two sessions in one export stay two sessions, a shared call id included', () => {
        expect(byId(all, 'call_pass_b')[0]?.session).toBe('opencode-session-B');
        expect(all.filter((x) => x.toolCallId === 'call_pass')).toHaveLength(2);
    });

    it('pull requests are confirmed only from a clean, URL-ended result of the job repo', () => {
        expect(byId(all, 'call_pr')[0]?.result).toMatchObject({ outcome: 'passed', repo: REPO, prNumber: 12 });
        expect(byId(all, 'call_pr_foreign')[0]?.result?.outcome).toBe('unknown');
        expect(byId(all, 'call_pr_failed')[0]?.result?.outcome).toBe('failed');
        expect(byId(all, 'call_pr_exit')[0]?.result?.outcome).toBe('failed');
    });

    it('text parts and non-part rows yield nothing', () => {
        expect(all.map((a) => a.toolCallId).sort()).toEqual(
            [
                'call_error',
                'call_fail',
                'call_pass',
                'call_pass',
                'call_pass_b',
                'call_pr',
                'call_pr_exit',
                'call_pr_failed',
                'call_pr_foreign',
                'call_running',
            ].sort()
        );
    });
});

describe('provenance and boundaries', () => {
    it('offsets are byte offsets in the stream, across chunks', () => {
        const text = fixture('claude-gates.jsonl');
        const lines = text.split('\n');
        const first = `${lines[0]}\n`;
        const rest = lines.slice(1).join('\n');
        const split = classifyTranscript({
            executor: CLAUDE_CODE,
            chunks: [
                { offset: 0, text: first },
                { offset: Buffer.byteLength(first), text: rest },
            ],
            repo: REPO,
        });
        const whole = read(CLAUDE_CODE, 'claude-gates.jsonl');
        expect(split).toEqual(whole);
        const pass = byId(whole, 'toolu_gate_pass')[0];
        expect(pass?.offset).toBe(0);
        expect(pass?.result?.offset).toBe(Buffer.byteLength(first));
    });

    it('a record that is not JSON, or has no session, is skipped without failing the rest', () => {
        const text = [
            'not json at all',
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'gh pr create' } }] },
            }),
        ].join('\n');
        expect(classifyTranscript({ executor: CLAUDE_CODE, chunks: [{ offset: 0, text }], repo: REPO })).toEqual([]);
    });

    it('an executor it cannot read yields nothing', () => {
        expect(
            classifyTranscript({
                executor: 'unknown-agent',
                chunks: [{ offset: 0, text: fixture('claude-gates.jsonl') }],
                repo: REPO,
            })
        ).toEqual([]);
    });
});
