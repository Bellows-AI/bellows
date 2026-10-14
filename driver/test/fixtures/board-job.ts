/** The lease-holding job the board-client tests write against; `over` changes only what a test is about. */
export const boardJob = (over: { attempts?: number; claimSeq?: number } = {}) => ({
    id: 'job-1',
    command: 'echo hi',
    attempts: 1,
    claimSeq: 1,
    leaseToken: 'token-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    resumeSessionId: null,
    userId: null,
    ...over,
});
