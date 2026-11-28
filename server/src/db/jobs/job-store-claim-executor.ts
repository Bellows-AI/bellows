/**
 * The claim's env and executor resolution (see `job-store-claim.ts`): the stacked env and the
 * author's executor row merged over the runner's config env name. No GitHub credential rides it:
 * the runner obtains one from the board (docs/connections.md). Split out of the claim file for its
 * size cap; a reviewer's claim reuses it with an env grant.
 */

import {
    CLAUDE_CODE,
    applyConnectionLayer,
    claimCredentialEnv,
    CLOUD,
    type ConnectionCredential,
    type ConnectionSelectionRefusal,
    connectionOpenCodeProvider,
    connectionSelectionRefusal,
    CLOUD_CREDENTIAL_MESSAGE,
    credentialRedirectMessage,
    type DeploymentMode,
    EXECUTOR_TYPES,
    forbiddenCredentialIn,
    GITHUB_ENV_NAMES,
    hasModelKey,
    missingProviderSecretMessage,
    modelKeyRequired,
    NO_MODEL_MESSAGE,
    noExecutorMessage,
    executorSuspendedMessage,
    USER_SCOPE,
    type ExecutorScope,
    type ExecutorType,
    OPENCODE,
    redirectsPlatformCredential,
    resolveProviderReferences,
    subscriptionTokenAllowed,
    RUNNER_MANAGED_KEYS,
    type SelectedConnection,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import type { CreateJobStoreDeps } from './job-store-types.js';

/** What a profile naming a connection is refused with on a board that wired no connection reader. */
const CONNECTIONS_UNAVAILABLE_MESSAGE = 'Provider connections are unavailable on this board; the executor cannot run.';

/** `over` laid on `base`, plain objects merged key by key and anything else taken from `over`: pasted config wins. */
function mergeUnder(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
        const lower = merged[key];
        merged[key] = isRecord(lower) && isRecord(value) ? mergeUnder(lower, value) : value;
    }
    return merged;
}

/** The env name Claude Code reads its model from, over its settings' `model`; OpenCode reads none. */
export const CLAUDE_MODEL_ENV = 'ANTHROPIC_MODEL';

/**
 * The provider connection store's claim-time reader, declared here like `executorConfig`: a profile's selected
 * connection is judged by the shared rules and its CURRENT key read on the claim's transaction, fail-closed (an
 * unconfirmed read throws and the claim rolls back).
 */
export interface ClaimConnectionReader {
    claimCredentialFor(
        exec: Sql | TransactionSql,
        id: string,
        check: (connection: SelectedConnection | null) => ConnectionSelectionRefusal | null
    ): Promise<{ refusal: ConnectionSelectionRefusal } | { credential: ConnectionCredential }>;
}

export interface ResolvedClaimExecutor {
    claimEnv: Record<string, string> | undefined;
    executorType: ExecutorType | null;
    executorRefusal: string | null;
    /** The model the runner is handed (the merged config's `model`), recorded as `job.run_model`; null when none travels. */
    runModel: string | null;
    /** The stamped profile's runner class; null for the driver's default, a suspended or a missing profile. */
    runnerClass: string | null;
}

/**
 * The pasted executor config rides the claim env under the name that CLI's entrypoint merges
 * over the baked configuration, applied LAST so the synthesized value wins a collision with a
 * member env var — both names are reserved at PUT besides.
 */
export function mergeExecutorConfigEnv(
    claimEnv: Record<string, string> | undefined,
    configured: { type: string; config: Record<string, unknown> } | null
): Record<string, string> | undefined {
    const member = configured?.config;
    if (member === null || member === undefined || typeof member !== 'object' || Array.isArray(member)) {
        return claimEnv;
    }
    // RUNNER_MANAGED_KEYS is the runner's fence per type, stripped before the config travels.
    // opencode's `permission` is baked into the image and patched by its entrypoint — a pasted
    // `external_directory: allow` would open every member's tree to this run. claude-code's `hooks`,
    // `enabledPlugins` and `extraKnownMarketplaces` are the baked hooks and the image's own
    // plugin set (none): a pasted `hooks` would silently drop the stop and turn-context hooks; a pasted
    // plugin/marketplace pair would run code the image never installed. Everything else — model,
    // env, permissions.allow, provider — travels verbatim.
    const envName =
        configured?.type === OPENCODE
            ? 'OPENCODE_CONFIG_CONTENT'
            : configured?.type === CLAUDE_CODE
              ? 'CLAUDE_CODE_CONFIG_CONTENT'
              : null;
    if (envName === null) return claimEnv;
    const fenced = new Set(RUNNER_MANAGED_KEYS[configured!.type as ExecutorType]);
    const rest = Object.fromEntries(Object.entries(member).filter(([key]) => !fenced.has(key)));
    return { ...(claimEnv ?? {}), [envName]: JSON.stringify(rest) };
}

