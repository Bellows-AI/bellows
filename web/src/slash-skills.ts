/**
 * The pure layer of the prompt's `/` skill menu: where a slash token is, which skills match it, and
 * what picking one does to the text. The token stays in the prompt — the server's master prompt
 * reads `/name` from the words, so inserting is plain text editing.
 */

/** A skill as the repo skills endpoint lists it. */
export interface SlashSkill {
    name: string;
    description: string;
    source: 'builtin' | 'repo';
}

/** A skill name's characters; the same set the server's `/name` token reads. */
const NAME_CHARS = 'a-z0-9_-';

/** The `/prefix` being typed: `start` is the slash, `end` the caret. */
export interface SlashToken {
    start: number;
    end: number;
    prefix: string;
}

/** A slash that starts the text or follows whitespace, then the name typed so far (maybe none): the one trigger of the menu and of the skills fetch. */
const TOKEN_SOURCE = `(?:^|\\s)\\/([${NAME_CHARS}]*)`;

const TOKEN_BEFORE_CARET = new RegExp(`${TOKEN_SOURCE}$`, 'i');

/**
 * The slash token the caret ends, or null. A token starts at the text's start or after whitespace,
 * so `a/b` and `https://x` are paths, not skills.
 */
export function activeSlashToken(text: string, caret: number): SlashToken | null {
    const before = text.slice(0, caret);
    const match = TOKEN_BEFORE_CARET.exec(before);
    if (match === null) return null;
    const prefix = match[1] ?? '';
    return { start: caret - prefix.length - 1, end: caret, prefix };
}

/** The skills whose name starts with what was typed after the slash, in the listing's order. */
export function filterSkills(skills: readonly SlashSkill[], prefix: string): SlashSkill[] {
    const wanted = prefix.toLowerCase();
    return skills.filter((skill) => skill.name.toLowerCase().startsWith(wanted));
}

/** `/name ` in place of the token, and the caret just after it. */
export function insertSkill(text: string, token: SlashToken, name: string): { text: string; caret: number } {
    const inserted = `/${name} `;
    return {
        text: text.slice(0, token.start) + inserted + text.slice(token.end),
        caret: token.start + inserted.length,
    };
}

/** Whether the text holds any slash token, a bare `/` included — the cue to load the skills list, matching what opens the menu. */
export function hasSlashToken(text: string): boolean {
    return new RegExp(TOKEN_SOURCE, 'i').test(text);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The built-in skills the text names with a whole `/name` token — what the create body's `skills` carries. */
export function builtinSkillsIn(text: string, builtins: readonly string[]): string[] {
    return builtins.filter((name) => new RegExp(`(?:^|\\s)\\/${escapeRegExp(name)}(?![${NAME_CHARS}])`).test(text));
}

/** What a key does while the menu is open: move the highlight, pick it, close, or nothing. */
export type SlashKeyAction = 'down' | 'up' | 'pick' | 'close' | null;

/**
 * Enter picks only plain (Ctrl/Cmd+Enter stays the composer's launch), Tab picks too, Escape
 * closes even an empty list; with nothing to choose the other keys keep their normal meaning.
 */
export function slashKeyAction(
    key: string,
    modifiers: { ctrl: boolean; meta: boolean },
    itemCount: number
): SlashKeyAction {
    if (key === 'Escape') return 'close';
    if (itemCount === 0) return null;
    if (key === 'ArrowDown') return 'down';
    if (key === 'ArrowUp') return 'up';
    if (key === 'Tab' || (key === 'Enter' && !modifiers.ctrl && !modifiers.meta)) return 'pick';
    return null;
}

/** The highlighted row: the held one while the typed prefix is the one it was set under, else the first. */
export function highlightIndex(held: { prefix: string; index: number }, prefix: string, count: number): number {
    return held.prefix === prefix ? Math.max(0, Math.min(held.index, count - 1)) : 0;
}
