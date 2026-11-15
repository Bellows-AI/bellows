import {
    defineIntegration,
    type IntegrationDefinition,
    type IntegrationOperation,
    type OperationRequest,
    type Pagination,
} from './definition.js';
import type { IntegrationOutcome } from './outcomes.js';

/**
 * The Linear adapter (OAuth2, `actor=user`). Pure data and GraphQL request builders: the board runs them through
 * `runOperation`, and a GraphQL failure (a 200 with `errors`) is a closed outcome via `classifyLinearAnswer`.
 */
export const LINEAR_SCOPES = {
    read: ['read'],
    write: ['write'],
} as const;

/** The scopes to ask for: write consent is read consent plus `write`. */
export const linearScopesFor = (access: 'read' | 'write'): string[] =>
    access === 'write' ? [...LINEAR_SCOPES.read, ...LINEAR_SCOPES.write] : [...LINEAR_SCOPES.read];

/** A team-key issue identifier (`ENG-123`); Linear's `issueId` also takes the issue UUID (`LINEAR_UUID`). */
export const LINEAR_ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;
export const LINEAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEFAULT_API_ORIGIN = 'https://api.linear.app';
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const PATH_PREFIX = '/graphql';
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10;
const SEARCH_MAX_ITEMS = 200;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 10;
const COMMENT_MAX_ITEMS = 1000;

/** The GraphQL endpoint: `${apiOrigin}/graphql`. */
export const linearApiBase = (apiOrigin: string): string => `${apiOrigin.replace(/\/+$/, '')}${PATH_PREFIX}`;

const ISSUE_FIELDS =
    'id identifier title url priority createdAt updatedAt state { name type } assignee { id name email } ' +
    'team { key name } project { name } labels { nodes { name } }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const GET_ISSUE = `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description } }`;
const SEARCH_ISSUES =
    'query SearchIssues($filter: IssueFilter, $first: Int, $after: String) { ' +
    `issues(filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`;
const LIST_COMMENTS =
    'query ListComments($id: String!, $first: Int, $after: String) { issue(id: $id) { ' +
    `comments(first: $first, after: $after) { nodes { id body url createdAt updatedAt user { id name email } } ${PAGE_INFO} } } }`;
const ADD_COMMENT =
    'mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url createdAt } } }';
const VIEWER = 'query Viewer { viewer { id name email organization { id name urlKey } } }';

interface GraphqlBody {
    query: string;
    variables: Record<string, unknown>;
}

const graphql = (query: string, variables: Record<string, unknown>): OperationRequest => ({
    method: 'POST',
    path: PATH_PREFIX,
    body: { query, variables } satisfies GraphqlBody,
});

export function createLinearIntegration(options: { apiOrigin?: string } = {}): IntegrationDefinition {
    const apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
    return defineIntegration({
        id: 'linear',
        kind: 'connection',
        capabilities: { read: [...LINEAR_SCOPES.read], write: [...LINEAR_SCOPES.write] },
        api: { origin: () => apiOrigin, pathPrefix: PATH_PREFIX },
        skills: ['factory-linear'],
        classifyAnswer: classifyLinearAnswer,
    });
}

const issueRef = (key: string): string => {
    if (!LINEAR_ISSUE_KEY.test(key) && !LINEAR_UUID.test(key)) throw new Error('not a Linear issue key or id');
    return key;
};

const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The GraphQL connection at `data.<path>`; throws when the answer has none. */
const connectionAt = (json: unknown, path: readonly string[]): { nodes: unknown[]; pageInfo: unknown } => {
    let at: unknown = record(json)?.data;
    for (const field of path) at = record(at)?.[field];
    const nodes = record(at)?.nodes;
    if (!Array.isArray(nodes)) throw new Error(`no ${path.join('.')} nodes`);
    return { nodes, pageInfo: record(at)?.pageInfo };
};

/**
 * Relay pagination: the same query with `variables.after` set to the page's `endCursor`. Only `hasNextPage: false`
 * ends the list; missing or odd page metadata throws (malformed), never reads as "that was everything".
 */
const cursorPages = (path: readonly string[], maxPages: number, maxItems: number): Pagination => ({
    maxPages,
    maxItems,
    items: (json) => connectionAt(json, path).nodes,
    next: (json, previous) => {
        const info = record(connectionAt(json, path).pageInfo);
        if (info?.hasNextPage === false) return null;
        const cursor = info?.endCursor;
        if (info?.hasNextPage !== true || typeof cursor !== 'string' || cursor === '') {
            throw new Error(`malformed ${path.join('.')} pageInfo`);
        }
        const body = previous.body as GraphqlBody;
        return { ...previous, body: { ...body, variables: { ...body.variables, after: cursor } } };
    },
});

