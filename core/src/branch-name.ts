export const BATCH_BRANCH_LIMIT = 255;

/**
 * The shape a task's base branch (and a batch target's) may have: the rule `driver/src/publish/publish-base.ts`
 * applies before a name reaches an argv, plus the stored length cap. The driver imports nothing, so it keeps
 * its own copy; `server/test/branch-name.driver-copy.test.ts` pins the two together.
 */
export const isBranchName = (name: string): boolean =>
    name.length <= BATCH_BRANCH_LIMIT && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..');
