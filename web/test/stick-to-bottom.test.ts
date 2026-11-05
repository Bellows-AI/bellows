import { describe, expect, it } from 'vitest';
import { decideOnContent, isNearBottom, NEAR_BOTTOM_PX } from '../src/use-stick-to-bottom.js';

const view = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000 };

describe('isNearBottom', () => {
    it('is true at the very bottom and inside the threshold, false past it', () => {
        expect(isNearBottom({ ...view, scrollTop: 1600 })).toBe(true);
        expect(isNearBottom({ ...view, scrollTop: 1600 - NEAR_BOTTOM_PX })).toBe(true);
        expect(isNearBottom({ ...view, scrollTop: 1600 - NEAR_BOTTOM_PX - 1 })).toBe(false);
        expect(isNearBottom({ ...view, scrollTop: 0 })).toBe(false);
    });

    it('treats content that fits without scrolling as at the bottom', () => {
        expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
    });
});

describe('decideOnContent', () => {
    it('follows the first content it ever sees', () => {
        expect(decideOnContent(null, { ...view, scrollTop: 0 })).toEqual({ follow: true, unseen: false });
    });

    it('follows new content while the reader was near the bottom of what was there before', () => {
        // The content grew 2000 → 2300; scrollTop never moved, so judge against the OLD height.
        const verdict = decideOnContent(2000, { scrollTop: 1600, clientHeight: 400, scrollHeight: 2300 });
        expect(verdict).toEqual({ follow: true, unseen: false });
    });

    it('leaves a reader who scrolled up alone and flags what they have not seen', () => {
        const verdict = decideOnContent(2000, { scrollTop: 300, clientHeight: 400, scrollHeight: 2300 });
        expect(verdict).toEqual({ follow: false, unseen: true });
    });

    it('flags nothing when a scrolled-up reader got no new height', () => {
        const verdict = decideOnContent(2000, { scrollTop: 300, clientHeight: 400, scrollHeight: 2000 });
        expect(verdict).toEqual({ follow: false, unseen: false });
    });
});