// ---- Answer shapes: one per operation, checked before any success ----

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
const objectOrNull = (value: unknown): boolean => value === null || record(value) !== null;
/** The issue's nested objects the helper prints: each present, and an object or null. */
const ISSUE_OBJECTS = ['state', 'assignee', 'team', 'project', 'labels'] as const;

const issueShape = (value: unknown): boolean => {
    const issue = record(value);
    return (
        issue !== null &&
        text(issue.id) &&
        text(issue.identifier) &&
        typeof issue.title === 'string' &&
        ISSUE_OBJECTS.every((field) => field in issue && objectOrNull(issue[field])) &&
        (issue.description === null || typeof issue.description === 'string')
    );
};

/** A relay page: every node an object with a string id; only `hasNextPage: false` or a next cursor. */
const pageShape = (value: unknown): boolean => {
    const page = record(value);
    const info = record(page?.pageInfo);
    const nodes = page?.nodes;
    return (
        Array.isArray(nodes) &&
        nodes.every((node) => text(record(node)?.id)) &&
        (info?.hasNextPage === false || (info?.hasNextPage === true && text(info.endCursor)))
    );
};

const SHAPES: Record<string, (data: Record<string, unknown>, request: OperationRequest) => boolean> = {
    getIssue: (data) => issueShape(data.issue),
    searchIssues: (data) => pageShape(data.issues),
    listComments: (data) => pageShape(record(data.issue)?.comments),
    addComment: (data, request) => {
        const created = record(data.commentCreate);
        const id = record(created?.comment)?.id;
        const sent = record(record((request.body as GraphqlBody | undefined)?.variables)?.input)?.id;
        return created?.success === true && text(id) && id === sent;
    },
    viewer: (data) => {
        const viewer = record(data.viewer);
        const org = record(viewer?.organization);
        return text(viewer?.id) && text(org?.id) && text(org?.urlKey);
    },
};

/**
 * Whether a 2xx answer to `operation` is well-formed: an object whose `errors` is absent or empty (a non-empty array
 * is `classifyLinearAnswer`'s), whose `data` is an object, and whose root field has the operation's shape. Anything
 * else confirms nothing: malformed, never a value, an empty list, not-found or "not posted".
 */
export function linearAnswerShape(operation: string, json: unknown, request: OperationRequest): boolean {
    const answer = record(json);
    if (answer === null) return false;
    if (answer.errors !== undefined && !(Array.isArray(answer.errors) && answer.errors.length === 0)) return false;
    const data = record(answer.data);
    const shape = SHAPES[operation];
    return data !== null && shape !== undefined && shape(data, request);
}

const accepts =
    (operation: string) =>
    (json: unknown, request: OperationRequest): boolean =>
        linearAnswerShape(operation, json, request);

const getIssue: IntegrationOperation<{ key: string }> = {
    name: 'getIssue',
    effect: 'read',
    requiredScopes: ['read'],
    request: (input) => graphql(GET_ISSUE, { id: issueRef(input.key) }),
    accepts: accepts('getIssue'),
};

export interface LinearSearchInput {
    /** Team key, e.g. `ENG`. */
    team?: string;
    /** Workflow state name, case-insensitive. */
    state?: string;
    /** `me`, or the assignee's email. */
    assignee?: string;
    label?: string;
    project?: string;
    /** Free text over the issue's searchable content. */
    text?: string;
    first?: number;
}

/** The `IssueFilter` for a structured search; at least one field is required. */
const issueFilter = (input: LinearSearchInput): Record<string, unknown> => {
    const given = (value: string | undefined): value is string => typeof value === 'string' && value !== '';
    const filter: Record<string, unknown> = {};
    if (given(input.team)) filter.team = { key: { eq: input.team } };
    if (given(input.state)) filter.state = { name: { eqIgnoreCase: input.state } };
    if (given(input.assignee)) {
        filter.assignee = input.assignee === 'me' ? { isMe: { eq: true } } : { email: { eq: input.assignee } };
    }
    if (given(input.label)) filter.labels = { name: { eqIgnoreCase: input.label } };
    if (given(input.project)) filter.project = { name: { eqIgnoreCase: input.project } };
    if (given(input.text)) filter.searchableContent = { contains: input.text };
    if (Object.keys(filter).length === 0) throw new Error('a Linear search needs at least one filter field');
    return filter;
};

