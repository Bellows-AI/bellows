import { parseChangeRequestUrl } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    formatChangeRequestUrl as cliFormat,
    parseChangeRequestUrl as cliParse,
} from '../../cli/src/change-request-url.js';
import {
    formatChangeRequestUrl as driverFormat,
    parseChangeRequestUrl as driverParse,
} from '../../driver/src/change-request-url.js';
import { ACCEPTED, REJECTED } from '../../core/test/change-request-url.fixtures.js';

/** The driver and the CLI import nothing, so their change-request URL parser is a copy; this pins both to core's. */
const TEXTS = [...ACCEPTED.map(([text]) => text), ...REJECTED];

describe('the driver and CLI copies of the change-request URL parser', () => {
    it.each(TEXTS)('parse %j as core does', (text) => {
        const expected = parseChangeRequestUrl(text);
        expect(driverParse(text)).toEqual(expected);
        expect(cliParse(text)).toEqual(expected);
    });

    it.each(ACCEPTED)('format %s as core does', (_text, parsed) => {
        const ref = parsed.ref as Parameters<typeof cliFormat>[0];
        expect(driverFormat(ref, parsed.number)).toBe(cliFormat(ref, parsed.number));
    });
});
