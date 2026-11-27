import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as driver from '../../driver/src/review/review.js';
import * as board from '../src/forge/review-collection.js';

/** The driver imports nothing, so the review collection's caps and marker are copied; this pins the copy to the driver's. */
const MIDDLE = readFileSync(new URL('../../driver/src/scripts/review-reply-probe-middle.cjs', import.meta.url), 'utf8');
const middleConst = (name: string) => new RegExp(`const ${name} = '([^']*)';`).exec(MIDDLE)?.[1];

describe('the board copy of the review collection', () => {
    it.each([
        'BODY_MAX',
        'ERROR_MAX',
        'GENERAL_LIMIT',
        'INLINE_LIMIT',
        'REVIEWS_LIMIT',
        'THREADS_LIMIT',
        'THREAD_COMMENTS_LIMIT',
        'TOTAL_OUTPUT_BYTES',
        'PLAN_TARGETS_MAX',
        'PLAN_BYTES_MAX',
        'TRUNCATED_MARKER',
    ] as const)('%s equals the driver value', (name) => {
        expect(board[name]).toBe(driver[name]);
    });

    it("carries the middle's addressed-marker prefix and suffix", () => {
        expect(board.ADDRESSED_PREFIX).toBe(middleConst('__rrpAddressedPrefix'));
        expect(board.ADDRESSED_SUFFIX).toBe(middleConst('__rrpAddressedSuffix'));
        expect(board.addressedMarker('thread:abc')).toBe('<!-- factory-review-reconcile addressed thread:abc -->');
    });
});