const searchIssues: IntegrationOperation<LinearSearchInput> = {
    name: 'searchIssues',
    effect: 'read',
    requiredScopes: ['read'],
    request: (input) => {
        const first = Math.min(Math.max(Math.floor(input.first ?? SEARCH_PAGE_SIZE), 1), SEARCH_MAX_PAGE_SIZE);
        return graphql(SEARCH_ISSUES, { filter: issueFilter(input), first });
    },
    paginate: cursorPages(['issues'], SEARCH_MAX_PAGES, SEARCH_MAX_ITEMS),
    accepts: accepts('searchIssues'),
};

const listComments: IntegrationOperation<{ key: string }> = {
    name: 'listComments',
    effect: 'read',
    requiredScopes: ['read'],
    request: (input) => graphql(LIST_COMMENTS, { id: issueRef(input.key), first: COMMENT_PAGE_SIZE }),
    paginate: cursorPages(['issue', 'comments'], COMMENT_MAX_PAGES, COMMENT_MAX_ITEMS),
    accepts: accepts('listComments'),
};

/** The comment's own id is the receipt's id (a client UUID v4), so a retried post is reconciled by `comment(id:)`. */
const addComment: IntegrationOperation<{ key: string; body: string; receiptId: string }> = {
    name: 'addComment',
    effect: 'write',
    requiredScopes: ['write'],
    request: (input) => {
        if (input.body === '') throw new Error('a comment needs a body');
        if (!LINEAR_UUID.test(input.receiptId)) throw new Error('a Linear comment id must be a UUID');
        return graphql(ADD_COMMENT, { input: { id: input.receiptId, issueId: issueRef(input.key), body: input.body } });
    },
    accepts: accepts('addComment'),
};

const viewer: IntegrationOperation<Record<string, never>> = {
    name: 'viewer',
    effect: 'read',
    requiredScopes: ['read'],
    request: () => graphql(VIEWER, {}),
    accepts: accepts('viewer'),
};

export const LINEAR_OPERATIONS = { getIssue, searchIssues, listComments, addComment, viewer } as const;

/** The error kinds, most decisive first: the first kind any error carries is the answer's outcome. */
const ERROR_KINDS: readonly { match: RegExp; outcome: IntegrationOutcome }[] = [
    { match: /authentication/, outcome: { outcome: 'unavailable', reason: 'credential-rejected', retryable: true } },
    { match: /forbidden/, outcome: { outcome: 'forbidden', reason: 'provider-denied' } },
    { match: /ratelimit/, outcome: { outcome: 'rate_limited' } },
    // There is no not-found outcome: a missing entity reads like Jira's 404, an unexpected status.
    { match: /notfound/, outcome: { outcome: 'unavailable', reason: 'unexpected-status', retryable: true } },
];

/** Linear names a missing entity only in the message (`Entity not found: Issue`, code `INPUT_ERROR`). */
const ENTITY_NOT_FOUND = /^Entity not found\b/;

const errorText = (error: unknown): string => {
    const ext = record(record(error)?.extensions);
    const message = record(error)?.message;
    const missing = typeof message === 'string' && ENTITY_NOT_FOUND.test(message) ? 'not found' : undefined;
    return [ext?.code, ext?.type, missing]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .replace(/ (?=found|limit)/g, '');
};

/**
 * A Linear GraphQL answer's verdict. `extensions.code`/`type` (and an `Entity not found` message) name the outcome,
 * the same one the matching HTTP status gets. A 2xx is a value only with `data` and no `errors`; an unknown error or
 * a missing `data` is a failure, `outcome_unknown` for a write. A 4xx it cannot name is null: its status decides.
 */
export function classifyLinearAnswer(
    json: unknown,
    op: Pick<IntegrationOperation, 'name' | 'effect'>,
    status: number
): IntegrationOutcome | null {
    const answer = record(json);
    const errors = answer?.errors;
    const twoHundred = status >= HTTP_OK && status < HTTP_REDIRECT;
    const failed = (reason: 'upstream-error' | 'malformed-response'): IntegrationOutcome =>
        op.effect === 'write'
            ? { outcome: 'outcome_unknown', operation: op.name }
            : { outcome: 'unavailable', reason, retryable: true };
    // `errors` is absent or an array of objects; anything else is an answer this cannot read.
    if (errors !== undefined && (!Array.isArray(errors) || errors.some((error) => record(error) === null))) {
        return twoHundred ? failed('malformed-response') : null;
    }
    if (Array.isArray(errors) && errors.length > 0) {
        const texts = errors.map(errorText);
        const kind = ERROR_KINDS.find((k) => texts.some((text) => k.match.test(text)));
        if (kind) return { ...kind.outcome };
        return twoHundred ? failed('upstream-error') : null;
    }
    return twoHundred && record(answer?.data) === null ? failed('malformed-response') : null;
}
