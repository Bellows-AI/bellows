import { describe, expect, it } from 'vitest';
import type { FailureCause } from '../src/board.js';
import { publishCauseOf, publishFailed, publishNothing } from '../src/publish.js';

/**
 * Issue #581: `publish` is a coarse label. The board recovers a publish failure by its cause — a
 * refused credential needs a person, a provider outage is retried, a confirmed conflict is
 * repaired — so the driver classifies the step's own stderr once, here, for both executors. The
 * samples are what git and gh print; anything unrecognised stays `unknown`, never a guess.
 */
const SAMPLES: [FailureCause, string][] = [
    ['denied', 'git push: remote: Permission to acme/app.git denied to factory-bot[bot].'],
    [
        'denied',
        'git push: fatal: unable to access https://github.com/acme/app.git/: The requested URL returned error: 403',
    ],
    ['denied', "git push: fatal: Authentication failed for 'https://github.com/acme/app.git/'"],
    ['denied', "git fetch: fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ['denied', 'gh pr create: GraphQL: Resource not accessible by integration (createPullRequest)'],
    [
        'denied',
        'git push: remote: error: GH006: Protected branch update failed\n ! [remote rejected] HEAD -> main (protected branch hook declined)',
    ],
    ['conflict', 'git push: ! [rejected]        HEAD -> factory/task-1 (non-fast-forward)'],
    ['conflict', 'git push: ! [rejected]        HEAD -> factory/task-1 (fetch first)'],
    ['conflict', 'git push: ! [rejected]        HEAD -> factory/task-1 (stale info)'],
    ['conflict', 'git merge: CONFLICT (content): Merge conflict in src/app.ts'],
    [
        'conflict',
        'git push: origin/factory/task-1 moved to abc123 outside the runner and HEAD does not contain it — merge it into the branch before publishing',
    ],
    [
        'transport',
        "git push: fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
    ],
    ['transport', 'git push: ssh: connect to host github.com port 22: Connection timed out'],
    ['transport', 'git push: fatal: Connection reset by peer'],
    ['transport', 'git push: error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502'],
    ['transport', 'git fetch: fatal: early EOF'],
    ['transport', 'git push: fatal: unable to access: The requested URL returned error: 503'],
    ['transport', 'gh pr create: HTTP 500: Internal Server Error (https://api.github.com/graphql)'],
    ['transport', 'git push: gnutls_handshake() failed: TLS connection was non-properly terminated.'],
    ['transport', 'gh pr create: HTTP 403: API rate limit exceeded for installation ID 4242.'],
    ['transport', 'gh pr create: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes.'],
    ['transport', 'gh pr create: HTTP 429: Too Many Requests (https://api.github.com/graphql)'],
    ['transport', 'git push: fatal: unable to access: The requested URL returned error: 429'],
    ['denied', 'gh pr create: HTTP 403: Resource protected by organization SAML enforcement.'],
    ['conflict', 'git push: ! [rejected]        HEAD -> fix/403 (non-fast-forward)'],
    ['unknown', 'git commit: fatal: something nobody has seen before'],
    ['unknown', ''],
];

describe('the publish failure cause (#581)', () => {
    it.each(SAMPLES)('reads %s from a recorded sample', (cause, message) => {
        expect(publishCauseOf(message)).toBe(cause);
    });

    it('lets a refusal win over a rejected push that names one', () => {
        // A protected-branch refusal prints `[remote rejected]` too; no repair can push past it.
        expect(
            publishCauseOf(
                '! [remote rejected] HEAD -> main (protected branch hook declined)\n ! [rejected] (non-fast-forward)'
            )
        ).toBe('denied');
    });

    it('carries the cause it is given on a failed publish, and none on a no-op', () => {
        expect(publishFailed('could not write the publish env file: EIO', 'transport').cause).toBe('transport');
        expect(publishNothing('nothing unpushed').cause).toBeNull();
    });
});
