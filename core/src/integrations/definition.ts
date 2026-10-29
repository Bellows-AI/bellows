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
    /** The next page's path (given the path just read), or null when this was the last. Validated like any other path. */
    next(json: unknown, previousPath: string): string | null;
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
}

export const defineIntegration = (def: IntegrationDefinition): IntegrationDefinition => {
    if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`integration id "${def.id}" is not a lowercase slug`);
    if (!def.api.pathPrefix.startsWith('/')) throw new Error(`integration "${def.id}" pathPrefix must start with /`);
    return def;
};
