import { describe, expect, it } from 'vitest';
import { failedAttentionReason } from '../src/db/batches/batch-store-repair.js';

const head = (failure_cause: string | null) => ({ head_id: 'job-1', failure_kind: 'publish', failure_cause });

describe('failedAttentionReason', () => {
    it('names an unresolved conflict when the repair budget is spent on one (issue #661)', () => {
        expect(failedAttentionReason('budget', head('conflict'))).toContain('merge conflict');
    });

    it('keeps the generic budget text for any other cause', () => {
        expect(failedAttentionReason('budget', head('verification'))).toContain('no automatic attempts left');
    });
});
