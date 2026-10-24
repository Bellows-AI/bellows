import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTranscripts } from '../src/backfill/transcript-discovery.js';
import { parseTranscriptText, scanTranscripts } from '../src/backfill/transcript-usage.js';

let tmp: string;
let root: string;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'transcripts-'));
    root = join(tmp, 'projects');
    mkdirSync(root);
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

interface Rec {
    session?: string;
    id?: string;
    req?: string;
    at?: string;
    model?: string;
    usage?: Record<string, unknown>;
    extra?: Record<string, unknown>;
}
const rec = (r: Rec): string =>
    JSON.stringify({
        type: 'assistant',
        ...(r.session ? { sessionId: r.session } : {}),
        ...(r.req ? { requestId: r.req } : {}),
        timestamp: r.at ?? '2026-01-01T00:00:00.000Z',
        ...r.extra,
        message: {
            ...(r.id ? { id: r.id } : {}),
            ...(r.model ? { model: r.model } : {}),
            usage: r.usage ?? {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 4,
            },
        },
    });
const put = (rel: string, lines: string[] | string): string => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof lines === 'string' ? lines : `${lines.join('\n')}\n`);
    return file;
};

describe('discovery', () => {
    it('finds project and nested subagent layouts, sorted, and ignores the rest', () => {
        put('p1/s1.jsonl', [rec({ session: 's1' })]);
        put('p1/s1/subagents/agent-a.jsonl', [rec({ session: 's1' })]);
        put('p1/notes.txt', 'x');
        put('p1/s1/other/agent-b.jsonl', [rec({})]);
        const d = discoverTranscripts(root);
        expect(d.files.map((f) => [f.rel, f.layout, f.conversation, f.layoutParent])).toEqual([
            ['p1/s1.jsonl', 'project', 's1', null],
            ['p1/s1/subagents/agent-a.jsonl', 'subagent', 'agent-a', 's1'],
        ]);
        expect(d.complete).toBe(true);
    });

    it('refuses a symlink that resolves outside the root and reports it', () => {
        const outside = join(tmp, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'leak.jsonl'), `${rec({ session: 'x' })}\n`);
        mkdirSync(join(root, 'p1'));
        symlinkSync(join(outside, 'leak.jsonl'), join(root, 'p1', 'leak.jsonl'));
        symlinkSync(outside, join(root, 'linked'));
        const d = discoverTranscripts(root);
        expect(d.files).toEqual([]);
        expect(d.skipped.map((s) => [s.rel, s.reason]).sort()).toEqual([
            ['linked', 'symlink-escape'],
            ['p1/leak.jsonl', 'symlink-escape'],
        ]);
        expect(d.complete).toBe(false);
    });

    it('counts an in-root symlink alias once', () => {
        put('p1/s1.jsonl', [rec({ session: 's1' })]);
        symlinkSync(join(root, 'p1', 's1.jsonl'), join(root, 'p1', 'alias.jsonl'));
        expect(discoverTranscripts(root).files).toHaveLength(1);
    });

    it('reports a missing root as unreadable and incomplete', () => {
        const d = discoverTranscripts(join(tmp, 'absent'));
        expect(d).toEqual({ files: [], skipped: [{ rel: '.', reason: 'unreadable-root' }], complete: false });
    });

    it('reports an unreadable project directory and goes incomplete', () => {
        put('p1/s1.jsonl', [rec({ session: 's1' })]);
        chmodSync(join(root, 'p1'), 0o000);
        try {
            const d = discoverTranscripts(root);
            // Running as root can read anyway; the contract is: skipped iff unreadable.
            expect(d.complete).toBe(d.skipped.length === 0);
            if (d.skipped.length > 0) expect(d.skipped).toEqual([{ rel: 'p1', reason: 'unreadable-dir' }]);
        } finally {
            chmodSync(join(root, 'p1'), 0o755);
        }
    });
});

describe('parseTranscriptText', () => {
    it('counts malformed lines and flags a truncated tail without failing', () => {
        const text = `${rec({ id: 'm1' })}\nnot json\n${rec({ id: 'm2' }).slice(0, 40)}`;
        const p = parseTranscriptText(text);
        expect(p.records).toHaveLength(1);
        expect(p.malformed).toBe(2);
        expect(p.truncatedTail).toBe(true);
    });

    it('does not call a malformed middle line a truncated tail', () => {
        const p = parseTranscriptText(`bad\n${rec({ id: 'm1' })}\n`);
        expect(p).toMatchObject({ malformed: 1, truncatedTail: false });
    });
});

