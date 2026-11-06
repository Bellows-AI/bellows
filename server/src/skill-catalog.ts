import {
    isReservedSkillName,
    resolveSkillCatalog,
    type CatalogEntry,
    type Skill,
    type SourceSkill,
} from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import type { RepoSkillRead } from './github/skill-read.js';

/** The org's repo skills read (`OrgRuntime.repoSkills`): rejects when the read did not confirm. */
export type RepoSkillReader = (repo: string, branch: string | null, signal?: AbortSignal) => Promise<RepoSkillRead>;

/**
 * What the repository read answered. Only a `complete` `read` may confirm an absence, and then only for a name that is not in
 * `unreadable`; `unconfirmed` (no reader, a throw, a timeout, an abort) is no verdict (AGENTS.md: an unconfirmed read).
 */
export type RepoReadState =
    | { state: 'not-asked' }
    | { state: 'read'; revision: string; unreadable: readonly string[]; complete: boolean }
    | { state: 'unconfirmed'; error: string };

export interface EffectiveCatalog {
    /** Every source's entries in precedence order; the first entry of a name is the one that wins. */
    entries: CatalogEntry[];
    /** Non-built-in names under the reserved prefix: neither selectable nor listed. */
    reserved: string[];
    repo: RepoReadState;
}

export interface CatalogRequest {
    builtin: readonly Skill[];
    /** The reader of the caller's org board; undefined when it has none. */
    read: RepoSkillReader | undefined;
    repo: string | null;
    branch: string | null;
    signal?: AbortSignal;
    /** Called with the cause of an unconfirmed read. */
    onUnconfirmed?: (cause: unknown) => void;
    /**
     * The names the caller is about to check. When none is outside the sources that need no read the repository is
     * not asked, so selecting built-ins costs no GitHub call.
     */
    need?: readonly string[];
}

/**
 * The catalog a task selects from: built-ins, then (BEL-271) org and workspace skills, then the repository's own at
 * `branch`. Org and workspace are empty until their stores exist; they join here, so every consumer sees them at once.
 */
export async function effectiveCatalog(request: CatalogRequest): Promise<EffectiveCatalog> {
    const builtinNames = new Set(request.builtin.map((skill) => skill.name));
    const needsRepo =
        request.repo !== null &&
        (request.need === undefined ||
            request.need.some((name) => !builtinNames.has(name) && !isReservedSkillName(name)));
    let repo: RepoReadState = { state: 'not-asked' };
    let held: readonly SourceSkill[] = [];
    if (request.repo !== null && needsRepo) {
        try {
            if (!request.read) throw new Error('Repository skills cannot be read on this board');
            const read = await request.read(request.repo, request.branch, request.signal);
            held = read.skills;
            repo = {
                state: 'read',
                revision: read.revision,
                unreadable: [...read.unreadable],
                complete: read.complete,
            };
        } catch (cause) {
            request.onUnconfirmed?.(cause);
            repo = { state: 'unconfirmed', error: cause instanceof Error ? cause.message : String(cause) };
        }
    }
    const { entries, reserved } = resolveSkillCatalog({ builtin: request.builtin, org: [], workspace: [], repo: held });
    return { entries, reserved, repo };
}

export type SkillStanding = 'known' | 'absent' | 'unverified';

/**
 * Whether a selected name can run. `absent` only from evidence: a read that succeeded and does not list it, a name
 * the reserved prefix keeps for built-ins, or a task with no repository to read. A read that did not confirm, or a
 * directory of that name the read could not parse, is `unverified`.
 */
export function standingOf(catalog: EffectiveCatalog, name: string): SkillStanding {
    if (catalog.entries.some((entry) => entry.name === name)) return 'known';
    if (isReservedSkillName(name)) return 'absent';
    const { repo } = catalog;
    // A cut or partly unnameable listing cannot say a name is missing.
    if (repo.state === 'read') return repo.complete && !repo.unreadable.includes(name) ? 'absent' : 'unverified';
    return repo.state === 'unconfirmed' ? 'unverified' : 'absent';
}

/** The distinct selectable names, for a refusal that lists what is installed. */
export function installedNames(catalog: EffectiveCatalog): string[] {
    return [...new Set(catalog.entries.map((entry) => entry.name))];
}

/** Aborts when the client goes away before the answer is sent; a finished response is not an abort. */
export function abortOnClose(reply: FastifyReply): AbortSignal {
    const controller = new AbortController();
    reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
    });
    return controller.signal;
}
