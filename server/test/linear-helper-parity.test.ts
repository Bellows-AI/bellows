import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { classifyLinearAnswer, LINEAR_OPERATIONS, linearAnswerShape, linearNotFound } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';

/**
 * The runner's Linear helper builds its own GraphQL requests and reads its own answers (the driver imports nothing
 * from core). This pins it to the core: for each operation and a table of inputs the same request, the same next
 * page, the same scopes, and the same verdict on every GraphQL answer the core classifier names.
 */

const HELPER = join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    '..',
    'docker',
    'skills',
    'factory-linear',
    'linear.cjs'
);
interface Request {
    method: string;
    path: string;
    body?: unknown;
}
const helper = createRequire(import.meta.url)(HELPER) as {
    requestFor: (op: string, input: unknown) => Request;
    nextRequest: (op: string, json: unknown, previous: Request) => Request | null;
    classify: (json: unknown, op: { name: string; effect: string }, status: number) => unknown;
    answerShape: (op: string, json: unknown, request: Request) => boolean;
    notFound: (op: string, json: unknown) => boolean;
    REQUIRED_SCOPES: Record<string, string[]>;
};

type Op = (typeof LINEAR_OPERATIONS)[keyof typeof LINEAR_OPERATIONS];
const RECEIPT = '55555555-5555-4555-8555-000000000001';

const CASES: [string, Record<string, unknown>][] = [
    ['getIssue', { key: 'ABC-1' }],
    ['getIssue', { key: '0f8a2b3c-1d2e-4f50-8a6b-7c8d9e0f1a2b' }],
    ['searchIssues', { team: 'ENG' }],
    ['searchIssues', { team: 'ENG', state: 'In Progress', assignee: 'me', label: 'Bug', project: 'X', text: 'a "b"' }],
    ['searchIssues', { assignee: 'someone@example.com', first: 5000 }],
    ['searchIssues', { text: 'x', first: 0 }],
    ['searchIssues', { team: '', state: 'Done' }],
    ['listComments', { key: 'ABC-12' }],
    ['addComment', { key: 'ABC-1', body: 'one', receiptId: RECEIPT }],
    ['addComment', { key: 'ABC-1', body: 'one\n\nthree "quoted" <b>', receiptId: RECEIPT }],
    ['viewer', {}],
];

describe('the Linear helper requests equal the core operations', () => {
    it.each(CASES)('%s %j', (name, input) => {
        const op = LINEAR_OPERATIONS[name as keyof typeof LINEAR_OPERATIONS] as Op;
        expect(helper.requestFor(name, input)).toEqual((op.request as (i: unknown, r: unknown) => unknown)(input, {}));
    });

    it.each([
        ['getIssue', { key: 'ABC' }],
        ['getIssue', { key: 'abc-1' }],
        ['getIssue', { key: 'ABC-0' }],
        ['getIssue', { key: '../ABC-1' }],
        ['searchIssues', {}],
        ['searchIssues', { team: '', text: '' }],
        ['addComment', { key: 'ABC-1', body: '', receiptId: RECEIPT }],
        ['addComment', { key: 'ABC-1', body: 'x', receiptId: 'k1' }],
    ])('refuses %s %j like core does', (name, input) => {
        const op = LINEAR_OPERATIONS[name as keyof typeof LINEAR_OPERATIONS] as Op;
        expect(() => (op.request as (i: unknown, r: unknown) => unknown)(input, {})).toThrow();
        expect(() => helper.requestFor(name, input)).toThrow();
    });

    it.each(Object.keys(LINEAR_OPERATIONS))('requires the same scopes for %s', (name) => {
        expect(helper.REQUIRED_SCOPES[name]).toEqual([
            ...LINEAR_OPERATIONS[name as keyof typeof LINEAR_OPERATIONS].requiredScopes,
        ]);
    });

    it('follows the same next page as core pagination', () => {
        const page = (path: string[], pageInfo: unknown) => {
            let at: unknown = { nodes: [{}], pageInfo };
            for (const field of [...path].reverse()) at = { [field]: at };
            return { data: at };
        };
        const infos = [
            { hasNextPage: true, endCursor: 'c1' },
            { hasNextPage: false, endCursor: 'c1' },
            { hasNextPage: false, endCursor: null },
            { hasNextPage: false },
        ];
        for (const [name, path, input] of [
            ['searchIssues', ['issues'], { team: 'ENG' }],
            ['listComments', ['issue', 'comments'], { key: 'ABC-1' }],
        ] as const) {
            const op = LINEAR_OPERATIONS[name];
            const previous = helper.requestFor(name, input);
            for (const info of infos) {
                const json = page([...path], info);
                expect(helper.nextRequest(name, json, previous)).toEqual(
                    op.paginate?.next(json, previous as never) ?? null
                );
            }
            for (const info of [
                { hasNextPage: true, endCursor: '' },
                { hasNextPage: true },
                { endCursor: 'c' },
                null,
            ]) {
                const json = page([...path], info);
                expect(() => op.paginate?.next(json, previous as never)).toThrow();
                expect(() => helper.nextRequest(name, json, previous)).toThrow();
            }
            const following = { ...previous, body: { ...(previous.body as object), variables: { after: 'zz' } } };
            const json = page([...path], infos[0]);
            expect(helper.nextRequest(name, json, following)).toEqual(
                op.paginate?.next(json, following as never) ?? null
            );
        }
    });
});