describe('scanTranscripts', () => {
    it('reports an unreadable file and an incomplete scan, keeping the rest', () => {
        const bad = put('p1/bad.jsonl', [rec({ session: 'bad', id: 'm1', req: 'r1' })]);
        put('p1/good.jsonl', [rec({ session: 'good', id: 'm2', req: 'r2' })]);
        chmodSync(bad, 0o000);
        try {
            const scan = scanTranscripts(root);
            const readable = scan.skipped.length === 0;
            expect(scan.complete).toBe(readable);
            expect(scan.events.length).toBe(readable ? 2 : 1);
            if (!readable) expect(scan.skipped).toEqual([{ rel: 'p1/bad.jsonl', reason: 'unreadable-entry' }]);
        } finally {
            chmodSync(bad, 0o644);
        }
    });

    it('dedupes a repeated message across records and copied files, keeping per-field max', () => {
        put('p1/s1.jsonl', [
            rec({ session: 's1', id: 'm1', req: 'r1', usage: { input_tokens: 5, output_tokens: 1 } }),
            rec({
                session: 's1',
                id: 'm1',
                req: 'r1',
                usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 7 },
            }),
        ]);
        put('p2/s1.jsonl', [rec({ session: 's1', id: 'm1', req: 'r1', usage: { input_tokens: 2, output_tokens: 9 } })]);
        const { events } = scanTranscripts(root);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tokens: { input: 5, output: 9, cacheRead: 7, cacheWrite: null },
            occurrences: 3,
            files: ['p1/s1.jsonl', 'p2/s1.jsonl'],
            identity: 'message',
            identityAmbiguous: false,
        });
    });

    it('gives the same event id and timestamp whatever order the evidence arrives in', () => {
        const a = rec({ session: 's1', id: 'm1', req: 'r1', at: '2026-01-01T00:00:05.000Z' });
        const b = rec({ session: 's1', id: 'm1', req: 'r1', at: '2026-01-01T00:00:01.000Z' });
        put('p1/s1.jsonl', [a, b]);
        const first = scanTranscripts(root).events[0];
        put('p1/s1.jsonl', [b, a]);
        const second = scanTranscripts(root).events[0];
        expect(first).toEqual(second);
        expect(first?.timestamp).toBe('2026-01-01T00:00:01.000Z');
        expect(first?.conflicts).toEqual(['timestamp']);
    });

    it('keeps two distinct messages that share a timestamp', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm1', req: 'r1' }), rec({ session: 's1', id: 'm2', req: 'r2' })]);
        const { events } = scanTranscripts(root);
        expect(events).toHaveLength(2);
        expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
    });

    it('scopes message identity to the session', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm1', req: 'r1' })]);
        put('p1/s2.jsonl', [rec({ session: 's2', id: 'm1', req: 'r1' })]);
        expect(scanTranscripts(root).events).toHaveLength(2);
    });

    it('reports model and query_source conflicts and picks them from the selected evidence', () => {
        put('p1/s1.jsonl', [
            rec({
                session: 's1',
                id: 'm1',
                req: 'r1',
                model: 'model-a',
                usage: { output_tokens: 1 },
                extra: { query_source: 'repl' },
            }),
            rec({ session: 's1', id: 'm1', req: 'r1', model: 'model-b', usage: { output_tokens: 8 } }),
        ]);
        const [e] = scanTranscripts(root).events;
        expect(e).toMatchObject({ model: 'model-b', querySource: null, conflicts: ['model', 'query_source'] });
    });

    it('preserves measured zeros and distinguishes them from absent fields', () => {
        put('p1/s1.jsonl', [
            rec({ session: 's1', id: 'm1', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }),
        ]);
        const [e] = scanTranscripts(root).events;
        expect(e?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: null });
    });

    it('never infers query source or TTL: an explicit field is kept, absence stays null', () => {
        put('p1/s1.jsonl', [
            rec({ session: 's1', id: 'm1', usage: { output_tokens: 1, query_source: 'subagent' } }),
            rec({
                session: 's1',
                id: 'm2',
                usage: { output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 4 } },
            }),
        ]);
        const byId = scanTranscripts(root).events.map((e) => e.querySource);
        expect(byId.sort()).toEqual([null, 'subagent']);
    });

    it('collapses byte-equivalent anonymous records and keeps distinguishable ones, both ambiguous', () => {
        put('p1/s1.jsonl', [
            rec({ session: 's1', usage: { output_tokens: 5 } }),
            rec({ session: 's1', usage: { output_tokens: 5 } }),
            rec({ session: 's1', usage: { output_tokens: 6 } }),
        ]);
        const { events } = scanTranscripts(root);
        expect(events).toHaveLength(2);
        expect(events.every((e) => e.identity === 'anonymous' && e.identityAmbiguous)).toBe(true);
        expect(events.map((e) => e.occurrences).sort()).toEqual([1, 2]);
    });

    it('drops records with no valid timestamp or no token field and counts them', () => {
        put('p1/s1.jsonl', [
            rec({ session: 's1', id: 'm1', at: 'garbage' }),
            rec({ session: 's1', id: 'm2', usage: {} }),
            rec({ session: 's1', id: 'm3' }),
        ]);
        const scan = scanTranscripts(root);
        expect(scan.events).toHaveLength(1);
        expect(scan.droppedRecords).toBe(2);
    });

    it('treats an invalid token value as absent and says so', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm1', usage: { input_tokens: -3, output_tokens: 2 } })]);
        const [e] = scanTranscripts(root).events;
        expect(e?.tokens).toMatchObject({ input: null, output: 2 });
        expect(e?.conflicts).toEqual(['invalid:input_tokens']);
    });

    it('reports malformed and truncated lines per file while keeping good records', () => {
        put('p1/s1.jsonl', `${rec({ session: 's1', id: 'm1' })}\n{"type":"assis`);
        const scan = scanTranscripts(root);
        expect(scan.events).toHaveLength(1);
        expect(scan.files[0]).toMatchObject({ malformedLines: 1, truncatedTail: true, usageRecords: 1 });
        expect(scan.complete).toBe(true);
    });

    it('joins a nested subagent to its parent session so a copy of a parent message dedupes', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm1', req: 'r1' })]);
        put('p1/s1/subagents/agent-a.jsonl', [
            rec({ session: 'agent-own-id', id: 'm1', req: 'r1' }),
            rec({ session: 'agent-own-id', id: 'm9', req: 'r9' }),
        ]);
        const scan = scanTranscripts(root);
        expect(scan.quarantined).toEqual([]);
        expect(scan.events).toHaveLength(2);
        expect(scan.events.every((e) => e.sessionId === 's1')).toBe(true);
        const child = scan.events.find((e) => e.occurrences === 1);
        expect(child?.conversation).toBe('agent-a');
        expect(scan.events.find((e) => e.occurrences === 2)?.files).toEqual([
            'p1/s1.jsonl',
            'p1/s1/subagents/agent-a.jsonl',
        ]);
    });

    it('quarantines a nested file whose parent main transcript is not in the scan', () => {
        put('p1/s1/subagents/agent-a.jsonl', [rec({ session: 's1', id: 'm1' }), rec({ session: 's1', id: 'm2' })]);
        const scan = scanTranscripts(root);
        expect(scan.events).toEqual([]);
        expect(scan.quarantined).toEqual([
            { rel: 'p1/s1/subagents/agent-a.jsonl', reason: 'parent-not-in-scan', layoutParent: 's1', records: 2 },
        ]);
    });

    it('does not take a parent from another project directory', () => {
        put('p2/s1.jsonl', [rec({ session: 's1', id: 'm0' })]);
        put('p1/s1/subagents/agent-a.jsonl', [rec({ session: 's1', id: 'm1' })]);
        expect(scanTranscripts(root).quarantined).toHaveLength(1);
    });

    it('quarantines when the parent transcript names more than one session', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm0' }), rec({ session: 'other', id: 'm1' })]);
        put('p1/s1/subagents/agent-a.jsonl', [rec({ session: 's1', id: 'm2' })]);
        expect(scanTranscripts(root).quarantined.map((q) => q.reason)).toEqual(['parent-session-unresolved']);
    });

    it('never derives a session from the project directory name', () => {
        put('org-acme-repo/s1.jsonl', [rec({ id: 'm1' })]);
        const [e] = scanTranscripts(root).events;
        expect(e?.sessionId).toBe('s1');
        expect(JSON.stringify({ ...e, files: [] })).not.toContain('acme');
    });

    it('emits only the four token fields and no message content', () => {
        put('p1/s1.jsonl', [rec({ session: 's1', id: 'm1', extra: { content: 'secret prompt text' } })]);
        const [e] = scanTranscripts(root).events;
        expect(Object.keys(e?.tokens ?? {}).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
        expect(JSON.stringify(e)).not.toContain('secret');
    });
});
