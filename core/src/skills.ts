/**
 * Reusable skills (issue #545): the `docker/skills/<name>/SKILL.md` files both executor images
 * bake. A task selects skills by name; a skill declares the tools and connections it needs in its
 * frontmatter `metadata:` block, and the board checks them at claim time. A skill is instructions
 * plus a declaration — loading one never grants access, and nothing here reads an env VALUE.
 */

/** Agent Skills naming rule (the stricter of Claude Code's and OpenCode's). */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_LIMIT = 64;
/** Built-in skills, and only they, are named under this prefix; every other source is refused it. */
export const RESERVED_SKILL_PREFIX = 'factory-';

export function isReservedSkillName(name: string): boolean {
    return name.startsWith(RESERVED_SKILL_PREFIX);
}

/** Skill bundle limits (an uploaded skill is a SKILL.md plus supporting files): count, total and per-file bytes. */
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const SKILL_MIB = 5;
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BYTES = SKILL_MIB * BYTES_PER_MIB;
export const MAX_SKILL_FILE_BYTES = BYTES_PER_MIB;

/** The most skills one task may select. */
export const MAX_TASK_SKILLS = 16;

/** Tools both executor images ship; `core/test/skills.test.ts` pins each against the Dockerfiles. */
export const RUNNER_TOOLS = ['acli', 'curl', 'gh', 'git'] as const;

/**
 * A connection is a named integration; the env names the board must hold for it in the task's
 * resolved env (org, workspace, repository scopes — docs/env.md). Presence is checked, never value.
 * A MANAGED connection (docs/connections.md) holds no env names: the board keeps the credential, so
 * it is listed in `INTEGRATION_PROVIDERS` instead.
 */
export const SKILL_CONNECTIONS = {
    github: [],
    jira: [],
} as const satisfies Record<string, readonly string[]>;

/**
 * The integrations a skill may require, each with the `label` a person sees. A `connection` provider is
 * bound to a task through the `connections` field of `POST /api/jobs`; `github` is a legacy repository
 * capability the task never selects: the org's GitHub App installation provides it.
 */
export const INTEGRATION_PROVIDERS = {
    github: { kind: 'legacy-repository-capability', label: 'GitHub' },
    jira: { kind: 'connection', label: 'Jira' },
} as const satisfies Record<
    keyof typeof SKILL_CONNECTIONS,
    { kind: 'connection' | 'legacy-repository-capability'; label: string }
>;

/** The field that selects a provider for a task, or null for a provider the task never selects. */
export function selectedBy(provider: string): 'connections' | null {
    return Object.hasOwn(INTEGRATION_PROVIDERS, provider) &&
        INTEGRATION_PROVIDERS[provider as keyof typeof INTEGRATION_PROVIDERS].kind === 'connection'
        ? 'connections'
        : null;
}

export interface SkillRequirements {
    tools: string[];
    connections: string[];
}

export interface Skill {
    name: string;
    description: string;
    requires: SkillRequirements;
}

