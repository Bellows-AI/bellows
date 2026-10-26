/**
 * `.bellows.yaml` — the gate declaration a repository may ship at its checkout root.
 *
 * The grammar is a deliberately tiny subset of YAML, hand-parsed: no YAML package exists in this
 * repo and none may be added for one file. Strictness is the point — a construct outside the
 * subset is a named error, never a best-effort read, because a silently dropped gate is a check
 * that never ran while everybody believed it did.
 *
 * Accepted (the issue's example is the shape):
 *
 *     environment:
 *         image: node:24
 *         gates:
 *              - name: test
 *                command: "npm test"
 *
 * A gate may also carry `timeout: <minutes>` — its own wall-clock budget in place of the driver's
 * GATE_TIMEOUT_MS (`readTimeoutMinutes`) — and `on_demand: true`: the agent may run it ad hoc, the
 * end-of-run gates pass skips it.
 * `filter: true` lets the agent narrow an ad-hoc run (`{"gate":"<name>","filter":"<string>"}`): the
 * string reaches the command as env `GATE_FILTER` for that one run, and the end-of-run gates pass
 * never sets it.
 *
 * `environment:` may also carry `setup: <command>` — run in the worktree before the agent starts
 * and retried before the first gate while it fails (an install step); its failure is a setup
 * failure, not a gate's.
 *
 * `environment:` may also carry `cache:` — a list of `- NAME` env names, each set by the driver to
 * `<member>/.cache/<owner>/<repo>/<NAME>` in the runner and gate env, a directory that outlives the
 * container (`readCacheItem`). Declared before `gates:`; names the driver owns or a runtime runs
 * code from are refused (`bellows-cache.ts`).
 *
 * One exception, and it is not leniency: a top-level `services:` block is the SERVICES half of
 * the file, read by `bellows-services.ts`, and one file may carry both
 * halves. This parser skips the block wholesale — it does not judge the services grammar, and a
 * services-only file parses to no gates — while every other unknown top-level key is still
 * refused.
 *
 * A top-level `policy:` block configures the evidence a task must carry before it publishes or
 * completes: `gates: required` and/or `review: required`, the one value each key takes.
 * The plan is read at the base branch tip through the GitHub API, never from the task worktree, so a run cannot
 * edit away the requirement it must meet.
 *
 * A top-level `reviewers:` block declares named reviewer profiles an agent may invoke as a separate
 * run (issue #549): `- name:`, `instructions:`, and optionally `timeout:` (minutes) and
 * `connections:` (a comma list of the env names the reviewer may receive — nothing else of the
 * member's env reaches it). Like `policy:`, it is read at the base branch tip, never from the task worktree.
 *
 * Comments, blank lines, and bare / single- / double-quoted scalars are tolerated. Everything
 * else — tabs, unknown keys, a seventeenth gate, a flag-shaped image — throws with the line
 * number, and `bellows-plan.ts` turns that into the claim's `planRefusal`.
 */

import { type CacheBlock, closeCache, newCacheBlock, openCache, readCacheItem } from './bellows-cache.js';
import { BellowsError, fail, KEY_VALUE, MAX_COMMAND_LENGTH, readTimeoutMinutes, scalar } from './bellows-grammar.js';
import {
    consumeReviewerLine,
    finishReviewer,
    newReviewersBlock,
    openReviewersBlock,
    type ReviewerProfile,
    type ReviewersBlock,
} from './bellows-reviewers.js';

export { REVIEWER_DEFAULT_TIMEOUT_MINUTES, type ReviewerProfile } from './bellows-reviewers.js';

export interface GateDef {
    readonly name: string;
    readonly command: string;
    /** The gate's own wall-clock budget; absent, the driver's GATE_TIMEOUT_MS bounds it. */
    readonly timeoutMinutes?: number;
    /** Ad hoc only: the end-of-run gates pass, and so the gate evidence, skips it. */
    readonly onDemand?: true;
    /** The ad-hoc endpoint may narrow a run of it: the request's `filter` becomes env `GATE_FILTER`. */
    readonly filter?: true;
}

/** The evidence a repository requires; an absent key requires nothing. */
export interface EvidencePolicy {
    gates?: true;
    review?: true;
}

export const POLICY_REQUIRED = 'required';
const POLICY_KEYS = ['gates', 'review'] as const;

