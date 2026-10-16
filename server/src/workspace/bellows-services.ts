/**
 * The services half of `.bellows.yaml` (a top-level `services:` block), parsed by the board when it
 * resolves a claim's execution plan (`bellows-plan.ts`). The gates half is `bellows.ts`; one file
 * may carry both and each parser skips the other's block wholesale.
 */

/** One declared service, parsed. `environment` preserves the file's order. */
export interface ServiceSpec {
    name: string;
    image: string;
    environment: { key: string; value: string }[];
    /**
     * The declared hardening opt-out: present only when the file asked for it. Restores the image's
     * default capability set and nothing else (the escalation bit stays off, seccomp stays on).
     * Absent rather than `false` when unasked, so the field's presence IS the declaration.
     */
    unhardened?: true;
    /** The declared `user: "uid:gid"` the container runs as — the hardened alternative to `unhardened`. */
    user?: { uid: number; gid: number };
    /**
     * The TCP ports the service listens on, from `ports: [5432]`. Declared because services share
     * one network namespace in the task pod, where two services binding one port cannot both run:
     * the plan refuses a collision before launch. Never published to the host.
     */
    ports?: number[];
}

/**
 * What a service may be called. The name becomes a container-name suffix and a network alias —
 * the hostname the author's tests resolve — so it is a DNS label: lowercase letters, digits and
 * hyphens, one to thirty characters, no hyphen at either end.
 */
export const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** What an environment variable name may look like before it is put on an argv. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a service `user:` may be: numeric `uid:gid`, uid never 0. Numeric because runAsUser takes
 * no name, and nine digits keeps both inside the int32 the kubelet accepts.
 */
const SERVICE_USER = /^([1-9][0-9]{0,8}):([0-9]{1,9})$/;

/**
 * What an image reference may look like before it goes on an argv — the one field that names what
 * the daemon executes. An allowlist, not docker's full reference grammar: it refuses whitespace,
 * `$`, `=`, quotes and a leading `-`, which is everything that could turn the image token into
 * something other than an image.
 */
