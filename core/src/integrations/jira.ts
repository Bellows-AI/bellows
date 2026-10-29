import { defineIntegration, type IntegrationDefinition, type IntegrationOperation } from './definition.js';

/**
 * The Jira Cloud adapter (3LO, classic scopes). Pure data and request builders: the board runs it through
 * `runOperation`, and the runner's Jira helper builds the same requests (docs/connections.md).
 */
export const JIRA_SCOPES = {
    read: ['read:jira-work', 'read:jira-user', 'offline_access'],
    write: ['write:jira-work'],
} as const;

/** The scopes to ask for: write consent is read consent plus `write:jira-work`. */
export const jiraScopesFor = (access: 'read' | 'write'): string[] =>
    access === 'write' ? [...JIRA_SCOPES.read, ...JIRA_SCOPES.write] : [...JIRA_SCOPES.read];

export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;
/** The comment property that ties a posted comment to its operation receipt: its value is the receipt's own unique id, never the logical key two roots can share. */
export const JIRA_OPERATION_PROPERTY = 'bellows-operation';

const DEFAULT_API_ORIGIN = 'https://api.atlassian.com';
const PATH_PREFIX = '/ex/jira';
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10;
const SEARCH_MAX_ITEMS = 200;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 10;
const COMMENT_MAX_ITEMS = 1000;

/** The REST v3 base for one site: `${apiOrigin}/ex/jira/${cloudId}/rest/api/3`. */
export const jiraApiBase = (apiOrigin: string, cloudId: string): string =>
    `${apiOrigin.replace(/\/+$/, '')}${PATH_PREFIX}/${cloudId}/rest/api/3`;

/** One ADF paragraph per line; an empty line is an empty paragraph, never an empty text node. */
export const jiraAdf = (text: string) => ({
    type: 'doc' as const,
    version: 1 as const,
    content: text.split('\n').map((line) => (line === '' ? { type: 'paragraph' as const } : paragraph(line))),
});
const paragraph = (line: string) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] });

export function createJiraIntegration(options: { apiOrigin?: string } = {}): IntegrationDefinition {
    const apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
    return defineIntegration({
        id: 'jira',
        kind: 'connection',
        capabilities: {
            read: JIRA_SCOPES.read.filter((scope) => scope !== 'offline_access'),
            write: [...JIRA_SCOPES.write],
        },
        api: { origin: () => apiOrigin, pathPrefix: PATH_PREFIX },
        skills: ['jira'],
    });
}

const issueKey = (key: string): string => {
    if (!JIRA_ISSUE_KEY.test(key)) throw new Error('not a Jira issue key');
    return key;
};

/** `{cloud}` is always the connection's resource, never an input. */
const base = (resource: { id: string }): string => `${PATH_PREFIX}/${encodeURIComponent(resource.id)}/rest/api/3`;

const withQuery = (path: string, params: URLSearchParams): string => {
    const query = params.toString();
    return query === '' ? path : `${path}?${query}`;
};

/** The path just read with one query parameter replaced. */
const withParam = (previousPath: string, name: string, value: string): string => {
    const url = new URL(previousPath, 'http://placeholder.invalid');
    url.searchParams.set(name, value);
    return `${url.pathname}${url.search}`;
};

const arrayOf = (json: unknown, field: string): readonly unknown[] => {
    const value = (json as Record<string, unknown> | null)?.[field];
    if (!Array.isArray(value)) throw new Error(`no ${field} array`);
    return value;
};

const getIssue: IntegrationOperation<{ key: string; fields?: readonly string[] }> = {
    name: 'getIssue',
    effect: 'read',
    requiredScopes: ['read:jira-work'],
    request: (input, resource) => {
        const params = new URLSearchParams();
        if (input.fields && input.fields.length > 0) params.set('fields', input.fields.join(','));
        return { method: 'GET', path: withQuery(`${base(resource)}/issue/${issueKey(input.key)}`, params) };
    },
};

const searchIssues: IntegrationOperation<{ jql: string; fields?: readonly string[]; maxResults?: number }> = {
    name: 'searchIssues',
    effect: 'read',
    requiredScopes: ['read:jira-work'],
    request: (input, resource) => {
        const params = new URLSearchParams({ jql: input.jql });
        if (input.fields && input.fields.length > 0) params.set('fields', input.fields.join(','));
        const size = Math.min(Math.max(Math.floor(input.maxResults ?? SEARCH_PAGE_SIZE), 1), SEARCH_MAX_PAGE_SIZE);
        params.set('maxResults', String(size));
        return { method: 'GET', path: withQuery(`${base(resource)}/search/jql`, params) };
    },
    paginate: {
        maxPages: SEARCH_MAX_PAGES,
        maxItems: SEARCH_MAX_ITEMS,
        items: (json) => arrayOf(json, 'issues'),
        next: (json, previousPath) => {
            const page = json as { nextPageToken?: unknown; isLast?: unknown };
            if (page.isLast === true || typeof page.nextPageToken !== 'string' || page.nextPageToken === '') {
                return null;
            }
            return withParam(previousPath, 'nextPageToken', page.nextPageToken);
        },
    },
};

const listComments: IntegrationOperation<{ key: string }> = {
    name: 'listComments',
    effect: 'read',
    requiredScopes: ['read:jira-work'],
    request: (input, resource) => ({
        method: 'GET',
        path: `${base(resource)}/issue/${issueKey(input.key)}/comment?startAt=0&maxResults=${COMMENT_PAGE_SIZE}&orderBy=created`,
    }),
    paginate: {
        maxPages: COMMENT_MAX_PAGES,
        maxItems: COMMENT_MAX_ITEMS,
        items: (json) => arrayOf(json, 'comments'),
        next: (json, previousPath) => {
            const comments = arrayOf(json, 'comments');
            const total = (json as { total?: unknown }).total;
            const startAt = Number(new URL(previousPath, 'http://placeholder.invalid').searchParams.get('startAt'));
            if (typeof total !== 'number' || !Number.isInteger(startAt) || comments.length === 0) return null;
            const following = startAt + comments.length;
            return following < total ? withParam(previousPath, 'startAt', String(following)) : null;
        },
    },
};

const addComment: IntegrationOperation<{ key: string; body: string; receiptId: string }> = {
    name: 'addComment',
    effect: 'write',
    requiredScopes: ['write:jira-work'],
    request: (input, resource) => {
        if (input.body === '' || input.receiptId === '') throw new Error('a comment needs a body and a key');
        return {
            method: 'POST',
            path: `${base(resource)}/issue/${issueKey(input.key)}/comment`,
            body: {
                body: jiraAdf(input.body),
                properties: [{ key: JIRA_OPERATION_PROPERTY, value: { receipt: input.receiptId } }],
            },
        };
    },
};

const myself: IntegrationOperation<Record<string, never>> = {
    name: 'myself',
    effect: 'read',
    requiredScopes: ['read:jira-user'],
    request: (_input, resource) => ({ method: 'GET', path: `${base(resource)}/myself` }),
};

export const JIRA_OPERATIONS = { getIssue, searchIssues, listComments, addComment, myself } as const;
