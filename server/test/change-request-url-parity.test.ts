import { formatChangeRequestUrl, parseChangeRequestUrl } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    formatChangeRequestUrl as cliFormat,
    parseChangeRequestUrl as cliParse,
} from '../../cli/src/change-request-url.js';
import { ACCEPTED, INVALID_NUMBERS, REJECTED } from '../../core/test/change-request-url.fixtures.js';
import {
    formatChangeRequestUrl as driverFormat,
    parseChangeRequestUrl as driverParse,
} from '../../driver/src/change-request-url.js';

/** The driver and the CLI import nothing, so their change-request URL parser is a copy; this pins both to core's. */
const TEXTS = [...ACCEPTED.map(([text]) => text), ...REJECTED];
type Ref = Parameters<typeof formatChangeRequestUrl>[0];

describe('the driver and CLI copies of the change-request URL parser', () => {
    it.each(TEXTS)('parse %j as core does', (text) => {
        const expected = parseChangeRequestUrl(text);
        expect(driverParse(text)).toEqual(expected);
        expect(cliParse(text)).toEqual(expected);
    });

    it.each(ACCEPTED)('format %s as core does', (_text, parsed) => {
        const ref = parsed.ref as Ref;
        const expected = formatChangeRequestUrl(ref, parsed.number);
        expect(driverFormat(ref, parsed.number)).toBe(expected);
        expect(cliFormat(ref, parsed.number)).toBe(expected);
    });

    it.each(INVALID_NUMBERS)('refuse the number %s as core does', (number) => {
        const ref = ACCEPTED[0]![1].ref as Ref;
        for (const format of [formatChangeRequestUrl, driverFormat, cliFormat]) {
            expect(() => format(ref, number)).toThrow(RangeError);
        }
        const message = (format: typeof cliFormat) => {
            try {
                format(ref, number);
            } catch (error) {
                return (error as Error).message;
            }
            return null;
        };
        expect(message(driverFormat)).toBe(message(formatChangeRequestUrl));
        expect(message(cliFormat)).toBe(message(formatChangeRequestUrl));
    });
});