/**
 * The resolved env without GitHub's credential names. They are refused at PUT and a migration
 * deleted the stored rows; this is the claim's own guarantee that no member token reaches a runner,
 * which obtains the App's from the board instead (docs/connections.md).
 */
export function withoutGithubToken(env: Record<string, string> | undefined): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    return Object.fromEntries(Object.entries(env).filter(([name]) => !GITHUB_ENV_NAMES.includes(name)));
}

/** The entries of `env` named in `grant`, nothing else: a reviewer profile's `connections`. */
function grantedEnv(
    env: Record<string, string> | undefined,
    grant: readonly string[]
): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    return Object.fromEntries(Object.entries(env).filter(([name]) => grant.includes(name)));
}

/**
 * The selected provider connection as the highest scope of the env: above the stacked scopes (explicit beats ambient)
 * and below the pasted config merged next. A reviewer's grant filtered the ambient env before and does not filter this:
 * the executor's own model credential is not a member secret the grant withholds. A stale, foreign or incompatible
 * reference is a refusal — never recovered from by ambient credentials — and a failed secret read throws, rolling the
 * claim back. A custom OpenCode endpoint's provider options go BENEATH the pasted config (`mergeUnder`).
 */
async function layerConnection(
    tx: TransactionSql,
    reader: ClaimConnectionReader | undefined,
    input: {
        id: string | null;
        owner: string | null;
        executorType: ExecutorType | null;
        claimEnv: Record<string, string> | undefined;
        source: { type: string; config: Record<string, unknown> } | null;
    }
): Promise<
    | { refusal: string }
    | {
          claimEnv: Record<string, string> | undefined;
          source: { type: string; config: Record<string, unknown> } | null;
          blanks: string[];
          /** The selected OpenRouter connection's endpoint, which Claude Code's route to OpenRouter must use. */
          openRouterBaseUrl: string | null;
      }
> {
    const { id, owner, executorType, source } = input;
    // No selection (a frozen agent default never has one, nor an unknown agent): the env is the stacked scopes' alone.
    if (id === null || executorType === null)
        return { claimEnv: input.claimEnv, source, blanks: [], openRouterBaseUrl: null };
    if (!reader) return { refusal: CONNECTIONS_UNAVAILABLE_MESSAGE };
    const selected = await reader.claimCredentialFor(tx, id, (connection) =>
        connectionSelectionRefusal({ connection, owner, agentType: executorType })
    );
    if ('refusal' in selected) return { refusal: selected.refusal.message };
    const { credential } = selected;
    const layered = applyConnectionLayer(input.claimEnv, executorType, credential);
    const block =
        executorType === OPENCODE
            ? connectionOpenCodeProvider(
                  credential.provider,
                  credential.baseUrl,
                  typeof source?.config.model === 'string' ? source.config.model : undefined
              )
            : null;
    return {
        claimEnv: layered.env,
        blanks: layered.blanks,
        openRouterBaseUrl: credential.provider === 'openrouter' ? credential.baseUrl : null,
        source: block !== null && source !== null ? { ...source, config: mergeUnder(block, source.config) } : source,
    };
}

/** The profile's `{env:NAME}` provider keys resolved from the env that travels (`resolveProviderReferences`); the names it lacks. */
function withResolvedReferences<T extends { config: Record<string, unknown> }>(
    source: T | null,
    env: Record<string, string> | undefined
): { source: T | null; missing: string[] } {
    if (source === null) return { source, missing: [] };
    const resolved = resolveProviderReferences(source.config, env ?? {});
    return { source: { ...source, config: resolved.config }, missing: resolved.missing };
}

/** What a connection replaced, carried empty beneath the env's own names (`applyConnectionLayer`). */
const withBlanks = (env: Record<string, string> | undefined, blanks: readonly string[]) =>
    blanks.length === 0 ? env : { ...Object.fromEntries(blanks.map((name) => [name, ''])), ...env };

/**
 * claim()'s env + executor resolution: the stacked env and the author's executor row merged over
 * the runner's config env name. Resolved ON THE TRANSACTION, so a claim holds one connection rather
 * than two, and a resolver failure rolls the whole claim back (docs/env.md).
 */