describe('the Linear helper reads a GraphQL answer like the core classifier', () => {
    const err = (extra: Record<string, unknown>) => ({ errors: [{ message: 'x', ...extra }] });
    const ANSWERS: [string, unknown][] = [
        ['data only', { data: { issue: {} } }],
        ['authentication code', err({ extensions: { code: 'AUTHENTICATION_ERROR' } })],
        ['authentication type', err({ extensions: { type: 'authentication error' } })],
        ['forbidden', err({ extensions: { code: 'FORBIDDEN' } })],
        ['rate limited', err({ extensions: { code: 'RATELIMITED' } })],
        ['entity not found', err({ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } })],
        ['an unnamed error', err({ extensions: { code: 'INTERNAL' } })],
        ['an error without extensions', err({})],
        [
            'two errors, the decisive second',
            { errors: [{ message: 'a' }, { message: 'b', extensions: { code: 'FORBIDDEN' } }] },
        ],
        ['no data', {}],
        ['data not an object', { data: [] }],
        ['an empty errors array', { errors: [], data: { x: 1 } }],
        ['not an object', 'text'],
        ['null', null],
    ];
    const OPS = [
        { name: 'getIssue', effect: 'read' },
        { name: 'addComment', effect: 'write' },
    ];
    for (const status of [200, 400, 404]) {
        for (const op of OPS) {
            it.each(ANSWERS)(`${status} ${op.name}: %s`, (_label, json) => {
                expect(helper.classify(json, op, status)).toEqual(classifyLinearAnswer(json, op as never, status));
            });
        }
    }
});

/** The answer-shape fixtures core's own suite runs (core/test/fixtures/linear-answers.json): one verdict on both sides. */
type Fixture = { label: string; json: unknown };
const SHAPES = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/linear-answers.json', import.meta.url), 'utf8')
) as Record<string, { input: unknown; accept: Fixture[]; reject: Fixture[] }>;

describe('the Linear helper accepts and refuses the same answer shapes as core', () => {
    for (const [name, table] of Object.entries(SHAPES).filter(([name]) => name in LINEAR_OPERATIONS)) {
        const op = LINEAR_OPERATIONS[name as keyof typeof LINEAR_OPERATIONS] as Op;
        const request = (op.request as (i: unknown, r: unknown) => Request)(table.input, {});
        const verdict = (json: unknown) => ({
            classified: classifyLinearAnswer(json, op, 200),
            shaped: linearAnswerShape(name, json, request as never),
        });
        it.each(table.accept.map((f) => [f.label, f.json]))(`${name} accepts %s`, (_label, json) => {
            expect(verdict(json)).toEqual({ classified: null, shaped: true });
            expect(helper.classify(json, op, 200)).toBeNull();
            expect(helper.answerShape(name, json, request)).toBe(true);
        });
        it.each(table.reject.map((f) => [f.label, f.json]))(`${name} refuses %s`, (_label, json) => {
            const core = verdict(json);
            expect(core.classified !== null || !core.shaped).toBe(true);
            expect(helper.classify(json, op, 200)).toEqual(core.classified);
            expect(helper.answerShape(name, json, request)).toBe(core.shaped);
        });
    }
});

describe('the Linear helper names a not-found exactly as core does', () => {
    const table = (SHAPES as unknown as { notFound: { label: string; op: string; json: unknown; notFound: boolean }[] })
        .notFound;
    it.each(table.map((f) => [f.op, f.label, f]))('%s: %s', (_op, _label, fixture) => {
        const { op, json, notFound } = fixture as { op: string; json: unknown; notFound: boolean };
        expect(linearNotFound(op, json)).toBe(notFound);
        expect(helper.notFound(op, json)).toBe(notFound);
        const operation = LINEAR_OPERATIONS[op as keyof typeof LINEAR_OPERATIONS] as Op;
        for (const status of [200, 400]) {
            expect(helper.classify(json, operation, status)).toEqual(classifyLinearAnswer(json, operation, status));
        }
    });
});
