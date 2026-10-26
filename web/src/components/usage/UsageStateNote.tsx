import type { UsageBlock } from '@factory-ai/core';

export const USAGE_STATE_TEXT = {
    loading: 'Loading usage…',
    unavailable: 'Usage is unavailable: the telemetry could not be read.',
    unmeasured: 'No usage was measured for this selection.',
    provisional: 'Live: figures are provisional.',
} as const;

function stateText(block: Pick<UsageBlock, 'state' | 'provisional'>): string | null {
    if (block.state !== 'measured') return USAGE_STATE_TEXT[block.state];
    return block.provisional ? USAGE_STATE_TEXT.provisional : null;
}

/** The one place the loading, unavailable, unmeasured and live wording lives. */
export function UsageStateNote({
    block,
    loading,
}: {
    block?: Pick<UsageBlock, 'state' | 'provisional'>;
    loading?: boolean;
}) {
    const text = loading === true ? USAGE_STATE_TEXT.loading : block === undefined ? null : stateText(block);
    if (text === null) return null;
    return (
        <p className="usage-state-note" role="status">
            {text}
        </p>
    );
}
