import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JIRA_OPERATIONS } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';

/**
 * The runner's Jira helper builds its own requests (the driver imports nothing from core). This pins it to the core
 * operations: for each operation and a table of inputs, the same method, path and body, and the same next page.
 */

const HELPER = join(fileURLToPath(import.meta.url), '..', '..', '..', 'docker', 'skills', 'jira', 'jira.cjs');
const helper = createRequire(import.meta.url)(HELPER) as {
    requestFor: (op: string, input: unknown, cloudId: string) => { method: string; path: string; body?: unknown };
    nextPath: (op: string, json: unknown, previousPath: string) => string | null;
    REQUIRED_SCOPES: Record<string, string[]>;
};

const CLOUD = 'cloud-a';
const resource = { id: CLOUD, label: 'stub' };
type Op = (typeof JIRA_OPERATIONS)[keyof typeof JIRA_OPERATIONS];

const CASES: [string, Record<string, unknown>][] = [
    ['getIssue', { key: 'ABC-1' }],
    ['getIssue', { key: 'ABC-1', fields: ['summary', 'status'] }],
    ['searchIssues', { jql: "project = ABC AND status = 'In Progress' ORDER BY updated DESC" }],
    ['searchIssues', { jql: 'a & b = "c"', fields: ['summary'], maxResults: 25 }],
    ['searchIssues', { jql: 'x', maxResults: 5000 }],
    ['listComments', { key: 'ABC-12' }],
    ['addComment', { key: 'ABC-1', body: 'one', receiptId: 'k1' }],
    ['addComment', { key: 'ABC-1', body: 'one\n\nthree "quoted" <b>', receiptId: 'k:2.x' }],
    ['myself', {}],
];

describe('the Jira helper requests equal the core operations', () => {
    it.each(CASES)('%s %j', (name, input) => {
        const op = JIRA_OPERATIONS[name as keyof typeof JIRA_OPERATIONS] as Op;
        expect(helper.requestFor(name, input, CLOUD)).toEqual(
            (op.request as (i: unknown, r: unknown) => unknown)(input, resource)
        );
    });

    it.each(['ABC', 'abc-1', 'ABC-0', 'ABC-1/../x', '../ABC-1'])('rejects the key %s like core does', (key) => {
        expect(() => JIRA_OPERATIONS.getIssue.request({ key }, resource)).toThrow();
        expect(() => helper.requestFor('getIssue', { key }, CLOUD)).toThrow();
    });

    it.each(Object.keys(JIRA_OPERATIONS))('requires the same scopes for %s', (name) => {
        expect(helper.REQUIRED_SCOPES[name]).toEqual([
            ...JIRA_OPERATIONS[name as keyof typeof JIRA_OPERATIONS].requiredScopes,
        ]);
    });

    it('follows the same next page as core pagination', () => {
        const search = JIRA_OPERATIONS.searchIssues.paginate;
        const path = `/ex/jira/${CLOUD}/rest/api/3/search/jql?jql=x&maxResults=50`;
        for (const json of [
            { issues: [], nextPageToken: 'abc' },
            { issues: [], nextPageToken: 'abc', isLast: true },
            { issues: [], nextPageToken: '' },
            { issues: [] },
        ]) {
            expect(helper.nextPath('searchIssues', json, path)).toEqual(search?.next(json, path));
        }
        const comments = JIRA_OPERATIONS.listComments.paginate;
        const cpath = `/ex/jira/${CLOUD}/rest/api/3/issue/ABC-1/comment?startAt=0&maxResults=100&orderBy=created`;
        for (const json of [
            { comments: new Array(100).fill({}), total: 250 },
            { comments: new Array(50).fill({}), total: 50 },
            { comments: [], total: 10 },
            { comments: [{}], total: 'x' },
        ]) {
            expect(helper.nextPath('listComments', json, cpath)).toEqual(comments?.next(json, cpath));
        }
    });
});
