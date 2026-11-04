import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from '../src/mcp/registry.js';

/**
 * The registry as a client sees it: every tool's name, scope, annotation hints and a hash of its input and output
 * JSON Schema. Changing, adding or removing a tool changes this table, so the change has to be made on purpose, in
 * the same diff. The agent-facing description is deliberately not part of it: wording is tuned without moving the
 * contract. To update, run this file, copy the printed rows over `EXPECTED`, and review each moved row.
 */

const HASH_CHARS = 12;

const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
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
    'accept_batch_task | factory:write | FFFF | 785bfc976459 | 54ee742efec5',
    'answer_question | factory:write | FFFF | d0e9426b8139 | 16603f19b2ae',
    'batch_report | factory:read | TFTF | dae32af0c4ba | 9795e45ae704',
    'cancel_batch | factory:write | FTFF | dae32af0c4ba | 54ee742efec5',
    'create_attachment_upload | factory:write | FFFF | eaaa9ed5ddb3 | fff71c9bde4b',
    'create_task | factory:write | FFFF | 06b434006719 | 2ebd99310448',
    'edit_task | factory:write | FFFF | e02a1c23010b | b7cd8656b730',
    'follow_up_task | factory:write | FFFF | 5b6ed0524a41 | 2ebd99310448',
    'force_close_task | factory:write | FTFF | c9673798baf8 | b6edbc0315b3',
    'get_batch_tasks | factory:read | TFTF | 3688093b6dde | ccb76e4c7fa8',
    'get_task | factory:read | TFTF | 501e36454c04 | 0ad0025b3c61',
    'get_task_result | factory:read | TFTF | 501e36454c04 | 074410ef8241',
    'import_batch | factory:write | FFFF | 431c89a960dd | c381928a59e9',
    'inspect_batch | factory:read | TFTF | dae32af0c4ba | 54ee742efec5',
    'investigate_job | factory:read | TFTF | c9673798baf8 | ea5b20c17b20',
    'job_activity | factory:read | TFTF | c9673798baf8 | 75e92f2ea840',
    'list_available_integrations | factory:read | TFTF | 377a21691c8f | 9c2e193f010d',
    'list_batches | factory:read | TFTF | 71fc596a20f2 | cc79b4c71821',
    'list_connections | factory:read | TFTF | 71fc596a20f2 | 8453cda99599',
    'list_executors | factory:read | TFTF | 71fc596a20f2 | 1ece3afe12c1',
    'list_job_streams | factory:read | TFTF | f03f91f27f26 | 58c30158b2e8',
    'list_jobs | factory:read | TFTF | ba9c18ff4c18 | 999c08e43d58',
    'list_questions | factory:read | TFTF | c9673798baf8 | b5999d16a780',
    'list_repos | factory:read | TFTF | 6ec29bafc1c7 | b128f3f3b1cd',
    'list_skills | factory:read | TFTF | 71fc596a20f2 | 465cf7f9c249',
    'list_tasks | factory:read | TFTF | 499812f29fb6 | 044beba5aea8',
    'mark_task_done | factory:write | FFFF | c9673798baf8 | b6edbc0315b3',
    'preflight_task | factory:read | TFTF | 376bbbaa5024 | e074f939b084',
    'read_job_log | factory:read | TFTF | 6745afe0c9f0 | 5f0391c1a14d',
    'remove_task | factory:write | FTFF | c9673798baf8 | 6ce8b45da5b4',
    'reopen_task | factory:write | FFTF | c9673798baf8 | 8a4d3e663f7b',
    'retry_batch_task | factory:write | FFFF | 785bfc976459 | 54ee742efec5',
    'retry_task | factory:write | FFFF | 364918f9c96c | 2ebd99310448',
    'start_batch | factory:write | FFFF | 17eb006c500c | 54ee742efec5',
    'stop_task | factory:write | FTFF | c9673798baf8 | fe46880c0bac',
    'update_batch | factory:write | FFFF | 584132dd00ec | c381928a59e9',
    'validate_batch | factory:read | TFTF | dae32af0c4ba | 9f2681a7829e',
    'wait_batch | factory:read | TFTF | 441fec55e00f | 743559ff062c',
    'wait_task | factory:read | TFTF | 73e08bc3b660 | 38a021624b86',
    'whoami | factory:read | TFTF | 71fc596a20f2 | ca0dcfcb18f0',
];

describe('the tool registry snapshot', () => {
    it('matches the reviewed table, row for row', () => {
        const actual = rows();
        expect(actual, `the registry moved; rows are now:\n${actual.join('\n')}`).toEqual(EXPECTED);
    });
});
