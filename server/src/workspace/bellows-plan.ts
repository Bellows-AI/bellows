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

import { formatRepoRef, READ_RATE_LIMITED, READ_TRANSPORT, type RepoRef } from '@factory-ai/core';
import { INSTALLATION_CREDENTIAL, resolveForgeClient, type ForgeSource } from '../forge/forge-client.js';
import type { RepoFileRead } from '../github/file-read.js';
import { GitHubReadError } from '../github/pr-read.js';
import { BellowsError } from './bellows-grammar.js';
import { MAX_SERVICES, parseServices, type ServiceSpec } from './bellows-services.js';
import { parseBellowsWithPolicy, type BellowsConfig, type EvidencePolicy, type ReviewerProfile } from './bellows.js';

export type { ServiceSpec } from './bellows-services.js';

export const BELLOWS_FILE = '.bellows.yaml';

/** A service named like this would shadow the loopback address its siblings reach each other on. */
const RESERVED_SERVICE_NAMES: readonly string[] = ['localhost'];

/**
 * The most tmpfs one plan may declare, in Mi. Each mount is memory added to its service's request
 * and limit in the task pod, so an oversized total would leave the pod unschedulable.
 */
const MAX_TMPFS_TOTAL_MI = 8192;
const MI_PER_GI = 1024;

/** A grammar-checked `<n>Mi` or `<n>Gi` size, in Mi. */
function tmpfsMi(size: string): number {
    const count = Number(size.slice(0, -2));
    return size.endsWith('Gi') ? count * MI_PER_GI : count;
}

/** The plan's tmpfs total past the cap, naming the services that declare one; nothing within it. */
function tmpfsOverCap(services: readonly ServiceSpec[]): string[] {
    const declaring = services.filter((service) => (service.tmpfs ?? []).length > 0);
    const total = declaring.reduce(
        (sum, service) => sum + (service.tmpfs ?? []).reduce((acc, mount) => acc + tmpfsMi(mount.size), 0),
        0
    );
    if (total <= MAX_TMPFS_TOTAL_MI) return [];
    const names = declaring.map((service) => `"${service.name}"`).join(' and ');
    return [
        `${declaring.length === 1 ? `service ${names} declares` : `services ${names} declare`} ${total}Mi of tmpfs — ` +
            'at most 8Gi of tmpfs fits one task pod',
    ];
}

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
    return [...problems, ...portCollisions(services), ...tmpfsOverCap(services)];
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
     * The plan of `ref` at the tip of `baseBranch` (its default branch when null). A refusal is a
     * VALUE; a GitHub failure that says nothing about the repository (rate limit, transport)
     * rejects, so the claim is retried — an outage is never a task's failure.
     */
    read(ref: RepoRef, baseBranch: string | null): Promise<PlanRead>;
}

/** What a plan reader names in its refusals: the repository and the branch the read was about. */
export const planSubject = (ref: RepoRef, baseBranch: string | null): string =>
    `${formatRepoRef(ref)} at ${baseBranch ? `branch "${baseBranch}"` : 'its default branch'}`;

/**
 * The validation every plan source shares: `readFile` answers the plan file at the branch tip (null when the
 * repository or branch is confirmed absent), and `where` names the subject in a refusal. An outage rejects.
 */
export async function readPlanWith(
    readFile: (path: string) => Promise<RepoFileRead | null>,
    where: string
): Promise<PlanRead> {
    let file: RepoFileRead | null;
    try {
        file = await readFile(BELLOWS_FILE);
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
}

export function createPlanReader(forge: ForgeSource): PlanReader {
    return {
        async read(ref, baseBranch) {
            const where = planSubject(ref, baseBranch);
            // The App installation reads github.com only: any other forge or host is a capability fact, not a read.
            const resolution = resolveForgeClient(forge, ref, INSTALLATION_CREDENTIAL);
            if (!resolution.ok) {
                return {
                    ...NO_PLAN,
                    revision: null,
                    error: `${BELLOWS_FILE} of ${where} cannot be read: this board reads plans from github.com only, not ${ref.host}`,
                };
            }
            return readPlanWith((path) => resolution.client.readFile(baseBranch, path), where);
        },
    };
}
