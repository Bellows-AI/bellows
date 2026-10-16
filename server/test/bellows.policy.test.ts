import { describe, expect, it } from 'vitest';
import { parseBellows, parseBellowsWithPolicy } from '../src/workspace/bellows.js';

/** The `policy:` block of `.bellows.yaml`: the evidence a task must carry, read at the base branch tip (see bellows.plan.test.ts). */

const ENVIRONMENT =
    'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: "npm test"\n';

describe('parseBellowsWithPolicy', () => {
    it('reads both required keys and leaves the gates half untouched', () => {
        const text = `${ENVIRONMENT}policy:\n    gates: required\n    review: "required"\n`;
        expect(parseBellowsWithPolicy(text).policy).toEqual({ gates: true, review: true });
        expect(parseBellows(text)?.gates).toEqual([{ name: 'test', command: 'npm test' }]);
    });

    it('reads a review-only policy from a file with no environment', () => {
        expect(parseBellowsWithPolicy('policy:\n    review: required\n')).toEqual({
            config: null,
            policy: { review: true },
            reviewers: [],
        });
    });

    it('is empty when the file declares none', () => {
        expect(parseBellowsWithPolicy(ENVIRONMENT).policy).toEqual({});
    });

    it.each([
        ['an unknown key', 'policy:\n    merge: required\n', /unknown policy key "merge"/],
        ['a value other than required', `${ENVIRONMENT}policy:\n    gates: optional\n`, /must be "required"/],
        ['a missing value', `${ENVIRONMENT}policy:\n    gates:\n`, /must be "required"/],
        ['a repeated key', `${ENVIRONMENT}policy:\n    gates: required\n    gates: required\n`, /declared twice/],
        [
            'a second block',
            `${ENVIRONMENT}policy:\n    review: required\npolicy:\n    gates: required\n`,
            /second "policy:"/,
        ],
        ['an inline value', 'policy: required\n', /takes keys/],
        ['required gates with no environment', 'policy:\n    gates: required\n', /requires gates/],
    ])('refuses %s', (_name, text, message) => {
        expect(() => parseBellowsWithPolicy(text)).toThrow(message);
    });
});
