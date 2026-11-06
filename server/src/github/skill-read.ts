import { READ_BINDING, READ_NOT_FOUND } from '@factory-ai/core';
import { GitHubReadError } from './pr-read.js';

/** One authenticated GET that honours a caller's abort signal. */
export type SignalApiCall = (path: string, signal?: AbortSignal) => Promise<unknown>;

/** A skill a repository ships under `.claude/skills/<dir>/SKILL.md`: the two fields a picker shows. */
export interface RepoSkill {
    readonly name: string;
    readonly description: string;
}

export interface RepoSkillRead {
    /** The commit the skills were read at. */
    readonly revision: string;
    readonly skills: readonly RepoSkill[];
    /** Skill directories whose SKILL.md is absent or unparseable: named, never silently dropped. */
    readonly unreadable: readonly string[];
    /**
     * False when the directory listing was cut (more than `MAX_REPO_SKILLS` skill directories) or held a directory
     * entry that could not be named: a name missing from `skills` is then not known to be absent.
     */
    readonly complete: boolean;
}

export const MAX_REPO_SKILLS = 50;
/** The contents API lists at most this many entries of a directory; a listing that reaches it may be cut. */
export const CONTENTS_LISTING_LIMIT = 1000;
const CONCURRENCY = 5;
/** The whole call: tip, directory and every file. */
const DEADLINE_MS = 10_000;
const CACHE_LIMIT = 200;
const SKILLS_DIR = '.claude/skills';
const DEFAULT_BRANCH_REF = 'HEAD';
const BASE64 = 'base64';

interface ReadOptions {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
}

/** Skills are immutable per commit, so an answer keyed by repo and sha never goes stale. */
const cache = new Map<string, Omit<RepoSkillRead, 'revision'>>();

function unquote(value: string): string {
    const quoted = /^(["'])(.*)\1$/.exec(value);
    return quoted ? (quoted[2] ?? '') : value;
}

/** The indented lines after a `>` / `|` block scalar header at `from`, and where the block ends. */
function blockOf(lines: readonly string[], from: number, end: number): { text: string[]; last: number } {
    const text: string[] = [];
    let last = from;
    while (last + 1 < end && /^\s+\S/.test(lines[last + 1] ?? '')) {
        last += 1;
        text.push((lines[last] ?? '').trim());
    }
    return { text, last };
}

/**
 * `name` and `description` of a SKILL.md, and nothing else. Lenient where core's catalog parser is
 * strict: a repository's skills carry whatever keys their tool supports (`allowed-tools`, `model`, ...),
 * and refusing one for a key the board does not use would hide a skill the agent can load.
 */
export function parseRepoSkillFrontmatter(text: string): RepoSkill | null {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const end = lines[0]?.trim() === '---' ? lines.indexOf('---', 1) : -1;
    if (end === -1) return null;
    const found: Record<string, string> = {};
    for (let i = 1; i < end; i += 1) {
        const top = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '');
        if (!top) continue;
        const value = (top[2] ?? '').trim();
        if (/^[>|][+-]?$/.test(value)) {
            const block = blockOf(lines, i, end);
            found[top[1] as string] = block.text.join(value.startsWith('>') ? ' ' : '\n');
            i = block.last;
        } else {
            found[top[1] as string] = unquote(value);
        }
    }
    return found.name && found.description ? { name: found.name, description: found.description } : null;
}

/** What every read of one call shares. */
interface ReadContext {
    readonly call: SignalApiCall;
    readonly repo: string;
    readonly signal: AbortSignal;
}

async function tipOf(ctx: ReadContext, branch: string | null): Promise<string> {
    const ref = encodeURIComponent(branch ?? DEFAULT_BRANCH_REF);
    const commit = (await ctx.call(`/repos/${ctx.repo}/commits/${ref}`, ctx.signal)) as { sha?: string } | null;
    if (!commit?.sha) throw new GitHubReadError(`no commit sha for ${ctx.repo}@${ref}`, READ_BINDING);
    return commit.sha;
}

/** One element of the directory listing, kept only when it names itself and says what it is. */
interface Listed {
    readonly name: string;
    readonly type: string;
}

const isListed = (entry: unknown): entry is Listed =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as Listed).name === 'string' &&
    typeof (entry as Listed).type === 'string';

