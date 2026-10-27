import { describe, expect, it } from 'vitest';
import { CONFORMANCE_CASES, type ConformanceCase } from './secrets-conformance.js';
import { type ReferenceDefects, createReferenceHarness } from './secrets-reference-store.js';

/**
 * The RED proof for the conformance suite: each deliberate contract violation in the reference
 * store (`ReferenceDefects`) must make the cases named here FAIL with an assertion, so a green
 * run of `secrets.reference.test.ts` means the cases can actually detect the defect. A case no
 * defect covers is listed in `UNPROVEN` and so stays visible.
 */
const PROVEN: Record<keyof ReferenceDefects, string[]> = {
    mangleBinary: ['binary payload round-trips'],
    rejectEmpty: ['empty payload is valid'],
    offByOneLimit: ['32768 bytes accepted'],
    validateAfterIntent: ['32769 rejected before side effects'],
    nullAsEmpty: ['null, undefined and string payloads'],
    skipMutationIdentity: [
        'create with a different identity',
        'replace with a different identity',
        'delete with a different identity',
    ],
    skipReadIdentity: ['read with a different identity'],
    skipStatusIdentity: ['operation lookup with a different identity'],
    ignoreUserOrgId: ['a personal identity needs no organization', 'read with a different identity'],
    activateWithoutCas: [
        'competing creates',
        'replace/replace',
        'replace/delete',
        'never overwrites a newer winner',
        'an activation conflict loses cleanly',
    ],
    ignoreExpectedVersion: ['a stale expected version conflicts'],
    reuseVersionOnIdenticalBytes: ['replacing with identical bytes yields a new version'],
    rekeyBumpsVersion: ['rekey keeps the logical version'],
    reuseTombstonedRef: ['create on a tombstoned reference conflicts'],
    deleteMissingOk: ['a fresh delete of a deleted or missing reference'],
    replayRerunsPreflight: ['an identical replay returns the original result'],
    replayWritesAgain: ['a lost response after activation', 'an identical replay returns the original result'],
    replayReexecutes: ['a replay after later updates or deletion'],
    skipOperationBinding: ['reusing an operation ID with different input conflicts'],
    skipOperationExpiry: ['an expired operation ID is rejected'],
    pruneUnresolved: ['stays reconcilable and resumable'],
    skipOperationMac: ['a tampered or malformed operation ID'],
    skipUnknownBlock: ['blocked behind an unknown operation'],
    blockOnPending: ['blocked behind an unknown operation'],
    timeoutAsUnavailable: ['provider timeout that was applied', 'provider timeout that was lost'],
    cleanupFailRestores: ['failed deletion cleanup never restores resolution'],
    collectActive: ['collection never removes an active version'],
    collectPending: ['collection never removes an active version'],
    skipAbortCheck: ['an already-aborted signal'],
    stageAfterTerminal: ['a replay paused before staging leaves nothing behind'],
    skipIntegrityCheck: ['tampered stored bytes'],
    readErrorAsNotFound: ['a provider read error is unavailable'],
    exposeStaged: ['a crash after staging, before activation'],
    reconcileResurrects: ['reconcile never resurrects a deleted secret'],
    plainSha256Fingerprint: ['no unkeyed digest of the payload'],
    storePlaintextInDb: ['the sentinel never escapes'],
    leakProviderBody: ['a provider error body maps to unavailable'],
    skipFailureRecord: [
        'a failed delete binds its operation ID',
        'a stale-version replace binds its operation ID',
        'a reference-exists create binds its operation ID',
    ],
    aliasPayload: ['a caller buffer mutated during create', 'a caller buffer mutated during replace'],
    aliasRead: ['mutating a returned secret'],
    rawIdentityDeref: ['a null scope or owning record'],
};

const UNPROVEN: string[] = [];

function find(fragment: string): ConformanceCase {
    const matches = CONFORMANCE_CASES.filter((c) => c.name.includes(fragment));
    expect(
        matches.map((c) => c.name),
        `fragment "${fragment}"`
    ).toHaveLength(1);
    return matches[0] as ConformanceCase;
}

describe('every defect variant of the reference store is caught by the named conformance cases', () => {
    for (const [defect, fragments] of Object.entries(PROVEN)) {
        for (const fragment of fragments) {
            it(`${defect} fails "${fragment}"`, async () => {
                const c = find(fragment);
                const outcome = await c.run(createReferenceHarness({ [defect]: true })).then(
                    () => null,
                    (error: unknown) => error
                );
                expect(outcome, `${defect} went undetected by "${c.name}"`).not.toBeNull();
                // A failed assertion, not a crash in the case or the store.
                expect((outcome as Error).name).toBe('AssertionError');
            });
        }
    }

    it('leaves no conformance case without a defect that it detects', () => {
        const covered = new Set(Object.values(PROVEN).flat());
        const unproven = CONFORMANCE_CASES.filter((c) => ![...covered].some((f) => c.name.includes(f))).map(
            (c) => c.name
        );
        expect(unproven).toEqual(UNPROVEN);
    });

    it('passes every case with no defect', async () => {
        for (const c of CONFORMANCE_CASES) {
            await c.run(createReferenceHarness());
        }
    });
});