export interface BellowsConfig {
    readonly image: string;
    /** Runs before the agent starts, retried before the first gate while it fails; absent when none is declared. */
    readonly setup?: string;
    /** Env names the driver points at the member's per-repo cache directory; absent when none. */
    readonly cache?: readonly string[];
    readonly gates: readonly GateDef[];
}

/** Same rules a checkout directory obeys (`badSegment`), plus a length a pill can render. */
const MAX_NAME_LENGTH = 64;
const MAX_GATES = 16;

/** Docker ref shape: no whitespace, no `$` expansion, nothing a CLI would read as a flag. */
const IMAGE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

function checkImage(line: number, image: string): string {
    if (!IMAGE_PATTERN.test(image)) {
        fail(line, `image must be a plain docker reference, got "${image}"`);
    }
    return image;
}

function checkName(line: number, name: string): string {
    if (!name) fail(line, 'gate name is empty');
    if (/[/\\]/.test(name)) fail(line, `gate name "${name}" contains a path separator`);
    if (/^[-.]/.test(name)) fail(line, `gate name "${name}" starts with "-" or "."`);
    if (name.length > MAX_NAME_LENGTH) {
        fail(line, `gate name is longer than ${MAX_NAME_LENGTH} characters`);
    }
    return name;
}

interface RawGate {
    name?: string;
    command?: string;
    timeoutMinutes?: number;
    onDemand?: true;
    filter?: true;
}

interface BellowsState {
    image: string | null;
    setup: string | null;
    /** The `cache:` list under `environment:` (`bellows-cache.ts`). */
    cache: CacheBlock;
    inEnvironment: boolean;
    inGates: boolean;
    /** Inside a top-level `services:` block — the services half, not this parser's grammar. */
    inServices: boolean;
    seenServices: boolean;
    /** Inside a top-level `policy:` block, and whether one was seen. */
    inPolicy: boolean;
    seenPolicy: boolean;
    policy: EvidencePolicy;
    /** The top-level `reviewers:` block (`bellows-reviewers.ts`). */
    reviewers: ReviewersBlock;
    itemIndent: number;
    /** Where the gate currently being read began — the line its errors name. */
    itemLine: number;
    current: RawGate | null;
    gates: GateDef[];
}

function finishGate(state: BellowsState): void {
    if (!state.current) return;
    const line = state.itemLine;
    const current = state.current;
    if (current.command === undefined) {
        fail(line, `gate "${current.name ?? '?'}" has no command`);
    }
    if (current.command.trim() === '') {
        fail(line, `gate "${current.name ?? '?'}" has an empty command`);
    }
    const name = checkName(line, current.name ?? '');
    if (state.gates.some((gate) => gate.name === name)) {
        fail(line, `gate "${name}" is declared twice`);
    }
    if (state.gates.length >= MAX_GATES) {
        fail(line, `more than ${MAX_GATES} gates`);
    }
    state.gates.push({
        name,
        command: current.command,
        ...(current.timeoutMinutes === undefined ? {} : { timeoutMinutes: current.timeoutMinutes }),
        ...(current.onDemand ? { onDemand: true as const } : {}),
        ...(current.filter ? { filter: true as const } : {}),
    });
    state.current = null;
}

/** The `policy:` header: one block per file, no inline value. */
function openPolicyBlock(state: BellowsState, line: number, inlineValue: string | undefined): void {
    if (state.seenPolicy) fail(line, 'a second "policy:" block');
    if (inlineValue !== undefined && inlineValue !== '') fail(line, 'policy takes keys, not a value');
    state.seenPolicy = true;
    state.inPolicy = true;
}

/**
 * A top-level (indent 0) line: `environment:` opens the block this parser reads; `services:` is
 * skipped wholesale as the driver's own grammar; anything else is refused.
 */
function handleTopLevelLine(state: BellowsState, line: number, trimmed: string): void {
    closeCache(state.cache);
    finishGate(state);
    state.inGates = false;
    state.itemIndent = -1;
    const match = KEY_VALUE.exec(trimmed);
    if (!match) {
        fail(line, `expected "environment:" at the top level, got "${trimmed}"`);
    }
    if (match[1] === 'services') {
        if (state.seenServices) fail(line, 'a second "services:" block');
        if (match[3] !== undefined && match[3] !== '') {
            fail(line, 'services takes a list, not a value');
        }
        state.seenServices = true;
        state.inServices = true;
        return;
    }
    if (match[1] === 'policy') {
        openPolicyBlock(state, line, match[3]);
        return;
    }
    if (match[1] === 'reviewers') {
        openReviewersBlock(state.reviewers, line, match[3]);
        return;
    }
    if (match[1] !== 'environment') {
        fail(
            line,
            `unknown top-level key "${match[1]}" — only "environment:", "services:", "policy:" and "reviewers:" are read`
        );
    }
    if (state.inEnvironment) fail(line, 'a second "environment:" block');
    if (match[3] !== undefined && match[3] !== '') {
        fail(line, 'environment takes no inline value');
    }
    state.inEnvironment = true;
}

