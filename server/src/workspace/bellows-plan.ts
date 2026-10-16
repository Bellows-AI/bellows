/**
 * The execution plan a claim carries: the gate environment, the gates and the services a task's
 * repository declares in `.bellows.yaml`, resolved by the board through the GitHub API at one
 * commit — the tip of the task's base branch, or of the default branch — and validated as a WHOLE
 * before anything launches. The board never reads the file from a checkout: the driver and the
 * runner execute exactly what the claim delivered, so the plan cannot drift from the revision it
 * names.
 *
 * Services share one network namespace in the task pod, so the plan is refused, with a message
 * that tells the author what to change, when two services bind one port, when a service name would
 * shadow `localhost`, or when the file declares more than the pod can schedule. An undeclared or
 * unsupported image is refused by the two parsers (`bellows.ts`, `bellows-services.ts`).
 */

import { READ_RATE_LIMITED, READ_TRANSPORT } from '@factory-ai/core';
import type { GitHubAppClient } from '../github/app-client.js';
import { GitHubReadError } from '../github/pr-read.js';
import { BellowsError } from './bellows-grammar.js';
import { MAX_SERVICES, parseServices, type ServiceSpec } from './bellows-services.js';
import { parseBellowsWithPolicy, type BellowsConfig, type EvidencePolicy, type ReviewerProfile } from './bellows.js';

export type { ServiceSpec } from './bellows-services.js';

export const BELLOWS_FILE = '.bellows.yaml';

/** A service named like this would shadow the loopback address its siblings reach each other on. */
const RESERVED_SERVICE_NAMES: readonly string[] = ['localhost'];

export interface ExecutionPlan {
    readonly config: BellowsConfig | null;
    readonly services: readonly ServiceSpec[];
    readonly policy: EvidencePolicy;
    readonly reviewers: readonly ReviewerProfile[];
}

/** Every service port, each with the services that declare it: more than one is a collision. */
function portCollisions(services: readonly ServiceSpec[]): string[] {
    const owners = new Map<number, string[]>();
    for (const service of services) {
        for (const port of service.ports ?? []) owners.set(port, [...(owners.get(port) ?? []), service.name]);
    }
    return [...owners.entries()]
        .filter(([, names]) => names.length > 1)
        .map(
            ([port, names]) =>
                `services ${names.map((name) => `"${name}"`).join(' and ')} both declare port ${port} — ` +
                'services share one network namespace in the task pod, so a port can be bound once; ' +
                'give one of them another port'
        );
}

/** The plan-level refusals that no single service's grammar can see; empty for a schedulable plan. */
export function planProblems(services: readonly ServiceSpec[]): string[] {
    const problems: string[] = [];
    if (services.length > MAX_SERVICES) {
        problems.push(`at most ${MAX_SERVICES} services fit one task pod, got ${services.length}`);
    }
    for (const service of services) {
        if (RESERVED_SERVICE_NAMES.includes(service.name)) {
            problems.push(`service name "${service.name}" is reserved — pick another name`);
        }
    }
    return [...problems, ...portCollisions(services)];
}

/**
 * Parses and validates one `.bellows.yaml`. Throws a `BellowsError` whose message is the whole
 * author-facing refusal: a grammar error with its line, or the plan-level problems joined.
 */
export function resolveExecutionPlan(text: string): ExecutionPlan {
    const { config, policy, reviewers } = parseBellowsWithPolicy(text);
    let services: ServiceSpec[];
    try {
        services = parseServices(text);
    } catch (e) {
        throw e instanceof BellowsError ? e : new BellowsError((e as Error).message);
    }
    const problems = planProblems(services);
    if (problems.length > 0) {
        throw new BellowsError(`${BELLOWS_FILE}: the execution plan cannot be scheduled: ${problems.join('; ')}`);
    }
    return { config, services, policy, reviewers };
}

/**
 * What a claim needs of a repository's plan. `error` is a configuration refusal the claim delivers
 * as `planRefusal`; `revision` is the commit the answer was read at, null only when nothing was.
 */
export interface PlanRead extends ExecutionPlan {
    readonly revision: string | null;
    readonly error: string | null;
}

const OUTAGE_KINDS: readonly string[] = [READ_RATE_LIMITED, READ_TRANSPORT];

const NO_PLAN: ExecutionPlan = { config: null, services: [], policy: {}, reviewers: [] };

export interface PlanReader {
    /**
     * The plan of `repo` at the tip of `baseBranch` (its default branch when null). A refusal is a
     * VALUE; a GitHub failure that says nothing about the repository (rate limit, transport)
     * rejects, so the claim is retried — an outage is never a task's failure.
     */
    read(repo: string, baseBranch: string | null): Promise<PlanRead>;
}

export function createPlanReader(client: Pick<GitHubAppClient, 'readFileAtBranchTip'>): PlanReader {
    return {
        async read(repo, baseBranch) {
            const where = `${repo} at ${baseBranch ? `branch "${baseBranch}"` : 'its default branch'}`;
            let file: Awaited<ReturnType<typeof client.readFileAtBranchTip>>;
            try {
                file = await client.readFileAtBranchTip(repo, baseBranch, BELLOWS_FILE);
            } catch (e) {
                // A rate limit or a dropped connection is the outage; a file the plan cannot use is the repository's.
                if (e instanceof GitHubReadError && OUTAGE_KINDS.includes(e.kind)) throw e;
                return {
                    ...NO_PLAN,
                    revision: null,
                    error: `${BELLOWS_FILE} of ${where} could not be read: ${(e as Error).message}`,
                };
            }
            if (file === null) {
                return {
                    ...NO_PLAN,
                    revision: null,
                    error: `the GitHub App installation cannot read ${where} — check the repository access and the branch name`,
                };
            }
            if (file.text === null) return { ...NO_PLAN, revision: file.revision, error: null };
            try {
                return { ...resolveExecutionPlan(file.text), revision: file.revision, error: null };
            } catch (e) {
                return { ...NO_PLAN, revision: file.revision, error: (e as Error).message };
            }
        },
    };
}
