/**
 * The claim's env and executor resolution (see `job-store-claim.ts`): the stacked env and the
 * author's executor row merged over the runner's config env name. No GitHub credential rides it:
 * the runner obtains one from the board (docs/connections.md). Split out of the claim file for its
 * size cap; a reviewer's claim reuses it with an env grant.
 */

import {
    CLAUDE_CODE,
    claimCredentialEnv,
    CLOUD,
    CLOUD_CREDENTIAL_MESSAGE,
    credentialRedirectMessage,
    type DeploymentMode,
    EXECUTOR_TYPES,
    forbiddenCredentialIn,
    FORGE_ENV_NAMES,
    hasModelKey,
    modelKeyRequired,
    NO_MODEL_MESSAGE,
    executorSuspendedMessage,
    USER_SCOPE,
    type ExecutorScope,
    type ExecutorType,
    OPENCODE,
    redirectsPlatformCredential,
    RUNNER_MANAGED_KEYS,
} from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { refOfNullableRow } from '../repo-ref-row.js';
import type { CreateJobStoreDeps } from './job-store-types.js';

/** The env name Claude Code reads its model from, over its settings' `model`; OpenCode reads none. */
const CLAUDE_MODEL_ENV = 'ANTHROPIC_MODEL';

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
 * The resolved env without the forges' credential names. They are refused at PUT and migrations
 * deleted the stored rows; this is the claim's own guarantee that no member token reaches a runner,
 * which obtains its forge token from the board instead (docs/connections.md).
 */
export function withoutForgeTokens(env: Record<string, string> | undefined): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    return Object.fromEntries(Object.entries(env).filter(([name]) => !FORGE_ENV_NAMES.includes(name)));
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
 * claim()'s env + executor resolution: the stacked env and the author's executor row merged over
 * the runner's config env name. Resolved ON THE TRANSACTION, so a claim holds one connection rather
 * than two, and a resolver failure rolls the whole claim back (docs/env.md).
 */
export async function resolveClaimExecutor(
    tx: TransactionSql,
    deps: {
        env: CreateJobStoreDeps['env'];
        executorConfig: CreateJobStoreDeps['executorConfig'];
        deploymentMode: DeploymentMode;
        /** The operator supplies the model: cloud claims need no member model credential. */
        platformModelProvided?: boolean;
        /**
         * Set for a reviewer's claim: ONLY these member env names reach it. The
         * executor config (the agent's own runtime settings) still travels — a reviewer needs to
         * run — but nothing of the caller's access does.
         */
        grant?: readonly string[];
    },
    row: ClaimExecutorRow
): Promise<ResolvedClaimExecutor> {
    const { env, executorConfig, deploymentMode, platformModelProvided = false, grant } = deps;
    const { executorType, executorRefusal, source, runnerClass } = await claimExecutorOf(tx, executorConfig, row);
    // Read once the agent is known: a Claude Code run takes its model names from one scope (`stackClaudeCodeEnv`).
    const resolvedEnv = withoutForgeTokens(
        env
            ? await env.resolveFor({ userId: row.run_as, repo: refOfNullableRow(row) }, tx, { agentType: executorType })
            : undefined
    );
    let claimEnv = grant !== undefined ? grantedEnv(resolvedEnv, grant) : resolvedEnv;
    if (source !== null) claimEnv = mergeExecutorConfigEnv(claimEnv, source);
    const profileConfig: unknown = source?.config;
    claimEnv = withClaimCredentials(claimEnv, profileConfig, executorType, deploymentMode);
    // Claude Code takes `$ANTHROPIC_MODEL` over its settings' `model`: a chosen model rides under that name too, so no
    // member value outranks it.
    if (executorType === CLAUDE_CODE && row.agent_model !== null) {
        claimEnv = { ...claimEnv, [CLAUDE_MODEL_ENV]: row.agent_model };
    }
    // Cloud checks the EFFECTIVE env — member env, a reviewer's grant and the profile merged — so a
    // token, or a redirect of the deployment's model credential with no member key, saved before
    // cloud mode or split across scopes and profile, never travels; nor does a run with no model key
    // (`NO_MODEL`, unless the operator supplies the model). The driver fails the task with the
    // sentence before anything spawns; a throw here would roll the claim back and re-claim it forever.
    const refusal =
        (deploymentMode === CLOUD ? cloudRefusal(claimEnv, profileConfig, executorType) : null) ??
        (modelKeyRequired(deploymentMode, platformModelProvided)
            ? noModelRefusal(claimEnv, profileConfig, executorType)
            : null);
    if (refusal !== null)
        return { claimEnv: undefined, executorType, executorRefusal: refusal, runModel: null, runnerClass };
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
    return { ...claimEnv, ...(isRecord(config) && isRecord(config.env) ? config.env : {}) };
}

