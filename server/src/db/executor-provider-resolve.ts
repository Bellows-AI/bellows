import {
    ENV_SUBSTITUTION,
    type ModelProvider,
    providerAvailable,
    providerRequiresBaseUrl,
    type SubscriptionTokenPolicy,
    subscriptionTokenAllowed,
} from '@factory-ai/core';
import { validBase, validKey } from '../provider-keys/input-rules.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { EnvSecretError, envSecretIdentity, readSecretValues } from './env-secrets.js';
import { executorCredentialIdentity } from './executor-credentials.js';
import {
    findVar,
    InconclusiveRead,
    type KeySource,
    type LegacyRow,
    samePath,
    type ScopeVars,
} from './executor-provider-plan.js';

/**
 * The impure half of the executor provider migration's decision (executor-provider-migration.ts): reads the key and the
 * endpoint a plan names, and judges them by the rules every writer of a provider connection shares — the routes'
 * input rules and the cloud's subscription policy. A confirmed bad answer is a `suspend` with its reason; only a
 * failed or timed-out secret store read throws `InconclusiveRead`, which leaves the row for the next pass.
 */

/** What a row's resolution answers: the connection's inputs, or why the executor is suspended. */
export type Resolved = { key: string; baseUrl: string | null } | { suspend: string };

/** The row faults of a secret read (`EnvSecretError`) that no retry clears. */
const CONFIRMED_FAULTS: ReadonlySet<string> = new Set(['malformed-row', 'version-mismatch', 'invalid-encoding']);

export interface ResolveContext {
    secrets: SecretStore;
    subscriptionPolicy: SubscriptionTokenPolicy;
    orgId: string;
    row: LegacyRow;
    vars: ScopeVars;
}

type Read = { value: string } | { suspend: string };

/** A confirmed row fault is a suspension; any other failed or timed-out read is inconclusive. */
function judgeFault(error: unknown): Read {
    if (!(error instanceof EnvSecretError)) throw error;
    if (CONFIRMED_FAULTS.has(error.code)) return { suspend: `the stored key cannot be read (${error.code})` };
    throw new InconclusiveRead(error.message);
}

/** The executor's own stored credential at `path`. */
async function readStored({ secrets, orgId, row }: ResolveContext, path: string[]): Promise<Read> {
    const stored = row.secret_refs.find((s) => samePath(s.path, path));
    if (!stored) return { suspend: `the stored key at ${path.join('.')} has no record; enter the key again` };
    try {
        const [value] = await readSecretValues(secrets, [
            {
                name: path.join('.'),
                ref: stored.ref,
                version: stored.version,
                identity: executorCredentialIdentity(orgId, stored.path),
            },
        ]);
        return { value: value! };
    } catch (error) {
        return judgeFault(error);
    }
}

/** A variable of the executor's scope, the nearest layer first. */
async function readVariable({ secrets, orgId, vars }: ResolveContext, name: string): Promise<Read> {
    const hit = findVar(vars, name);
    if (!hit) return { suspend: `the variable ${name} the executor names is not set in its scope` };
    const { layer, row: variable } = hit;
    if (!variable.is_secret) return { value: variable.value! };
    if (!variable.secret_ref || !variable.secret_version) {
        return { suspend: `the variable ${name} is stored without its secret record` };
    }
    const scope =
        layer.kind === 'org' ? { kind: 'org' as const } : { kind: 'workspace' as const, userId: layer.userId! };
    try {
        const [value] = await readSecretValues(secrets, [
            {
                name,
                ref: variable.secret_ref,
                version: variable.secret_version,
                identity: envSecretIdentity(orgId, scope, name),
            },
        ]);
        return { value: value! };
    } catch (error) {
        return judgeFault(error);
    }
}

function readValue(context: ResolveContext, source: KeySource): Promise<Read> {
    if (source.kind === 'literal') return Promise.resolve({ value: source.value });
    return source.kind === 'stored' ? readStored(context, source.path) : readVariable(context, source.name);
}

/** The endpoint a plan names: a literal URL or an `{env:NAME}` reference resolved through the scope like the key. */
async function readBase(
    context: ResolveContext,
    raw: string | null
): Promise<{ value: string | null } | { suspend: string }> {
    if (raw === null) return { value: null };
    const reference = ENV_SUBSTITUTION.exec(raw);
    if (!reference) return { value: raw };
    return readValue(context, { kind: 'variable', name: reference[1]! });
}

/** What a provider's connection may hold, judged as the routes judge a create: nothing to store means a suspension. */
function refusal(provider: ModelProvider, key: string, baseUrl: string | null, context: ResolveContext): string | null {
    if (!providerAvailable(provider, subscriptionTokenAllowed(context.subscriptionPolicy, context.orgId))) {
        return 'a Claude subscription connection is not available to this organization';
    }
    if (!validKey(key)) return 'the key is not a valid provider key (printable characters, no spaces)';
    if (baseUrl !== null && (provider === 'subscription' || !validBase(baseUrl))) {
        return 'the endpoint is not an http(s) URL without credentials, or this provider takes none';
    }
    return baseUrl === null && providerRequiresBaseUrl(provider)
        ? 'this provider needs an endpoint the executor does not name'
        : null;
}

/** The key and endpoint of a plan, read and judged. */
export async function resolveConnectionInput(
    context: ResolveContext,
    plan: { provider: ModelProvider; source: KeySource; baseUrl: string | null }
): Promise<Resolved> {
    const key = await readValue(context, plan.source);
    if ('suspend' in key) return key;
    const base = await readBase(context, plan.baseUrl);
    if ('suspend' in base) return base;
    const reason = refusal(plan.provider, key.value, base.value, context);
    return reason === null ? { key: key.value, baseUrl: base.value } : { suspend: reason };
}
