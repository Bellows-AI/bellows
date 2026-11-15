import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from '../src/mcp/registry.js';

/**
 * The registry as a client sees it: every tool's name, scope, annotation hints and a hash of its input and output
 * JSON Schema. Changing, adding or removing a tool changes this table, so the change has to be made on purpose, in
 * the same diff. Descriptions (the tool's and every parameter's) are deliberately not part of it: wording is tuned without moving the
 * contract. To update, run this file, copy the printed rows over `EXPECTED`, and review each moved row.
 */

const HASH_CHARS = 12;

const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key, inner]) => !(key === 'description' && typeof inner === 'string'))
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, inner]) => [key, canonical(inner)])
        );
    }
    return value;
};

const hashOf = (schema: z.ZodObject): string =>
    createHash('sha256')
        .update(JSON.stringify(canonical(z.toJSONSchema(schema))))
        .digest('hex')
        .slice(0, HASH_CHARS);

const hint = (value: boolean | undefined): string => (value === undefined ? '-' : value ? 'T' : 'F');

/** `name | scope | readOnly destructive idempotent openWorld | input hash | output hash` */
const rows = (): string[] =>
    TOOLS.map((tool) => {
        const a = tool.annotations;
        const hints = [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint].map(hint).join('');
        return `${tool.name} | ${tool.scope} | ${hints} | ${hashOf(tool.input)} | ${hashOf(tool.output)}`;
    });

const EXPECTED: string[] = [
    'accept_batch_task | factory:write | FFFF | ca3d2cf3babe | 54ee742efec5',
    'answer_question | factory:write | FFFF | 88681098d683 | 16603f19b2ae',
    'batch_report | factory:read | TFTF | f80d1925ae9f | 9795e45ae704',
    'cancel_batch | factory:write | FTFF | f80d1925ae9f | 54ee742efec5',
    'create_attachment_upload | factory:write | FFFF | 8f5a783aa090 | fff71c9bde4b',
    'create_task | factory:write | FFFF | 8880012a59ab | 2ebd99310448',
    'edit_task | factory:write | FFFF | 168c15bf3a98 | b7cd8656b730',
    'follow_up_task | factory:write | FFFF | d13990714412 | 2ebd99310448',
    'force_close_task | factory:write | FTFF | 8d0cb9539b48 | b6edbc0315b3',
    'get_batch_tasks | factory:read | TFTF | aa773353f2f9 | 69514bed733a',
    'get_task | factory:read | TFTF | 2fdf7e6a8ae9 | 276323609f34',
    'get_task_result | factory:read | TFTF | 2fdf7e6a8ae9 | 9791ab58294f',
    'import_batch | factory:write | FFFF | e80dc00c76d5 | c381928a59e9',
    'inspect_batch | factory:read | TFTF | f80d1925ae9f | 54ee742efec5',
    'investigate_job | factory:read | TFTF | 8d0cb9539b48 | ea5b20c17b20',
    'job_activity | factory:read | TFTF | 8d0cb9539b48 | 75e92f2ea840',
    'list_available_integrations | factory:read | TFTF | 7a317ebd6090 | 9c2e193f010d',
    'list_batches | factory:read | TFTF | 71fc596a20f2 | cc79b4c71821',
    'list_connections | factory:read | TFTF | 71fc596a20f2 | 8453cda99599',
    'list_executors | factory:read | TFTF | 71fc596a20f2 | 746a83f22cdf',
    'list_job_streams | factory:read | TFTF | 257f7ca675cd | 58c30158b2e8',
    'list_jobs | factory:read | TFTF | 267bfc48d597 | 999c08e43d58',
    'list_questions | factory:read | TFTF | 8d0cb9539b48 | b5999d16a780',
    'list_repos | factory:read | TFTF | 95ab2351a7f7 | b128f3f3b1cd',
    'list_skills | factory:read | TFTF | d3e0132a38ab | 9e46eb968431',
    'list_tasks | factory:read | TFTF | e5a4de69c262 | 044beba5aea8',
    'mark_task_done | factory:write | FFFF | 8d0cb9539b48 | b6edbc0315b3',
    'preflight_task | factory:read | TFTF | ba132642f57c | e074f939b084',
    'read_job_log | factory:read | TFTF | 00a2dd52cc96 | 5f0391c1a14d',
    'remove_task | factory:write | FTFF | 8d0cb9539b48 | 6ce8b45da5b4',
    'reopen_task | factory:write | FFTF | 8d0cb9539b48 | 8a4d3e663f7b',
    'retry_batch_task | factory:write | FFFF | ca3d2cf3babe | 54ee742efec5',
    'retry_task | factory:write | FFFF | 178f76e58a2f | 2ebd99310448',
    'start_batch | factory:write | FFFF | 1c086ed804c3 | 54ee742efec5',
    'stop_task | factory:write | FTFF | 8d0cb9539b48 | fe46880c0bac',
    'update_batch | factory:write | FFFF | 1100dcfb34b2 | c381928a59e9',
    'validate_batch | factory:read | TFTF | f80d1925ae9f | 9f2681a7829e',
    'wait_batch | factory:read | TFTF | 4c125c6cbe9f | f523ff45ed50',
    'wait_task | factory:read | TFTF | bafb22317ae6 | 6f6be05b6a31',
    'whoami | factory:read | TFTF | 71fc596a20f2 | ca0dcfcb18f0',
];

describe('the tool registry snapshot', () => {
    it('matches the reviewed table, row for row', () => {
        const actual = rows();
        expect(actual, `the registry moved; rows are now:\n${actual.join('\n')}`).toEqual(EXPECTED);
    });
});