/**
 * Records on the claimed row what its runner got (`job.run_model`), inside the claim transaction so it rolls back with
 * the claim. Every claim writes it — a retry, a takeover and a follow-up each re-record their own.
 */
export async function recordRunModel(tx: TransactionSql, orgId: string, jobId: string, runModel: string | null) {
    await tx`update job set run_model = ${runModel} where org_id = ${orgId} and id = ${jobId}`;
}

/**
 * The executor a claim runs: the profile the task names, or the agent default frozen on it.
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
}> {
    const agent = frozenAgentOf(row);
    if (agent !== null) return { executorType: agent.type, executorRefusal: null, source: agent, runnerClass: null };
    if (!executorConfig || row.executor === null || row.run_as === null) {
        return { executorType: null, executorRefusal: null, source: null, runnerClass: null };
    }
    const scope = (row.executor_scope ?? USER_SCOPE) as ExecutorScope;
    const configured = await executorConfig.claimConfigFor(row.run_as, row.executor, scope, tx);
    if (configured?.suspended) {
        // A suspended profile (issue 440) launches nothing and its config never reaches the
        // claim: the driver fails the task with this sentence before any runner starts, for a
        // fresh task, a retry and a follow-up alike — they all claim through here.
        const executorRefusal = executorSuspendedMessage(scope, row.executor);
        return { executorType: null, executorRefusal, source: null, runnerClass: null };
    }
    const known = configured && EXECUTOR_TYPES.includes(configured.type as ExecutorType);
    return {
        executorType: known ? (configured.type as ExecutorType) : null,
        executorRefusal: null,
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
    const config = { ...configured.config, model, ...(pinsEnv ? { env: { ...env, [CLAUDE_MODEL_ENV]: model } } : {}) };
    return { ...configured, config };
}

/** The agent default frozen on a job row. */
export interface FrozenAgentColumns {
    agent_type: string | null;
    agent_model: string | null;
}

/** The job row columns the claim's executor resolution reads. */
export interface ClaimExecutorRow extends FrozenAgentColumns {
    run_as: string | null;
    forge: string;
    host: string;
    repo: string | null;
    executor: string | null;
    executor_scope: string | null;
}

/**
 * The agent default frozen on a task naming no profile: its agent is the runner type and its model (the chosen one when
 * the task picked one, which create and a follow-up write over the default's) the whole config, merged exactly as a
 * profile's would be. Read off the row only — the agent default as it reads now is never
 * consulted, so a retry, a follow-up or a takeover runs what the task was created with. Null for a profile task.
 */
function frozenAgentOf(row: ClaimExecutorRow): { type: ExecutorType; config: Record<string, unknown> } | null {
    if (row.executor !== null || row.agent_type === null) return null;
    if (!EXECUTOR_TYPES.includes(row.agent_type as ExecutorType)) return null;
    return { type: row.agent_type as ExecutorType, config: row.agent_model === null ? {} : { model: row.agent_model } };
}

/**
 * What the claim adds over the member's env (`claimCredentialEnv`): Claude Code's OpenRouter route on
 * a member's OpenRouter key alone (both modes), and in cloud mode an empty platform key beside any
 * member redirect without its member key, so the driver's own key never follows it. Judged on the env that TRAVELS (after a
 * reviewer's grant) with a claude-code config's `env` applied last, as `redirectsPlatformCredential`
 * reads it. Recomputed on every claim; nothing is stored.
 */
function withClaimCredentials(
    claimEnv: Record<string, string> | undefined,
    config: unknown,
    type: ExecutorType | null,
    mode: DeploymentMode
): Record<string, string> | undefined {
    if (type === null) return claimEnv;
    const configEnv = type === CLAUDE_CODE && isRecord(config) && isRecord(config.env) ? config.env : {};
    const added = claimCredentialEnv({ ...claimEnv, ...configEnv }, type, mode);
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
function noModelRefusal(env: Record<string, string> | undefined, config: unknown, type: ExecutorType | null) {
    if (type === null) return null;
    const names = Object.entries(env ?? {}).flatMap(([name, value]) => (value === '' ? [] : [name]));
    return hasModelKey(names, config, type) ? null : NO_MODEL_MESSAGE;
}

/** The sentence cloud mode refuses an effective env with, or null. Names keys only, never a value. */
function cloudRefusal(env: Record<string, string> | undefined, config: unknown, type: ExecutorType | null) {
    if (forbiddenCredentialIn(env, config) !== null) return CLOUD_CREDENTIAL_MESSAGE;
    const redirect = redirectsPlatformCredential(env, config, type ?? undefined);
    return redirect === null ? null : credentialRedirectMessage(redirect);
}
