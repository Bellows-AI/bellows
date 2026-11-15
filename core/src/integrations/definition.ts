import type { IntegrationOutcome } from './outcomes.js';

export interface IntegrationResource {
    id: string;
    label: string;
}

export interface OperationRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** A path under the definition's `api.pathPrefix`; never an absolute URL. */
    path: string;
    body?: unknown;
}

export interface Pagination {
    maxPages: number;
    maxItems: number;
    items(json: unknown): readonly unknown[];
    /**
     * The next page's complete request (given the request just sent), or null when this was the last. Its path is
     * validated like any other; a POST keeps its body only when `next` returns one (a GraphQL page carries the same
     * query with a new cursor).
     */
    next(json: unknown, previous: OperationRequest): OperationRequest | null;
}

export interface IntegrationOperation<I = unknown> {
    name: string;
    /** A write that fails after dispatch is `outcome_unknown`; a read is `unavailable`. */
    effect: 'read' | 'write';
    requiredScopes: readonly string[];
    /** The connection's resource is the only place a provider-side site or tenant ID may come from. */
    request(input: I, resource: IntegrationResource): OperationRequest;
    /** Absent: the parsed body is the value. With `paginate`: the value is the collected items. */
    paginate?: Pagination;
    /** The answer's shape: a 2xx answer (every page) it refuses is `malformed-response`, never a value. */
    accepts?(json: unknown, request: OperationRequest): boolean;
}

export interface IntegrationDefinition {
    id: string;
    kind: 'connection';
    /** capability -> the scopes granting it */
    capabilities: Readonly<Record<string, readonly string[]>>;
    api: {
        origin(resource: IntegrationResource): string;
        pathPrefix: string;
    };
    /** Skill names only; loading them is the runner's business. */
    skills: readonly string[];
    /** Whether a 403 means "a scope is missing" rather than "denied". */
    isScopeError?(status: number, json: unknown): boolean;
    /**
     * An answer's verdict from its JSON body: a 2xx (every page of a paginated one) before it counts as a value, and
     * a 4xx other than 401/403/429. An outcome refuses the answer; null leaves it to the status (a 2xx is a value, a
     * 4xx its status outcome). A GraphQL failure is a 200 or a 400 with `errors`. Absent: the status alone decides.
     */
    classifyAnswer?(
        json: unknown,
        op: Pick<IntegrationOperation, 'name' | 'effect'>,
        status: number
    ): IntegrationOutcome | null;
}

export const defineIntegration = (def: IntegrationDefinition): IntegrationDefinition => {
    if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`integration id "${def.id}" is not a lowercase slug`);
    if (!def.api.pathPrefix.startsWith('/')) throw new Error(`integration "${def.id}" pathPrefix must start with /`);
    return def;
};
