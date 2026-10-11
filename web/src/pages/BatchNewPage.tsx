import { BatchDraft } from '../panels/BatchDraft.js';

/** `/batches/new`: a blank draft. Saving it creates the batch and moves to its own address. */
export function BatchNewPage() {
    return <BatchDraft record={null} onChanged={() => undefined} />;
}
