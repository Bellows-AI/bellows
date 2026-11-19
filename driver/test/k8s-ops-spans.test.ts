import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './fixtures/repo-files.js';

const SCRIPT = join(REPO_ROOT, 'scripts/k8s-ops-spans.mjs');
const POD_ATTRIBUTES = { 'k8s.pod.name': 'pod-1', 'k8s.namespace.name': 'ns-1', 'service.instance.id': 'pod-1' };

const attribute = ([key, value]: [string, string]) => ({ key, value: { stringValue: value } });
const resource = (service: string, traceId: string, attributes: Record<string, string> = POD_ATTRIBUTES) => ({
    resourceSpans: [
        {
            resource: { attributes: Object.entries({ 'service.name': service, ...attributes }).map(attribute) },
            scopeSpans: [{ spans: [{ traceId, spanId: 's1', name: 'op' }] }],
        },
    ],
});
const lines = (...docs: unknown[]) => docs.map((doc) => `${JSON.stringify(doc)}\n`).join('');

const read = (stdin: string): Promise<{ out: string; code: number | null }> =>
    new Promise((resolve, reject) => {
        const child = spawn('node', [SCRIPT]);
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ out: out.trim(), code }));
        child.stdin.end(stdin);
    });

// The kind lane pipes the file exporter's JSONL through this: only a fully parsed file can say a span
// is missing; anything unreadable is `unread`, which the lane retries.
describe('scripts/k8s-ops-spans.mjs', () => {
    it('joins a board and a driver span that share a trace and carry the pod attributes', async () => {
        const result = await read(lines(resource('bellows-board', 'trace-a'), resource('bellows-driver', 'trace-a')));
        expect(result).toEqual({ out: 'joined trace-a', code: 0 });
    });

    it('says missing: join when the two are in different traces', async () => {
        const result = await read(lines(resource('bellows-board', 'trace-a'), resource('bellows-driver', 'trace-b')));
        expect(result).toEqual({ out: 'missing: join', code: 1 });
    });

    it('says missing: board when only driver spans arrived', async () => {
        const result = await read(lines(resource('bellows-driver', 'trace-a')));
        expect(result).toEqual({ out: 'missing: board', code: 1 });
    });

    it('says missing: resource-attributes when a resource lacks service.instance.id', async () => {
        const { 'service.instance.id': _dropped, ...partial } = POD_ATTRIBUTES;
        const result = await read(
            lines(resource('bellows-board', 'trace-a', partial), resource('bellows-driver', 'trace-a'))
        );
        expect(result).toEqual({ out: 'missing: resource-attributes', code: 1 });
    });

    it('says unread, never missing, for empty input', async () => {
        const result = await read('');
        expect(result.out).toMatch(/^unread: /);
        expect(result.code).toBe(1);
    });

    it('says unread for a malformed terminated line', async () => {
        const result = await read(`${lines(resource('bellows-board', 'trace-a'))}{not json\n`);
        expect(result.out).toMatch(/^unread: /);
        expect(result.code).toBe(1);
    });

    it("ignores the exporter's unterminated trailing fragment", async () => {
        const whole = lines(resource('bellows-board', 'trace-a'), resource('bellows-driver', 'trace-a'));
        expect(await read(`${whole}{"resourceSpans":[{"reso`)).toEqual({ out: 'joined trace-a', code: 0 });
    });
});
