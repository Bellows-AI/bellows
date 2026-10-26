import { describe, expect, it } from 'vitest';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import type { JobAdmissionStore } from '../src/db/jobs/job-store-admission.js';
import type { JobClaimStore } from '../src/db/jobs/job-store-claim.js';
import type { JobConclusionStore } from '../src/db/jobs/job-store-conclusions.js';
import type { JobMergeStore } from '../src/db/jobs/job-store-merge.js';
import type { GateRunStore } from '../src/db/jobs/job-store-gate-runs.js';
import type { PrOperationStore } from '../src/db/jobs/job-store-pr-operations.js';
import type { TranscriptToolStore } from '../src/db/jobs/job-store-transcript-tools.js';
import type { PhaseCheckpointStore } from '../src/db/jobs/job-store-phase-checkpoints.js';
import type { JobQuestionStore } from '../src/db/jobs/job-store-questions.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import type { JobReclaimStore } from '../src/db/jobs/job-store-reclaims.js';
import type { JobReviewStore } from '../src/db/jobs/job-store-reviews.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { JobWorkerStore } from '../src/db/jobs/job-store-worker.js';

/**
 * `JobStore` is the intersection of one interface per concern, each beside the file that
 * implements it. Compile-time only: `npm run typecheck` is the assertion, so a method added to
 * `JobStore` without a concern, or claimed by two, stops the build.
 */

type Slices =
    | JobActionStore
    | JobAdmissionStore
    | JobClaimStore
    | JobConclusionStore
    | JobMergeStore
    | JobQuestionStore
    | JobReadStore
    | JobReclaimStore
    | JobReviewStore
    | JobWorkerStore
    | PhaseCheckpointStore
    | GateRunStore
    | PrOperationStore
    | TranscriptToolStore;

type KeysOfEach<T> = T extends unknown ? keyof T : never;
type SliceKeys = KeysOfEach<Slices>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Every JobStore method belongs to a slice, and no slice names a method JobStore lacks.
type EveryMethodHasAConcern = Expect<Equal<keyof JobStore, SliceKeys>>;

// No method is claimed by two concerns: a slice shares no key with any other slice.
type Alone<S> = Equal<keyof S & KeysOfEach<Exclude<Slices, S>>, never>;
type Disjoint = [
    Expect<Alone<JobActionStore>>,
    Expect<Alone<JobAdmissionStore>>,
    Expect<Alone<JobClaimStore>>,
    Expect<Alone<JobConclusionStore>>,
    Expect<Alone<JobMergeStore>>,
    Expect<Alone<JobQuestionStore>>,
    Expect<Alone<JobReadStore>>,
    Expect<Alone<JobReclaimStore>>,
    Expect<Alone<JobReviewStore>>,
    Expect<Alone<JobWorkerStore>>,
    Expect<Alone<PhaseCheckpointStore>>,
];

// A handler typed to one slice cannot reach another concern's methods.
const questionsOnly = (store: JobQuestionStore): void => {
    void store.askQuestion;
    // @ts-expect-error claim belongs to JobClaimStore
    void store.claim;
};

const concernChecks: [EveryMethodHasAConcern, Disjoint[number]] = [true, true];

describe('JobStore concerns', () => {
    it('names every method once', () => {
        expect(concernChecks).toEqual([true, true]);
    });

    it('the full store satisfies every slice', () => {
        const accepts = (_: JobStore): void => {};
        const narrow = (store: JobStore): void => {
            const slices: [
                JobActionStore,
                JobAdmissionStore,
                JobClaimStore,
                JobConclusionStore,
                JobMergeStore,
                JobQuestionStore,
                JobReadStore,
                JobReclaimStore,
                JobReviewStore,
                JobWorkerStore,
                PhaseCheckpointStore,
            ] = [store, store, store, store, store, store, store, store, store, store, store];
            void slices;
            questionsOnly(store);
        };
        accepts({} as JobStore);
        expect(typeof narrow).toBe('function');
    });
});
