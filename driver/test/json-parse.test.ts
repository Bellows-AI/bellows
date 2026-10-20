import { describe, expect, it } from 'vitest';
import { parseJsonObject, parseLastJsonLine } from '../src/json-parse.js';

const fallback = () => 'fallback';

describe('parseLastJsonLine', () => {
    it('parses the last non-empty line, ignoring trailing blank lines and CRLF', () => {
        expect(parseLastJsonLine('{"a":1}\n{"a":2}', fallback)).toEqual({ a: 2 });
        expect(parseLastJsonLine('{"a":1}\n\n', fallback)).toEqual({ a: 1 });
        expect(parseLastJsonLine('{"a":1}\r\n', fallback)).toEqual({ a: 1 });
    });

    it('answers the fallback for a non-JSON last line or empty stdout', () => {
        expect(parseLastJsonLine('{"a":1}\nnoise', fallback)).toBe('fallback');
        expect(parseLastJsonLine('', fallback)).toBe('fallback');
    });

    it('answers the fallback for a last line that parses to anything but an object', () => {
        for (const line of ['null', '[]', '[{"a":1}]', '1', '"s"', 'true']) {
            expect(parseLastJsonLine(line, fallback)).toBe('fallback');
        }
    });
});

describe('parseJsonObject', () => {
    it('answers a JSON object as it is', () => {
        expect(parseJsonObject('{}')).toEqual({});
        expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    });

    it('answers null for an array, null, a primitive or invalid JSON', () => {
        for (const raw of ['[]', 'null', '5', '"x"', 'not json', '']) expect(parseJsonObject(raw)).toBeNull();
    });
});
