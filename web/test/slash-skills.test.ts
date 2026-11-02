import { describe, expect, it } from 'vitest';
import {
    activeSlashToken,
    builtinSkillsIn,
    filterSkills,
    hasSlashToken,
    highlightIndex,
    insertSkill,
    slashKeyAction,
    type SlashSkill,
} from '../src/slash-skills.js';

const skill = (name: string, source: SlashSkill['source'] = 'builtin'): SlashSkill => ({
    name,
    description: `${name} skill`,
    source,
});

describe('activeSlashToken', () => {
    it('finds a token at the start of the prompt', () => {
        expect(activeSlashToken('/re', 3)).toEqual({ start: 0, end: 3, prefix: 're' });
    });

    it('finds a token after whitespace, including a newline, and a bare slash', () => {
        expect(activeSlashToken('fix it /', 8)).toEqual({ start: 7, end: 8, prefix: '' });
        expect(activeSlashToken('fix\n/rev', 8)).toEqual({ start: 4, end: 8, prefix: 'rev' });
    });

    it('reads only up to the caret', () => {
        expect(activeSlashToken('/review the code', 3)).toEqual({ start: 0, end: 3, prefix: 're' });
    });

    it('is not a token mid-word, in a path or in a URL', () => {
        expect(activeSlashToken('a/b', 3)).toBeNull();
        expect(activeSlashToken('see https://x.io/re', 19)).toBeNull();
        expect(activeSlashToken('//re', 4)).toBeNull();
    });

    it('is not a token once the caret has left it', () => {
        expect(activeSlashToken('/review ', 8)).toBeNull();
    });
});

describe('filterSkills', () => {
    const all = [skill('review'), skill('release', 'repo'), skill('fix')];

    it('keeps the listing order and matches by prefix, case-insensitively', () => {
        expect(filterSkills(all, 're').map((s) => s.name)).toEqual(['review', 'release']);
        expect(filterSkills(all, 'FI').map((s) => s.name)).toEqual(['fix']);
    });

    it('lists everything for a bare slash', () => {
        expect(filterSkills(all, '')).toHaveLength(3);
    });
});

describe('insertSkill', () => {
    it('replaces the token with /name and a space, caret after it', () => {
        const text = 'run /re now';
        const token = activeSlashToken(text, 7);
        expect(token).not.toBeNull();
        expect(insertSkill(text, token!, 'review')).toEqual({ text: 'run /review  now', caret: 12 });
    });
});

describe('hasSlashToken / builtinSkillsIn', () => {
    it('derives the built-ins whose whole token is in the text', () => {
        const builtins = ['review', 'fix'];
        expect(builtinSkillsIn('please /review this', builtins)).toEqual(['review']);
        expect(builtinSkillsIn('/fix and /review', builtins)).toEqual(['review', 'fix']);
    });

    it('does not count a longer name, a path or a repo-only skill', () => {
        expect(builtinSkillsIn('/reviewer', ['review'])).toEqual([]);
        expect(builtinSkillsIn('docs/review', ['review'])).toEqual([]);
        expect(builtinSkillsIn('/deploy', ['review'])).toEqual([]);
    });

    it('sees a token anywhere, not a path', () => {
        expect(hasSlashToken('fix /x')).toBe(true);
        expect(hasSlashToken('a/b')).toBe(false);
    });
});

describe('slashKeyAction', () => {
    const plain = { ctrl: false, meta: false };

    it('maps the menu keys, and leaves Ctrl/Cmd+Enter to the launch', () => {
        expect(slashKeyAction('ArrowDown', plain, 2)).toBe('down');
        expect(slashKeyAction('ArrowUp', plain, 2)).toBe('up');
        expect(slashKeyAction('Enter', plain, 2)).toBe('pick');
        expect(slashKeyAction('Tab', plain, 2)).toBe('pick');
        expect(slashKeyAction('Enter', { ctrl: true, meta: false }, 2)).toBeNull();
        expect(slashKeyAction('Enter', { ctrl: false, meta: true }, 2)).toBeNull();
        expect(slashKeyAction('a', plain, 2)).toBeNull();
    });

    it('closes on Escape even with nothing listed, and leaves every other key alone then', () => {
        expect(slashKeyAction('Escape', plain, 0)).toBe('close');
        expect(slashKeyAction('Enter', plain, 0)).toBeNull();
        expect(slashKeyAction('Tab', plain, 0)).toBeNull();
    });
});

describe('highlightIndex', () => {
    it('keeps the held row for the same prefix, clamped, and restarts at the first for a new one', () => {
        expect(highlightIndex({ prefix: 're', index: 1 }, 're', 3)).toBe(1);
        expect(highlightIndex({ prefix: 're', index: 5 }, 're', 3)).toBe(2);
        expect(highlightIndex({ prefix: 're', index: 1 }, 'rev', 3)).toBe(0);
        expect(highlightIndex({ prefix: 're', index: 0 }, 're', 0)).toBe(0);
    });
});