/** A `- name: <name>` line opening one gate list item. */
function handleGateStart(state: BellowsState, line: number, indent: number, trimmed: string): void {
    if (!state.inGates) fail(line, 'a list item outside "gates:"');
    finishGate(state);
    state.itemIndent = indent;
    state.itemLine = line;
    const rest = trimmed.slice(2);
    const match = KEY_VALUE.exec(rest);
    if (!match || match[1] !== 'name' || match[3] === undefined) {
        fail(line, `a gate starts with "- name: <name>", got "${trimmed}"`);
    }
    state.current = { name: scalar(line, match[3], 'name') };
}

/** A gate's `command:` — one line, at most MAX_COMMAND_LENGTH characters. */
function readGateCommand(line: number, raw: string | undefined): string {
    if (raw === undefined) fail(line, 'command takes a value');
    if (raw.length > MAX_COMMAND_LENGTH) fail(line, `command is longer than ${MAX_COMMAND_LENGTH} characters`);
    return scalar(line, raw, 'command');
}

/** The `true`-only gate fields, by their YAML key. */
const GATE_FLAGS = new Map<string, 'onDemand' | 'filter'>([
    ['on_demand', 'onDemand'],
    ['filter', 'filter'],
]);

/** A field indented under the open gate item (`name:` / `command:` / `timeout:` / `on_demand:` / `filter:`). */
function handleGateField({
    state,
    line,
    indent,
    key,
    match,
}: {
    state: BellowsState;
    line: number;
    indent: number;
    key: string;
    match: RegExpExecArray;
}): void {
    if (state.itemIndent === -1 || indent <= state.itemIndent) {
        fail(line, `"${key}" is not indented under its "- name:" item`);
    }
    if (!state.current) fail(line, `"${key}" before the "- name:" that opens the gate`);
    const flag = GATE_FLAGS.get(key);
    if (flag) {
        if (scalar(line, match[3] ?? '', key) !== 'true') fail(line, `${key} must be "true"`);
        state.current[flag] = true;
    } else if (key === 'name') {
        if (match[3] === undefined) fail(line, 'name takes a value');
        state.current.name = scalar(line, match[3] ?? '', 'name');
    } else if (key === 'command') {
        state.current.command = readGateCommand(line, match[3]);
    } else if (key === 'timeout') {
        state.current.timeoutMinutes = readTimeoutMinutes(line, match[3] ?? '');
    } else {
        fail(line, `unknown gate field "${key}" — only name, command, timeout, on_demand and filter are read`);
    }
}

/** `setup: <command>` under `environment:` — one non-empty command, declared once. */
function readSetup(state: BellowsState, line: number, raw: string | undefined): void {
    if (raw === undefined) fail(line, 'setup takes a value');
    if (state.setup !== null) fail(line, 'setup is declared twice');
    const command = scalar(line, raw, 'setup');
    if (command.trim() === '') fail(line, 'setup is empty');
    if (command.length > MAX_COMMAND_LENGTH) {
        fail(line, `setup is longer than ${MAX_COMMAND_LENGTH} characters`);
    }
    state.setup = command;
}

/** A `- ` list item: a cache name while `cache:` is open, otherwise a gate. */
function handleListItem(state: BellowsState, line: number, indent: number, trimmed: string): void {
    if (state.cache.open) {
        readCacheItem(state.cache, line, trimmed);
    } else {
        handleGateStart(state, line, indent, trimmed);
    }
}

/** A direct child of `environment:` (`image:` / `setup:` / `cache:` / `gates:`). */
function handleEnvironmentField(state: BellowsState, line: number, key: string, match: RegExpExecArray): void {
    closeCache(state.cache);
    const hasValue = match[3] !== undefined;
    if (key === 'image') {
        if (!hasValue) fail(line, 'image takes a value');
        state.image = checkImage(line, scalar(line, match[3] ?? '', 'image'));
    } else if (key === 'setup') {
        readSetup(state, line, match[3]);
    } else if (key === 'cache') {
        openCache(state.cache, line, match[3]);
    } else if (key === 'gates') {
        // `gates:` with nothing after it — including a trailing space, the same courtesy
        // `environment:` gets — opens the list. A real inline value is outside the subset.
        if (hasValue && match[3] !== '') fail(line, 'gates takes a list, not a value');
        state.inGates = true;
    } else {
        fail(line, `unknown key "${key}" inside environment — only image, setup, cache and gates are read`);
    }
}