export async function resolveClaimExecutor(
    tx: TransactionSql,
    deps: {
        env: CreateJobStoreDeps['env'];
        executorConfig: CreateJobStoreDeps['executorConfig'];
        providerConnections?: ClaimConnectionReader | undefined;
        /** The claiming org: with `cloudSubscriptionOrgIds`, whether it may run on a subscription token. */
        orgId: string;
        deploymentMode: DeploymentMode;
        cloudSubscriptionOrgIds: ReadonlySet<string>;
        /**
         * Set for a reviewer's claim: ONLY these member env names reach it. The
         * executor config (the agent's own runtime settings) still travels — a reviewer needs to
         * run — but nothing of the caller's access does.
         */
        grant?: readonly string[];
    },
    row: ClaimExecutorRow
): Promise<ResolvedClaimExecutor> {
    const { env, executorConfig, providerConnections, deploymentMode, grant } = deps;
    const subscriptionAllowed = subscriptionTokenAllowed(deps, deps.orgId);
    const claimExecutor = await claimExecutorOf(tx, executorConfig, row);
    let { source } = claimExecutor;
    const { executorType, executorRefusal, runnerClass, providerConnectionId, owner } = claimExecutor;
    // Read once the agent is known: a Claude Code run takes its model names from one scope (`stackClaudeCodeEnv`).
    const resolvedEnv = withoutGithubToken(
        env
            ? await env.resolveFor({ userId: row.run_as, repo: row.repo }, tx, {
                  agentType: executorType,
              })
            : undefined
    );
    let claimEnv = grant !== undefined ? grantedEnv(resolvedEnv, grant) : resolvedEnv;
    const layered = await layerConnection(tx, providerConnections, {
        id: providerConnectionId,
        owner,
        executorType,
        claimEnv,
        source,
    });
    if ('refusal' in layered) {
        return { claimEnv: undefined, executorType, executorRefusal: layered.refusal, runModel: null, runnerClass };
    }
    const { blanks, openRouterBaseUrl } = layered;
    ({ claimEnv, source } = layered);
    // A custom provider's `{env:NAME}` key is the board's to resolve: the value comes from the scopes
    // the claim merged — the env that travels, a reviewer's grant applied — never from the runner's
    // own environment, so a deployment `RUNNER_ENV` value cannot be named into a member endpoint. An
    // unresolved reference fails the task before the agent starts, naming the missing secret.
    const resolved = withResolvedReferences(source, claimEnv);
    ({ source } = resolved);
    const profileConfig: unknown = source?.config;
    if (resolved.missing.length > 0) {
        return {
            claimEnv: undefined,
            executorType,
            executorRefusal: missingProviderSecretMessage(resolved.missing),
            runModel: null,
            runnerClass,
        };
    }
    if (source !== null) claimEnv = mergeExecutorConfigEnv(claimEnv, source);
    claimEnv = withClaimCredentials(claimEnv, profileConfig, {
        type: executorType,
        mode: deploymentMode,
        openRouterBaseUrl,
    });
    // Claude Code takes `$ANTHROPIC_MODEL` over its settings' `model`: a chosen model rides under that name too, so no
    // member value outranks it.
    if (executorType === CLAUDE_CODE && row.agent_model !== null) {
        claimEnv = { ...claimEnv, [CLAUDE_MODEL_ENV]: row.agent_model };
    }
    // Cloud checks the EFFECTIVE env — member env, a reviewer's grant and the profile merged — so a
    // token (unless the operator lists the org), or a redirect of the deployment's model credential with no member key, saved before
    // cloud mode or split across scopes and profile, never travels; nor does a run with no model key
    // (`NO_MODEL`). The driver fails the task with the
    // sentence before anything spawns; a throw here would roll the claim back and re-claim it forever.
    const refusal =
        (deploymentMode === CLOUD ? cloudRefusal(claimEnv, profileConfig, executorType, subscriptionAllowed) : null) ??
        (modelKeyRequired(deploymentMode) ? missingModelKeyRefusal(claimEnv, profileConfig, executorType) : null);
    if (refusal !== null)
        return {
            claimEnv: undefined,
            executorType,
            executorRefusal: refusal,
            runModel: null,
            runnerClass,
        };
    // What the connection replaced travels EMPTY, judged only now so the checks above never see a blank as a member's
    // credential: the driver forwards its own `RUNNER_ENV` under these names, and the claim's name wins over it.
    claimEnv = withBlanks(claimEnv, blanks);
    const runModel = runModelOf(source, executorType, claimEnv);
    // And whatever resolved is pinned there, so the model recorded is the one the CLI runs: the claim env wins over an
    // `ANTHROPIC_MODEL` the driver forwards (RUNNER_ENV), which the board cannot see. Nothing resolved sends nothing.
    if (executorType === CLAUDE_CODE && runModel !== null) claimEnv = { ...claimEnv, [CLAUDE_MODEL_ENV]: runModel };
    return { claimEnv, executorType, executorRefusal, runModel, runnerClass };
}