export const IMAGE =
    /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._/-]+)?(?::[a-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/i;

/** How many services one plan may run: a runaway fleet would otherwise be scheduled into one pod. */
export const MAX_SERVICES = 10;

/** The most ports one service may declare, and the range a TCP port lives in. */
const MAX_PORTS_PER_SERVICE = 16;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Cuts a comment. A `#` opens one at line start or after whitespace, never inside quotes — which
 * is what makes `TOKEN: "ab # cd"` survive and `image: postgres # pinned` not carry its comment
 * into the tag. The tracker follows the same quoting rules scalar() decodes by, so an escape
 * cannot mis-toggle it: in a double-quoted span `\"` is a character the span holds, and in a
 * single-quoted one the doubled `''` is the whole escape, consumed as a pair.
 */
/**
 * Advances past one character of a double-quoted span. The backslash escapes the next
 * character, so `\"` is a quoted quote and the span stays open — otherwise `"va\"" # note`
 * cuts its comment inside the value.
 */
function stepDoubleQuoted(line: string, i: number): { advance: number; closed: boolean } {
    const ch = line[i];
    if (ch === '\\') return { advance: 2, closed: false };
    if (ch === '"') return { advance: 1, closed: true };
    return { advance: 1, closed: false };
}

/**
 * Advances past one character of a single-quoted span. The doubled quote is the escape: consume
 * the pair, and only a lone `'` closes the span.
 */
function stepSingleQuoted(line: string, i: number): { advance: number; closed: boolean } {
    const ch = line[i];
    if (ch === "'" && line[i + 1] === "'") return { advance: 2, closed: false };
    if (ch === "'") return { advance: 1, closed: true };
    return { advance: 1, closed: false };
}

/** Whether `line[i]` is a `#` that opens a comment: at line start, or after whitespace. */
function isCommentStart(line: string, i: number): boolean {
    if (line[i] !== '#') return false;
    return i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t';
}

/** Advances one character through the line's quote state, outside any comment. */
function advanceQuoteState(line: string, i: number, quote: string | null): { i: number; quote: string | null } {
    if (quote === '"') {
        const step = stepDoubleQuoted(line, i);
        return { i: i + step.advance, quote: step.closed ? null : quote };
    }
    if (quote === "'") {
        const step = stepSingleQuoted(line, i);
        return { i: i + step.advance, quote: step.closed ? null : quote };
    }
    const ch = line[i];
    if (ch === '"' || ch === "'") return { i: i + 1, quote: ch };
    return { i: i + 1, quote };
}

function stripComment(line: string): string {
    let quote: string | null = null;
    let i = 0;
    while (i < line.length) {
        if (quote === null && isCommentStart(line, i)) return line.slice(0, i);
        const next = advanceQuoteState(line, i, quote);
        i = next.i;
        quote = next.quote;
    }
    return line;
}

/**
 * The single-character backslash escapes a double-quoted scalar decodes (YAML 1.2 §7.3.2) — the
 * full one-character set, plus the escaped space. The variable-length hex forms (`\x` of exactly
 * two hex digits, `\u` of four, `\U` of eight) are not single characters, so they live in
 * HEX_ESCAPE_LENGTHS beside this map. Anything outside both is refused rather than passed
 * through with its backslash: the service runs on what this returns, and a forwarded escape
 * speaks for a value the author did not write.
 */
const DOUBLE_QUOTED_ESCAPES = new Map<string, string>([
    ['\\', '\\'],
    ['"', '"'],
    ['n', '\n'],
    ['t', '\t'],
    ['r', '\r'],
    ['0', '\0'],
    ['/', '/'],
    ['b', '\b'],
    ['f', '\f'],
    ['a', '\u0007'],
    ['v', '\u000B'],
    ['e', '\u001B'],
    [' ', ' '],
    ['N', '\u0085'],
    ['_', '\u00A0'],
    ['L', '\u2028'],
    ['P', '\u2029'],
]);

/**
 * The hex escapes of §7.3.2, each with the exact digit count the spec fixes for its letter.
 * Decoded with String.fromCodePoint, so the 8-digit form delivers an astral plane character as
 * the surrogate pair the container process expects. Fewer digits than the letter takes, a
 * non-hex digit where one is required, or a value past Unicode's 0x10FFFF cap (which would also
 * crash fromCodePoint as an infrastructure-looking error) is refused: all three would otherwise
 * decode a code point the author did not write.
 */
/** The digit count §7.3.2 fixes for `\u` — a 16-bit code unit. */
const HEX_ESCAPE_DIGITS_U = 4;
/** The digit count §7.3.2 fixes for `\U` — a full 32-bit code point. */
const HEX_ESCAPE_DIGITS_UPPER_U = 8;

const HEX_ESCAPE_LENGTHS = new Map<string, number>([
    ['x', 2],
    ['u', HEX_ESCAPE_DIGITS_U],
    ['U', HEX_ESCAPE_DIGITS_UPPER_U],
]);

/** Unicode's own cap — the highest code point `String.fromCodePoint` accepts. */
const UNICODE_MAX_CODE_POINT = 0x10ffff;

/**
 * A scalar. Unquoted values are kept as written (numbers included). A quoted value is decoded by
 * the rules its quoting promises — that is what makes `PASSWORD: "pa\"ss"` start the service
 * with `pa"ss` rather than the escape syntax. Single quotes (§7.3.1) know exactly one escape,
 * the doubled `''`, and a backslash is the character it is; double quotes (§7.3.2) decode the
 * full escape set above and refuse an escape outside it, under this file's standing posture that
 * a construct the parser does not understand is an error a human reads.
 */
/**
 * Decodes one backslash escape at `body[i]` (the backslash itself). Answers the decoded text and
 * how many characters, counted from the backslash, it consumed.
 */
function decodeDoubleQuotedEscape(body: string, i: number): { text: string; length: number } {
    const next = body[i + 1] ?? '';
    const hexLength = HEX_ESCAPE_LENGTHS.get(next);
    if (hexLength !== undefined) {
        // slice() returns less than asked near the end of the string, so the length check is
        // what makes "\u12" malformed rather than a silent short decode.
        const digits = body.slice(i + 2, i + 2 + hexLength);
        const point = digits.length === hexLength && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : NaN;
        if (Number.isNaN(point) || point > UNICODE_MAX_CODE_POINT) {
            throw new Error(
                `.bellows.yaml: malformed escape "\\${next}${digits}" in a double-quoted value — ` +
                    `"\\${next}" takes exactly ${hexLength} hex digits within Unicode`
            );
        }
        return { text: String.fromCodePoint(point), length: 2 + hexLength };
    }
    const decoded = DOUBLE_QUOTED_ESCAPES.get(next);
    if (decoded === undefined) {
        throw new Error(`.bellows.yaml: unknown escape "\\${next}" in a double-quoted value`);
    }
    return { text: decoded, length: 2 };
}

function scalar(raw: string): string {
    const value = raw.trim();
    if (value.length < 2) return value;
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        const body = value.slice(1, -1);
        let out = '';
        let i = 0;
        while (i < body.length) {
            const ch = body[i];
            if (ch !== '\\') {
                out += ch;
                i += 1;
                continue;
            }
            const decoded = decodeDoubleQuotedEscape(body, i);
            out += decoded.text;
            i += decoded.length;
        }
        return out;
    }
    return value;
}

/** What an environment entry may weigh before it is refused. An `-e` travels on an argv, and
 * execve caps a single argument far below what a pasted certificate collection would weigh; a
 * bound here turns that into an author-facing refusal instead of a daemon error. */
const MAX_ENV_KEY = 256;
const MAX_ENV_VALUE = 8192;
/**
 * Parses `.bellows.yaml` — the Drone services shape and nothing else:
 *
 * ```
 * services:
 *   - name: cache
 *     image: redis
 *     ports: [6379]
 *     environment:
 *       ALLOW_EMPTY_PASSWORD: "yes"
 * ```
 *
 * Strictness is the point. The file was written by a repo author against a syntax they half-know
 * from CI; every construct this parser does not understand is refused with a message that names
 * the key, because the alternative is a pasted Drone pipeline that silently does nothing.
 * `ports:` is the one inline list, and it DECLARES the container's listening ports for the plan's
 * collision check; it never publishes anything to the host. A file without a `services` key parses
 * to no services — a checkout carries the file only when it wants services, so nothing is an error
 * until a service is actually being defined.
 *
 * One exception, and it is not leniency: a top-level `environment:` block is the GATES half of
 * the file, read by the board's own parser (server/src/workspace/bellows.ts), and one file may
 * carry both halves. This parser skips the block wholesale — it does not judge the gates
 * grammar, and a gates-only file parses to no services — while every other unknown top-level
 * key is still refused.
 */

interface BellowsItem {
    itemIndent: number;
    name: string;
    image: string;
    environment: { key: string; value: string }[];
    /** The declared `unhardened: true` (issue #382). Never set from any other spelling. */
    unhardened: boolean;
    user: { uid: number; gid: number } | null;
    ports: number[];
    inEnvironment: boolean;
    keys: Set<string>;
    envKeys: Set<string>;
}

/** Validates and files the just-finished item, when there is one. A no-op on a null item. */
function finishItem(item: BellowsItem | null, specs: ServiceSpec[]): void {
    if (!item) return;
    const { name, image, environment, unhardened, user, ports } = item;
    if (!name) throw new Error('.bellows.yaml: a service is missing "name"');
    if (!image) throw new Error('.bellows.yaml: a service is missing "image"');
    if (!SERVICE_NAME.test(name)) {
        throw new Error(
            `.bellows.yaml: service name "${name}" must be a lowercase DNS label ` +
                '(letters, digits and hyphens, at most 30 characters, none at either end)'
        );
    }
    if (!IMAGE.test(image)) {
        throw new Error(`.bellows.yaml: image "${image}" does not look like an image reference`);
    }
    if (specs.some((s) => s.name === name)) {
        throw new Error(`.bellows.yaml: duplicate service name "${name}"`);
    }
    specs.push({
        name,
        image,
        environment,
        ...(unhardened ? { unhardened: true as const } : {}),
        ...(user ? { user } : {}),
        ...(ports.length > 0 ? { ports } : {}),
    });
}

/** `[5432, 6379]` — an inline list of distinct TCP ports. A block list is refused with the spelling to use. */
function readPorts(value: string): number[] {
    const list = value.match(/^\[(.*)\]$/);
    if (!list) throw new Error('.bellows.yaml: "ports" must be an inline list of TCP ports, e.g. ports: [5432]');
    const items = (list[1] ?? '').trim() === '' ? [] : (list[1] ?? '').split(',').map((item) => item.trim());
    if (items.length > MAX_PORTS_PER_SERVICE) {
        throw new Error(`.bellows.yaml: a service declares at most ${MAX_PORTS_PER_SERVICE} ports`);
    }
    const ports = items.map((item) => (/^[0-9]{1,5}$/.test(item) ? Number(item) : NaN));
    const bad = ports.findIndex((port) => !(port >= MIN_PORT && port <= MAX_PORT));
    if (bad !== -1) {
        throw new Error(`.bellows.yaml: port "${items[bad]}" is not a TCP port number (${MIN_PORT}-${MAX_PORT})`);
    }
    if (new Set(ports).size !== ports.length) throw new Error('.bellows.yaml: a service lists one port twice');
    return ports;
}

/** Applies one `name:`/`image:`/`environment:` field to the item mid-parse. */
function applyServiceField(item: BellowsItem, key: string, value: string): void {
    if (key === 'name') {
        item.name = value;
        return;
    }
    if (key === 'image') {
        item.image = value;
        return;
    }
    if (key === 'environment') {
        if (value !== '') {
            throw new Error('.bellows.yaml: "environment" must be a mapping of "KEY: value" lines');
        }
        item.inEnvironment = true;
        return;
    }
    if (key === 'unhardened') {
        // The one key in this grammar that LOOSENS a security control (issue #382), so it is
        // spelled exactly one way. `yes`, `on` and `1` are each a reasonable author guess and each
        // would have to be read as truthy somewhere; refusing them keeps "did this service opt
        // out?" a question with one answer rather than a parser trivia question — and makes the
        // typo that would have silently left a service hardened an error the author reads.
        if (value !== 'true') {
            throw new Error('.bellows.yaml: "unhardened" must be `true` — the only value that opts out');
        }
        item.unhardened = true;
        return;
    }
    if (key === 'user') {
        const m = value.match(SERVICE_USER);
        if (!m) throw new Error('.bellows.yaml: "user" must be a numeric non-root "uid:gid", e.g. "999:999"');
        item.user = { uid: Number(m[1]), gid: Number(m[2]) };
        return;
    }
    if (key === 'ports') {
        item.ports = readPorts(value);
        return;
    }
    throw new Error(
        `.bellows.yaml: unknown service key "${key}" — supported: name, image, ports, environment, unhardened, user`
    );
}

function applyField(item: BellowsItem, chunk: string): void {
    const m = chunk.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`.bellows.yaml: cannot parse line "${chunk.trim()}"`);
    // The regex guarantees both groups when it matched; `?? ''` only satisfies
    // noUncheckedIndexedAccess, and scalar('') reads as the empty value it would be.
    const key = scalar(m[1] ?? '');
    const value = scalar(m[2] ?? '');
    if (item.keys.has(key)) throw new Error(`.bellows.yaml: duplicate key "${key}" in one service`);
    item.keys.add(key);
    applyServiceField(item, key, value);
}