/** Where a selectable skill comes from, highest precedence first (a name held by two sources keeps the first). */
export const SKILL_SOURCES = ['builtin', 'org', 'workspace', 'repo'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/** A selectable skill and where it came from; `shadowedBy` names the higher source that holds the same name. */
export interface CatalogEntry extends Skill {
    source: SkillSource;
    shadowedBy?: SkillSource;
}

/** A skill a source holds; `requires` is absent for a source that declares none (a repository's). */
export interface SourceSkill {
    name: string;
    description: string;
    requires?: SkillRequirements;
}

/** The skills each source holds. Only built-ins and org/workspace skills carry requirements; a repo skill declares none. */
export interface SkillSources {
    builtin: readonly SourceSkill[];
    org?: readonly SourceSkill[];
    workspace?: readonly SourceSkill[];
    repo?: readonly SourceSkill[];
}

export interface ResolvedCatalog {
    /** In precedence order: the first entry of a name is the one that wins. */
    entries: CatalogEntry[];
    /** Names a non-built-in source offered under the reserved prefix without a built-in of that name: not selectable. */
    reserved: string[];
}

/**
 * One catalog from every source. A name held by several sources keeps the highest (`SKILL_SOURCES` order) and lists
 * the lower ones marked `shadowedBy`; a non-built-in `factory-*` name no built-in holds is dropped into `reserved`.
 * Pure: no source is read here, so an unread source is simply absent.
 */
export function resolveSkillCatalog(sources: SkillSources): ResolvedCatalog {
    const entries: CatalogEntry[] = [];
    const reserved: string[] = [];
    const winners = new Map<string, SkillSource>();
    for (const source of SKILL_SOURCES) {
        for (const held of distinctByName(sources[source] ?? [])) {
            const winner = winners.get(held.name);
            if (winner === undefined && source !== 'builtin' && isReservedSkillName(held.name)) {
                reserved.push(held.name);
                continue;
            }
            entries.push(entryOf(held, source, winner));
            if (winner === undefined) winners.set(held.name, source);
        }
    }
    return { entries, reserved };
}

/** A source's first skill of each name: two directories of one repository may declare the same name. */
function distinctByName(held: readonly SourceSkill[]): SourceSkill[] {
    return held.filter((skill, index) => held.findIndex((other) => other.name === skill.name) === index);
}

function entryOf(held: SourceSkill, source: SkillSource, shadowedBy: SkillSource | undefined): CatalogEntry {
    const requires: SkillRequirements = held.requires ?? { tools: [], connections: [] };
    return {
        name: held.name,
        description: held.description,
        source,
        requires,
        ...(shadowedBy === undefined ? {} : { shadowedBy }),
    };
}

const TOOLS_KEY = 'requires-tools';
const CONNECTIONS_KEY = 'requires-connections';

function list(value: string): string[] {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

/**
 * Parses a SKILL.md's frontmatter: single-line `name:` and `description:`, then an optional
 * `metadata:` block of two-space-indented `requires-tools:` / `requires-connections:` comma lists.
 * `metadata` is the Agent Skills string-to-string map, so both CLIs tolerate it. Anything else is
 * an error: a declaration the board cannot read must not look like "no requirements".
 */
export function parseSkillFrontmatter(text: string, dirName: string): Skill {
    const entries = readEntries(frontmatterLines(text, dirName), dirName);
    const { name, description, requires } = entries;
    if (name !== dirName) throw new Error(`${dirName}: name "${name}" must equal its directory`);
    if (!SKILL_NAME.test(name) || name.length > SKILL_NAME_LIMIT) throw new Error(`${dirName}: bad skill name`);
    if (description === null || description === '') throw new Error(`${dirName}: missing description`);
    checkRequirements(requires, dirName);
    return { name, description, requires };
}

interface Entries {
    name: string | null;
    description: string | null;
    requires: SkillRequirements;
}

function frontmatterLines(text: string, dirName: string): string[] {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== '---') throw new Error(`${dirName}: SKILL.md does not start with frontmatter`);
    const end = lines.indexOf('---', 1);
    if (end === -1) throw new Error(`${dirName}: SKILL.md frontmatter is not closed`);
    return lines.slice(1, end);
}

function readEntries(lines: readonly string[], dirName: string): Entries {
    const entries: Entries = { name: null, description: null, requires: { tools: [], connections: [] } };
    let inMetadata = false;
    for (const line of lines) {
        const indented = /^ {2}(\S[^:]*):\s*(.*)$/.exec(line);
        if (inMetadata && indented) {
            applyMetadata(entries.requires, indented[1] ?? '', indented[2] ?? '', dirName);
            continue;
        }
        const top = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
        if (!top) throw new Error(`${dirName}: unreadable frontmatter line "${line}"`);
        inMetadata = top[1] === 'metadata';
        applyTopLevel(entries, top[1] ?? '', top[2] ?? '', dirName);
    }
    return entries;
}

function applyMetadata(requires: SkillRequirements, key: string, value: string, dirName: string): void {
    if (key === TOOLS_KEY) requires.tools = list(value);
    else if (key === CONNECTIONS_KEY) requires.connections = list(value);
    else throw new Error(`${dirName}: unknown metadata key "${key}"`);
}

function applyTopLevel(entries: Entries, key: string, value: string, dirName: string): void {
    if (key === 'name') entries.name = value;
    else if (key === 'description') entries.description = value;
    else if (key !== 'metadata') throw new Error(`${dirName}: unknown frontmatter key "${key}"`);
}

function checkRequirements(requires: SkillRequirements, dirName: string): void {
    for (const tool of requires.tools) {
        if (!(RUNNER_TOOLS as readonly string[]).includes(tool)) throw new Error(`${dirName}: unknown tool "${tool}"`);
    }
    for (const connection of requires.connections) {
        if (!Object.hasOwn(SKILL_CONNECTIONS, connection)) {
            throw new Error(`${dirName}: unknown connection "${connection}"`);
        }
    }
}

/** The env names a connection needs, or [] for a name the catalog does not know. */
export function connectionEnvNames(connection: string): readonly string[] {
    return Object.hasOwn(SKILL_CONNECTIONS, connection)
        ? SKILL_CONNECTIONS[connection as keyof typeof SKILL_CONNECTIONS]
        : [];
}

/** What a task lacking a managed connection must do: select it, or (github) install the App. */
function managedProblem(skill: string, connection: string): string {
    return selectedBy(connection) === null
        ? `skill "${skill}" needs the ${connection} connection: install the GitHub App on this organization`
        : `skill "${skill}" needs the ${connection} connection: select one with \`connections\` when creating the task`;
}

/** The bindable providers the selected skills require, in first-seen order; github is never one. */
export function requiredProviders(catalog: readonly Skill[], selected: readonly string[]): string[] {
    const providers: string[] = [];
    for (const name of selected) {
        for (const connection of catalog.find((skill) => skill.name === name)?.requires.connections ?? []) {
            if (selectedBy(connection) !== null && !providers.includes(connection)) providers.push(connection);
        }
    }
    return providers;
}

/**
 * One sentence per problem in a selection, or an empty list: a selected name the catalog lacks, and
 * each env connection whose env names are not all present with a non-empty value in `env`, and each
 * managed connection the task does not hold (`managed` lists the ones it does). Names only — the
 * sentence is shown to the user and must never carry a value.
 */
export function skillSelectionProblems(
    catalog: readonly Skill[],
    selected: readonly string[],
    env: Readonly<Record<string, string>>,
    managed: readonly string[] = []
): string[] {
    const problems: string[] = [];
    for (const name of selected) {
        const skill = catalog.find((candidate) => candidate.name === name);
        if (!skill) {
            problems.push(`skill "${name}" is not installed (installed: ${catalog.map((s) => s.name).join(', ')})`);
            continue;
        }
        for (const connection of skill.requires.connections) {
            if (Object.hasOwn(INTEGRATION_PROVIDERS, connection)) {
                if (!managed.includes(connection)) problems.push(managedProblem(name, connection));
                continue;
            }
            const missing = connectionEnvNames(connection).filter((key) => !env[key]);
            if (missing.length > 0) {
                problems.push(
                    `skill "${name}" needs the ${connection} connection: set ${missing.join(', ')} in the task's environment settings`
                );
            }
        }
    }
    return problems;
}