/**
 * The model the runner runs: only a known agent's config travels (`mergeExecutorConfigEnv`). Claude Code's is
 * `$ANTHROPIC_MODEL` when the env it gets sets one — its settings' `env` applied over the claim env — else the
 * config's `model`; OpenCode's is the config's `model` alone.
 */
function runModelOf(
    source: { config: Record<string, unknown> } | null,
    type: ExecutorType | null,
    claimEnv: Record<string, string> | undefined
): string | null {
    if (type === null) return null;
    const config: unknown = source?.config;
    const model = isRecord(config) ? config.model : undefined;
    const fromEnv = type === CLAUDE_CODE ? claudeEnvOf(config, claimEnv)[CLAUDE_MODEL_ENV] : undefined;
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
    return typeof model === 'string' ? model : null;
}

/** The env a Claude Code run gets: the claim env with the settings' own `env` over it. */
function claudeEnvOf(config: unknown, claimEnv: Record<string, string> | undefined): Record<string, unknown> {
    return {
        ...claimEnv,
        ...(isRecord(config) && isRecord(config.env) ? config.env : {}),
    };
}

/**
 * Records on the claimed row what its runner got (`job.run_model`), inside the claim transaction so it rolls back with
 * the claim. Every claim writes it — a retry, a takeover and a follow-up each re-record their own.
 */
export async function recordRunModel(tx: TransactionSql, orgId: string, jobId: string, runModel: string | null) {
    await tx`update job set run_model = ${runModel} where org_id = ${orgId} and id = ${jobId}`;
}

/**
 * The executor a claim runs: the profile the task names. A task naming none has nothing to run on and is refused.
 *
 * The executor label a task was queued with names a row in the STAMPED SCOPE's list (issue
 * 391): the author's own rows when the stamp is 'user' — null reads as 'user', the pre-391
 * meaning — and the organization's when it is 'org', which is how a team-shared profile
 * resolves for any author. Its TYPE is the execution input: it tells the driver which
 * CLI/image family to run. A label matching nothing IN THAT SCOPE remains null on the claim
 * and is failed explicitly by the driver; there is no global CLI fallback, and no cross-scope
 * one either — a selection names its scope, and the other scope's same-named row is simply not
 * this selection's answer. `source` is what merges over the env (null: nothing does).
 */
async function claimExecutorOf(
    tx: TransactionSql,
    executorConfig: CreateJobStoreDeps['executorConfig'],
    row: ClaimExecutorRow
): Promise<{
    executorType: ExecutorType | null;
    executorRefusal: string | null;
    source: { type: string; config: Record<string, unknown> } | null;
    runnerClass: string | null;
    /** The connection the profile selects; null when the task names no profile. */
    providerConnectionId: string | null;
    /** The profile's owner for the connection's visibility rule: the author for a personal row, null for an org row. */
    owner: string | null;
}> {
    const none = {
        executorRefusal: null,
        providerConnectionId: null,
        owner: null,
    };
    if (executorConfig && row.executor === null) {
        // The default is resolved at create, to a profile label. A row without one (a task queued before that, or by a
        // caller with no default) is refused here, so the driver fails it with a reason before any runner starts.
        return { ...none, executorType: null, executorRefusal: noExecutorMessage, source: null, runnerClass: null };
    }
    if (!executorConfig || row.executor === null || row.run_as === null) {
        return { ...none, executorType: null, source: null, runnerClass: null };
    }
    const scope = (row.executor_scope ?? USER_SCOPE) as ExecutorScope;
    const configured = await executorConfig.claimConfigFor(row.run_as, row.executor, scope, tx);
    if (configured?.suspended) {
        // A suspended profile (issue 440) launches nothing and its config never reaches the
        // claim: the driver fails the task with this sentence before any runner starts, for a
        // fresh task, a retry and a follow-up alike — they all claim through here.
        const executorRefusal = executorSuspendedMessage(scope, row.executor);
        return {
            ...none,
            executorType: null,
            executorRefusal,
            source: null,
            runnerClass: null,
        };
    }
    const known = configured && EXECUTOR_TYPES.includes(configured.type as ExecutorType);
    return {
        executorType: known ? (configured.type as ExecutorType) : null,
        executorRefusal: null,
        providerConnectionId: configured?.providerConnectionId ?? null,
        owner: scope === USER_SCOPE ? row.run_as : null,
        source: withChosenModel(configured, row.agent_model),
        // Resolved here, at claim, like the type: an admin's edit reaches every later claim. The
        // driver is the authority on the name, and fails the task when it declares no such class.
        runnerClass: configured?.runnerClass ?? null,
    };
}

