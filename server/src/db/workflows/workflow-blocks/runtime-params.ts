/**
 * The allowlist and params parser of the workflow-block runtime (issue #231): the pure half of
 * `runtime.ts`, split out so the block compiler (`workflow-blocks/index.ts`) and the catalog
 * routes validate a runtime descriptor without loading the transactional park/wake code, which
 * reaches the job store's SQL.
 */
import type { BlockConfigValue, WorkflowNode } from '../workflow-schema.js';

/** The one runtime id shipped so far. A future one is a new entry in `HANDLERS`, nothing else. */
export const BLOCK_RUNTIME_IDS = ['pr-delivery-wait'] as const;
export type BlockRuntimeId = (typeof BLOCK_RUNTIME_IDS)[number];

interface BlockRuntimeHandler {
    id: BlockRuntimeId;
    /** Validates a descriptor's raw `params` at compile time; `null` refuses `BAD_BLOCK_CONFIG`. */
    parseParams(raw: Record<string, BlockConfigValue>): Record<string, BlockConfigValue> | null;
}

/**
 * Parks the thread until GitHub review activity folds against the thread's published PR, then
 * makes exactly one continuation claimable. No params of its own today — the wait's address (repo,
 * PR number) comes from the thread's recorded publication (#202's `job_pr`), never from config.
 */
const PR_DELIVERY_WAIT: BlockRuntimeHandler = {
    id: 'pr-delivery-wait',
    parseParams(raw) {
        return Object.keys(raw).length === 0 ? {} : null;
    },
};

const HANDLERS: ReadonlyMap<BlockRuntimeId, BlockRuntimeHandler> = new Map(
    [PR_DELIVERY_WAIT].map((handler) => [handler.id, handler])
);

export function isBlockRuntimeId(id: string): id is BlockRuntimeId {
    return HANDLERS.has(id as BlockRuntimeId);
}

/**
 * Validates one runtime descriptor's params against its handler — the compiler's own attach step
 * (`workflow-blocks/index.ts`). `null` means the id is unknown or the params do not match its
 * handler's shape; either refuses `BAD_BLOCK_CONFIG` before the descriptor's node is ever stored.
 */
export function parseRuntimeParams(
    runtimeId: string,
    raw: Record<string, BlockConfigValue>
): Record<string, BlockConfigValue> | null {
    const handler = HANDLERS.get(runtimeId as BlockRuntimeId);
    return handler ? handler.parseParams(raw) : null;
}

/** Whether a resolved snapshot node's own `runtime` is well-formed against the current allowlist. */
export function runtimeIsValid(node: WorkflowNode): boolean {
    if (!node.runtime) return false;
    return parseRuntimeParams(node.runtime.runtime, node.runtime.params) !== null;
}