function refuseTopLevel(content: string): never {
    const key = scalar(content.split(':')[0] ?? content);
    if (key === 'services') {
        throw new Error('.bellows.yaml: "services" must be a list of "- name: …" items');
    }
    throw new Error(`.bellows.yaml: unknown key "${key}" — only "services" is supported`);
}

/**
 * Applies one environment-mapping line under a service's `environment:` key. Environment
 * entries sit deeper than the item's keys (`environment:` at itemIndent+2, its keys below
 * that) — the caller enforces that depth before calling this.
 */
function applyEnvironmentEntry(item: BellowsItem, content: string): void {
    const m = content.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`.bellows.yaml: cannot parse line "${content}"`);
    const key = scalar(m[1] ?? '');
    const value = scalar(m[2] ?? '');
    if (!ENV_KEY.test(key)) {
        throw new Error(`.bellows.yaml: "${key}" is not a valid environment variable name`);
    }
    if (key.length > MAX_ENV_KEY || value.length > MAX_ENV_VALUE) {
        throw new Error(
            `.bellows.yaml: "${key}" is too long — keys at most ${MAX_ENV_KEY} and values at most ` +
                `${MAX_ENV_VALUE} characters`
        );
    }
    if (item.envKeys.has(key)) {
        throw new Error(`.bellows.yaml: duplicate environment key "${key}" in one service`);
    }
    item.envKeys.add(key);
    item.environment.push({ key, value });
}

