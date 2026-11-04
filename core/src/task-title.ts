/** The fallback title's cap, in code points; a longer first line ends in `…`. */
export const FALLBACK_TITLE_MAX = 80;
/** A stored title's cap, in code points. */
export const TASK_TITLE_MAX = 120;

/** Who set a stored title. `fallback` is render-time only: nothing stores it. */
export type TaskTitleOrigin = 'user' | 'agent';
export type DisplayTitleOrigin = TaskTitleOrigin | 'fallback';

// C0 and C1 controls, DEL, and the bidi embedding/override (U+202A-202E) and isolate (U+2066-2069) characters.
const C0_MAX = 0x1f;
const DEL = 0x7f;
const C1_MAX = 0x9f;
const BIDI_EMBED_FIRST = 0x202a;
const BIDI_EMBED_LAST = 0x202e;
const BIDI_ISOLATE_FIRST = 0x2066;
const BIDI_ISOLATE_LAST = 0x2069;

const isForbidden = (char: string): boolean => {
    const code = char.codePointAt(0)!;
    return (
        code <= C0_MAX ||
        (code >= DEL && code <= C1_MAX) ||
        (code >= BIDI_EMBED_FIRST && code <= BIDI_EMBED_LAST) ||
        (code >= BIDI_ISOLATE_FIRST && code <= BIDI_ISOLATE_LAST)
    );
};

/**
 * The deterministic fallback title: the first non-blank line of the command, whitespace collapsed,
 * capped at 80 code points with a trailing `…`. Empty for a blank command (the UI composes
 * `Task #<short id>`). Shown until a title is stored; see `displayTitle`.
 */
export function taskTitleFromCommand(command: string): string {
    const line = command.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
    const collapsed = line.replace(/\s+/g, ' ').trim();
    const points = [...collapsed];
    return points.length > FALLBACK_TITLE_MAX ? `${points.slice(0, FALLBACK_TITLE_MAX).join('')}…` : collapsed;
}

/**
 * A title a person or an agent proposes, normalized the one way every writer shares: NFC, whitespace
 * collapsed, 1-120 code points, no control or bidi-override characters.
 */
export function normalizeTaskTitle(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
    if (typeof raw !== 'string') return { ok: false, reason: 'title must be a string' };
    // Tab and newline are whitespace, collapsed before the control check; every other control is refused.
    const value = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if ([...value].some(isForbidden)) {
        return { ok: false, reason: 'title must not contain control or bidirectional override characters' };
    }
    if (value === '') return { ok: false, reason: 'title must not be blank' };
    if ([...value].length > TASK_TITLE_MAX) {
        return { ok: false, reason: `title exceeds ${TASK_TITLE_MAX} characters` };
    }
    return { ok: true, value };
}

/**
 * The ONE title every surface renders: the stored title with its origin, else the fallback derived
 * from the command. A missing, non-string or empty stored title falls back — never an empty heading.
 */
export function displayTitle(task: {
    title?: string | null | undefined;
    titleOrigin?: TaskTitleOrigin | null | undefined;
    command: string;
}): { text: string; origin: DisplayTitleOrigin } {
    if (typeof task.title === 'string' && task.title !== '' && task.titleOrigin) {
        return { text: task.title, origin: task.titleOrigin };
    }
    return { text: taskTitleFromCommand(task.command), origin: 'fallback' };
}
