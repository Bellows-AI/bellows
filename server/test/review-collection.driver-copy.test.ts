import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as driver from '../../driver/src/review/review.js';
import * as board from '../src/forge/review-collection.js';

/** The driver imports nothing, so the review collection's caps and marker are copied; this pins the copy to the driver's. */
const MIDDLE = readFileSync(new URL('../../driver/src/scripts/review-reply-probe-middle.cjs', import.meta.url), 'utf8');
const middleConst = (name: string) => new RegExp(`const ${name} = '([^']*)';`).exec(MIDDLE)?.[1];

describe('the board copy of the review collection', () => {
    it.each([
        ['BODY_MAX', board.BODY_MAX, driver.BODY_MAX],
        ['ERROR_MAX', board.ERROR_MAX, driver.ERROR_MAX],
        ['GENERAL_LIMIT', board.GENERAL_LIMIT, driver.GENERAL_LIMIT],
        ['INLINE_LIMIT', board.INLINE_LIMIT, driver.INLINE_LIMIT],
        ['REVIEWS_LIMIT', board.REVIEWS_LIMIT, driver.REVIEWS_LIMIT],
        ['THREADS_LIMIT', board.THREADS_LIMIT, driver.THREADS_LIMIT],
        ['THREAD_COMMENTS_LIMIT', board.THREAD_COMMENTS_LIMIT, driver.THREAD_COMMENTS_LIMIT],
        ['TOTAL_OUTPUT_BYTES', board.TOTAL_OUTPUT_BYTES, driver.TOTAL_OUTPUT_BYTES],
        ['PLAN_TARGETS_MAX', board.PLAN_TARGETS_MAX, driver.PLAN_TARGETS_MAX],
        ['PLAN_BYTES_MAX', board.PLAN_BYTES_MAX, driver.PLAN_BYTES_MAX],
        ['TRUNCATED_MARKER', board.TRUNCATED_MARKER, driver.TRUNCATED_MARKER],
    ])('%s equals the driver value', (_name, copy, original) => {
        expect(copy).toBe(original);
    });

    it("carries the middle's addressed-marker prefix and suffix", () => {
        expect(board.ADDRESSED_PREFIX).toBe(middleConst('__rrpAddressedPrefix'));
        expect(board.ADDRESSED_SUFFIX).toBe(middleConst('__rrpAddressedSuffix'));
        expect(board.addressedMarker('thread:abc')).toBe('<!-- factory-review-reconcile addressed thread:abc -->');
    });
});