/**
 * Handles one top-level line before any service item has been seen: the `services:` header, the
 * gates-half `environment:` block, or a refusal. Answers whether `services:` was just found.
 */
function applyPreamble(content: string): { seenServices: boolean; inGatesBlock: boolean } {
    const emptyList = content.match(/^services:\s*\[\s*\]$/);
    if (content === 'services:' || emptyList) return { seenServices: true, inGatesBlock: false };
    if (isBoardBlock(content)) return { seenServices: false, inGatesBlock: true };
    refuseTopLevel(content);
}

/** The board-read halves of the file, skipped wholesale here: the gates `environment:`, the evidence `policy:` and the `reviewers:`. */
const isBoardBlock = (content: string): boolean =>
    content.startsWith('environment:') || content.startsWith('policy:') || content.startsWith('reviewers:');

/**
 * Advances the gates-block state for one line, and whether the main loop should skip it: every
 * line of the gates block's body is deeper than the top level, so indentation alone ends the
 * block and hands the next top-level key back to the loop.
 */
function advanceGatesBlock(inGatesBlock: boolean, indent: number): { inGatesBlock: boolean; skipLine: boolean } {
    if (!inGatesBlock) return { inGatesBlock, skipLine: false };
    if (indent > 0) return { inGatesBlock: true, skipLine: true };
    return { inGatesBlock: false, skipLine: false };
}