/** Entries that cannot hold a skill and say so; any other `type` is an unknown shape, never skipped as harmless. */
const NON_SKILL_TYPES: readonly string[] = ['file', 'symlink', 'submodule'];

/**
 * The listing's skill directories and whether they are ALL of them. Completeness is proven, never assumed: every
 * element must validate (an object with a string `name` and `type`), only a well-formed file, symlink or submodule
 * may be skipped, the directories must fit `MAX_REPO_SKILLS`, and the listing must stay below the contents API's
 * `CONTENTS_LISTING_LIMIT`. A body that is not a listing throws.
 */
async function listSkillDirs(ctx: ReadContext, revision: string): Promise<{ dirs: string[]; complete: boolean }> {
    let body: unknown;
    try {
        body = await ctx.call(`/repos/${ctx.repo}/contents/${SKILLS_DIR}?ref=${revision}`, ctx.signal);
    } catch (e) {
        // Only a 404 on the directory, after the tip resolved, means the repository ships no skills.
        if (e instanceof GitHubReadError && e.kind === READ_NOT_FOUND) return { dirs: [], complete: true };
        throw e;
    }
    if (!Array.isArray(body)) throw new GitHubReadError(`${SKILLS_DIR} is not a directory`, READ_BINDING);
    const valid = body.filter(isListed);
    const dirs = valid.filter((entry) => entry.type === 'dir').map((entry) => entry.name);
    const understood = valid.every((entry) => entry.type === 'dir' || NON_SKILL_TYPES.includes(entry.type));
    return {
        dirs: dirs.slice(0, MAX_REPO_SKILLS),
        complete:
            body.length < CONTENTS_LISTING_LIMIT &&
            valid.length === body.length &&
            understood &&
            dirs.length <= MAX_REPO_SKILLS,
    };
}

/** The parsed skill, null when SKILL.md is absent or unparseable; any other failed read is thrown. */
async function readSkill(ctx: ReadContext, revision: string, dir: string): Promise<RepoSkill | null> {
    let body: { type?: string; encoding?: string; content?: string } | null;
    try {
        body = (await ctx.call(
            `/repos/${ctx.repo}/contents/${SKILLS_DIR}/${encodeURIComponent(dir)}/SKILL.md?ref=${revision}`,
            ctx.signal
        )) as typeof body;
    } catch (e) {
        if (e instanceof GitHubReadError && e.kind === READ_NOT_FOUND) return null;
        throw e;
    }
    if (body?.type !== 'file' || body.encoding !== BASE64 || typeof body.content !== 'string') return null;
    return parseRepoSkillFrontmatter(Buffer.from(body.content, BASE64).toString('utf8'));
}

async function readAll(
    ctx: ReadContext,
    revision: string,
    listing: { dirs: string[]; complete: boolean }
): Promise<Omit<RepoSkillRead, 'revision'>> {
    const { dirs } = listing;
    const parsed: (RepoSkill | null)[] = Array.from({ length: dirs.length }, () => null);
    const queue = dirs.map((dir, index) => ({ dir, index }));
    const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
            parsed[item.index] = await readSkill(ctx, revision, item.dir);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker));
    const skills = parsed.filter((skill): skill is RepoSkill => skill !== null);
    const unreadable = dirs.filter((_dir, index) => parsed[index] === null);
    // A directory whose SKILL.md could not be read may declare any name: the listing proves nothing then.
    return { skills, unreadable, complete: listing.complete && unreadable.length === 0 };
}

/**
 * The repository's own skills at the tip of `branch` (the default branch when null). Resolves only
 * for a confirmed answer; a failed, forbidden, malformed or timed-out read throws, because "the
 * repository has no skills" is a verdict only a 404 on the skills directory may give.
 */
export async function readRepoSkills(
    call: SignalApiCall,
    repo: string,
    branch: string | null,
    options: ReadOptions = {}
): Promise<RepoSkillRead> {
    const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const run = async (): Promise<RepoSkillRead> => {
        const ctx = { call, repo, signal };
        const revision = await tipOf(ctx, branch);
        const key = `${repo}@${revision}`;
        const hit = cache.get(key);
        if (hit) return { revision, ...hit };
        const read = await readAll(ctx, revision, await listSkillDirs(ctx, revision));
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
        cache.set(key, read);
        return { revision, ...read };
    };
    // The deadline also wins against a call that ignores its signal; the listener is dropped on
    // settle so a later timeout rejects nothing.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('skills read aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([run(), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
