import { describe, expect, it } from 'vitest';
import { taskTitleFromCommand } from '../src/task-title.js';

describe('taskTitleFromCommand', () => {
    it('takes the first line of the command, trimmed', () => {
        expect(taskTitleFromCommand('fix the flaky login test\nsecond line\nthird')).toBe('fix the flaky login test');
        expect(taskTitleFromCommand('  padded  ')).toBe('padded');
    });

    it('answers an empty string for an empty command rather than inventing one', () => {
        expect(taskTitleFromCommand('')).toBe('');
    });
});