/** `gates: required` / `review: required` under `policy:` — the one value is `required`. */
function handlePolicyField(state: BellowsState, line: number, trimmed: string): void {
    const match = KEY_VALUE.exec(trimmed);
    const key = POLICY_KEYS.find((candidate) => candidate === match?.[1]);
    if (!match || key === undefined) {
        fail(line, `unknown policy key "${match?.[1] ?? trimmed}" — only ${POLICY_KEYS.join(' and ')} are read`);
    }
    if (state.policy[key]) fail(line, `policy ${key} is declared twice`);
    if (scalar(line, match[3] ?? '', key) !== POLICY_REQUIRED) {
        fail(line, `policy ${key} must be "${POLICY_REQUIRED}"`);
    }
    state.policy[key] = true;
}

/** One non-blank, non-comment line of the file, dispatched to the block its indentation names. */
function processLine(state: BellowsState, line: number, rawLine: string): void {
    const trimmed = rawLine.trim();
    const indent = rawLine.length - rawLine.trimStart().length;
    if (rawLine.slice(0, indent).includes('\t')) {
        fail(line, 'tabs are not allowed for indentation, use spaces');
    }

    // The services half of the file: every line of its body is deeper than the top level, so
    // indentation alone ends the block and hands the next top-level key back to this loop.
    // The check sits before the list-item branch — a `- name:` inside `services:` is Drone's,
    // not a gate list item.
    if (state.inServices) {
        if (indent > 0) return;
        state.inServices = false;
    }

    if (state.inPolicy) {
        if (indent > 0) {
            handlePolicyField(state, line, trimmed);
            return;
        }
        state.inPolicy = false;
    }

    if (consumeReviewerLine(state.reviewers, line, indent, trimmed)) return;

    if (indent === 0) {
        handleTopLevelLine(state, line, trimmed);
        return;
    }

    if (!state.inEnvironment) {
        fail(line, `indented content before "environment:" — "${trimmed}"`);
    }

    if (trimmed.startsWith('- ')) {
        handleListItem(state, line, indent, trimmed);
        return;
    }

    const match = KEY_VALUE.exec(trimmed);
    if (!match) fail(line, `cannot read "${trimmed}"`);
    const key = match[1] ?? '';

    if (state.inGates) {
        handleGateField({ state, line, indent, key, match });
    } else {
        handleEnvironmentField(state, line, key, match);
    }
}

export function parseBellows(text: string): BellowsConfig | null {
    return parseBellowsWithPolicy(text).config;
}

/** The gates half, the evidence policy and the reviewer profiles of one file. */
export function parseBellowsWithPolicy(text: string): {
    config: BellowsConfig | null;
    policy: EvidencePolicy;
    reviewers: ReviewerProfile[];
} {
    const state: BellowsState = {
        image: null,
        setup: null,
        cache: newCacheBlock(),
        inEnvironment: false,
        inGates: false,
        inServices: false,
        seenServices: false,
        inPolicy: false,
        seenPolicy: false,
        policy: {},
        reviewers: newReviewersBlock(),
        itemIndent: -1,
        itemLine: 0,
        current: null,
        gates: [],
    };

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index] ?? '';
        const line = index + 1;
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        processLine(state, line, rawLine);
    }
    closeCache(state.cache);
    finishGate(state);
    finishReviewer(state.reviewers);

    // A required gate with nothing declared would pass vacuously — the opposite of the requirement.
    if (state.policy.gates && !state.inEnvironment) {
        throw new BellowsError('.bellows.yaml: policy requires gates but no environment declares any');
    }
    const reviewers = state.reviewers.profiles;
    if (!state.inEnvironment) return { config: null, policy: state.policy, reviewers };
    if (state.image === null) throw new BellowsError('.bellows.yaml: environment declares no image');
    const config = {
        image: state.image,
        ...(state.setup === null ? {} : { setup: state.setup }),
        ...(state.cache.names === null ? {} : { cache: state.cache.names }),
        gates: state.gates,
    };
    return { config, policy: state.policy, reviewers };
}
