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
    it('carries a follower to the new end and flags nothing', () => {
        expect(decideOnContent(true)).toEqual({ follow: true, unseen: false });
    });

    it('leaves a reader who scrolled up alone and flags what they have not seen', () => {
        expect(decideOnContent(false)).toEqual({ follow: false, unseen: true });
    });
});