/** Handles a line back at indentation 0 while parsing service items — a new top-level key. */
function applyTopLevelDuringServices(content: string): boolean {
    if (isBoardBlock(content)) return true;
    refuseTopLevel(content);
}

/** Whether this line is an environment-mapping entry under the current item's `environment:` key. */
function isEnvironmentEntryLine(item: BellowsItem, indent: number): boolean {
    return item.inEnvironment && indent > item.itemIndent + 2;
}

/** Applies one line already known to belong to the current item: an environment entry, or a top-level field. */
function applyItemLine(current: BellowsItem, indent: number, content: string): void {
    if (isEnvironmentEntryLine(current, indent)) {
        applyEnvironmentEntry(current, content);
        return;
    }
    if (indent === current.itemIndent + 2) {
        current.inEnvironment = false;
        applyField(current, content);
        return;
    }
    throw new Error(`.bellows.yaml: cannot parse line "${content}"`);
}

export function parseServices(text: string): ServiceSpec[] {
    const specs: ServiceSpec[] = [];
    let seenServices = false;
    /** Inside a top-level `environment:` block — the gates half, not this parser's grammar. */
    let inGatesBlock = false;
    let current: BellowsItem | null = null;
    // A Windows editor's byte-order mark would otherwise make the first line `\uFEFFservices:`
    // and the refusal would print an invisible character at the user.
    const source = text.replace(/^\uFEFF/, '');

    for (const rawLine of source.split('\n')) {
        const line = stripComment(rawLine);
        if (!line.trim()) continue;
        const indent = line.length - line.trimStart().length;
        const content = line.trim();

        const gates = advanceGatesBlock(inGatesBlock, indent);
        inGatesBlock = gates.inGatesBlock;
        if (gates.skipLine) continue;

        if (!seenServices) {
            const preamble = applyPreamble(content);
            seenServices = preamble.seenServices;
            inGatesBlock = preamble.inGatesBlock;
            continue;
        }

        if (content.startsWith('- ')) {
            finishItem(current, specs);
            current = {
                itemIndent: indent,
                name: '',
                image: '',
                environment: [],
                unhardened: false,
                user: null,
                ports: [],
                inEnvironment: false,
                keys: new Set(),
                envKeys: new Set(),
            };
            applyField(current, content.slice(2));
            continue;
        }

        if (indent === 0) {
            inGatesBlock = applyTopLevelDuringServices(content);
            continue;
        }

        if (!current) {
            throw new Error(`.bellows.yaml: expected a "- name: …" list item under services, got "${content}"`);
        }
        applyItemLine(current, indent, content);
    }
    finishItem(current, specs);
    return specs;
}