/**
 * The profile's config with the task's chosen model over its own (`agent_model` on a profile task). `model` is not a
 * runner-fenced key, so it travels like the rest of the config; every other key stays the profile's — except a Claude
 * Code `env.ANTHROPIC_MODEL`, which the CLI would run over `model` and so takes the chosen model too.
 */
function withChosenModel<T extends { type: string; config: Record<string, unknown> }>(
    configured: T | null,
    model: string | null
) {
    if (configured === null || model === null) return configured;
    const { env } = configured.config;
    const pinsEnv = configured.type === CLAUDE_CODE && isRecord(env) && CLAUDE_MODEL_ENV in env;
    const config = {
        ...configured.config,
        model,
        ...(pinsEnv ? { env: { ...env, [CLAUDE_MODEL_ENV]: model } } : {}),
    };
    return { ...configured, config };
}

/** The job row columns the claim's executor resolution reads. */
export interface ClaimExecutorRow {
    agent_model: string | null;
    run_as: string | null;
    repo: string | null;
    executor: string | null;
    executor_scope: string | null;
}

/**
 * What the claim adds over the member's env (`claimCredentialEnv`): Claude Code's OpenRouter route on
 * a member's OpenRouter key alone (both modes), and in cloud mode an empty platform key beside any
 * member redirect without its member key, so the driver's own key never follows it. Judged on the env that TRAVELS (after a
 * reviewer's grant) with a claude-code config's `env` applied last, as `redirectsPlatformCredential`
 * reads it. A selected OpenRouter connection's endpoint is the route's, never the public one. Recomputed on every
 * claim; nothing is stored.
 */
function withClaimCredentials(
    claimEnv: Record<string, string> | undefined,
    config: unknown,
    {
        type,
        mode,
        openRouterBaseUrl,
    }: { type: ExecutorType | null; mode: DeploymentMode; openRouterBaseUrl: string | null }
): Record<string, string> | undefined {
    if (type === null) return claimEnv;
    const configEnv = type === CLAUDE_CODE && isRecord(config) && isRecord(config.env) ? config.env : {};
    const added = claimCredentialEnv({ ...claimEnv, ...configEnv }, type, mode, openRouterBaseUrl);
    return Object.keys(added).length === 0 ? claimEnv : { ...claimEnv, ...added };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `NO_MODEL_MESSAGE` when the run would have no model key: judged by `hasModelKey` on the non-empty names of the env
 * that travels (a reviewer's grant, the one-scope rule and the claim's wiring applied) with the profile config over it,
 * so a Claude Code `env` value of "" clears a key; null otherwise. An agent the claim does not know is not judged: the
 * driver fails it on its own. The create's verdict is never trusted here: the env is read at claim.
 */
function missingModelKeyRefusal(env: Record<string, string> | undefined, config: unknown, type: ExecutorType | null) {
    if (type === null) return null;
    const names = Object.entries(env ?? {}).flatMap(([name, value]) => (value === '' ? [] : [name]));
    return hasModelKey(names, config, type) ? null : NO_MODEL_MESSAGE;
}

/**
 * The sentence cloud mode refuses an effective env with, or null. Names keys only, never a value. A listed org
 * (`subscriptionAllowed`) skips only the token refusal; the redirect refusal always runs.
 */
function cloudRefusal(
    env: Record<string, string> | undefined,
    config: unknown,
    type: ExecutorType | null,
    subscriptionAllowed: boolean
) {
    if (!subscriptionAllowed && forbiddenCredentialIn(env, config) !== null) return CLOUD_CREDENTIAL_MESSAGE;
    const redirect = redirectsPlatformCredential(env, config, type ?? undefined);
    return redirect === null ? null : credentialRedirectMessage(redirect);
}
