import { describe, expect, it } from 'vitest';
import { normalizeAttachmentName } from '../src/attachments/name.js';

const nameOf = (raw: string) => {
    const result = normalizeAttachmentName(raw);
    return result.ok ? result.name : null;
};

describe('normalizeAttachmentName', () => {
    it('keeps an ordinary name', () => {
        expect(nameOf('report final.pdf')).toBe('report final.pdf');
    });

    it('neutralizes path separators so the name can never act as a path', () => {
        for (const raw of ['../x', 'a/b', 'a\\b', '..\\..\\x']) {
            const name = nameOf(raw);
            expect(name).not.toBeNull();
            expect(name).not.toMatch(/[\\/]/);
        }
    });

    it('rejects control characters, NUL included', () => {
        expect(nameOf('a\u0000b')).toBeNull();
        expect(nameOf('a\nb')).toBeNull();
        expect(nameOf('a\u007fb')).toBeNull();
    });

    it('rejects an empty or dot-only name', () => {
        for (const raw of ['', '   ', '.', '..']) expect(nameOf(raw)).toBeNull();
    });

    it('rejects a name over 255 bytes, counting bytes and not characters', () => {
        expect(nameOf('a'.repeat(255))).not.toBeNull();
        expect(nameOf('a'.repeat(256))).toBeNull();
        expect(nameOf('é'.repeat(128))).toBeNull();
    });

    it('applies NFC', () => {
        expect(nameOf('é.txt')).toBe('é.txt');
    });
});
