import { describe, expect, it } from 'vitest';
import { displayTitle, normalizeTaskTitle, taskTitleFromCommand } from '../src/task-title.js';

describe('taskTitleFromCommand', () => {
    it('takes the first line of the command, trimmed', () => {
        expect(taskTitleFromCommand('fix the flaky login test\nsecond line\nthird')).toBe('fix the flaky login test');
        expect(taskTitleFromCommand('  padded  ')).toBe('padded');
    });

    it('answers an empty string for an empty command rather than inventing one', () => {
        expect(taskTitleFromCommand('')).toBe('');
    });
});

describe('taskTitleFromCommand fallback', () => {
    it('collapses whitespace and caps a 1,000-char line at 80 + …', () => {
        const title = taskTitleFromCommand(`${'word '.repeat(200)}`);
        expect([...title]).toHaveLength(81);
        expect(title.endsWith('…')).toBe(true);
        expect(title).not.toMatch(/\s{2}/);
        expect(taskTitleFromCommand('a\t\t b   c')).toBe('a b c');
    });

    it('skips leading blank lines', () => {
        expect(taskTitleFromCommand('\n  \n\nfix the thing\nmore')).toBe('fix the thing');
    });

    it('is deterministic and cuts on a code-point boundary', () => {
        const command = '😀'.repeat(200);
        expect(taskTitleFromCommand(command)).toBe(taskTitleFromCommand(command));
        expect(taskTitleFromCommand(command)).toBe(`${'😀'.repeat(80)}…`);
    });

    it('leaves a line of exactly 80 characters whole', () => {
        expect(taskTitleFromCommand('x'.repeat(80))).toBe('x'.repeat(80));
    });

    it('is empty for a whitespace-only command', () => {
        expect(taskTitleFromCommand(' \n\t\n ')).toBe('');
    });
});

describe('normalizeTaskTitle', () => {
    it('collapses whitespace, trims and normalizes to NFC', () => {
        expect(normalizeTaskTitle('  Fix \t the   login\nbug ')).toEqual({ ok: true, value: 'Fix the login bug' });
        expect(normalizeTaskTitle('é')).toEqual({ ok: true, value: 'é' });
    });

    it('rejects blank, non-string, over 120 code points, control and bidi characters', () => {
        for (const raw of [
            '',
            '   ',
            '\n\t',
            7,
            null,
            undefined,
            'x'.repeat(121),
            'a\u0000b',
            'a\u0085b',
            'a‮b',
            'a⁦b',
        ]) {
            expect(normalizeTaskTitle(raw).ok, String(raw)).toBe(false);
        }
        expect(normalizeTaskTitle('x'.repeat(120)).ok).toBe(true);
        expect(normalizeTaskTitle('😀'.repeat(120)).ok).toBe(true);
        expect(normalizeTaskTitle('😀'.repeat(121)).ok).toBe(false);
    });

    it('names the reason', () => {
        expect(normalizeTaskTitle('')).toEqual({ ok: false, reason: expect.any(String) });
    });
});

describe('displayTitle', () => {
    it('prefers a stored title and reports its origin, else the fallback', () => {
        expect(displayTitle({ title: 'Stored', titleOrigin: 'agent', command: 'raw command' })).toEqual({
            text: 'Stored',
            origin: 'agent',
        });
        expect(displayTitle({ title: 'Mine', titleOrigin: 'user', command: 'raw' })).toEqual({
            text: 'Mine',
            origin: 'user',
        });
        expect(displayTitle({ title: null, titleOrigin: null, command: 'raw\nsecond' })).toEqual({
            text: 'raw',
            origin: 'fallback',
        });
    });

    it('falls back on a missing or non-string title, never an empty heading', () => {
        expect(displayTitle({ command: 'raw' })).toEqual({ text: 'raw', origin: 'fallback' });
        expect(displayTitle({ title: '', titleOrigin: 'user', command: 'raw' })).toEqual({
            text: 'raw',
            origin: 'fallback',
        });
    });
});
