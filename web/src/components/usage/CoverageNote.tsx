import type { PerType } from '@factory-ai/core';
import { OBSERVED_USAGE_NOTE, TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES, coverageLabel } from './usage-format.js';

/** One sentence per type measured by fewer sessions than contributed; nothing when all did. */
export function CoverageNote({ coverage }: { coverage: PerType<{ measured: number; contributors: number }> }) {
    const partial = USAGE_TOKEN_TYPES.flatMap((type) => {
        const label = coverageLabel(coverage[type]);
        return label === null ? [] : [{ type, label }];
    });
    if (partial.length === 0) return null;
    return (
        <ul className="usage-coverage">
            {partial.map(({ type, label }) => (
                <li key={type}>
                    Observed usage; {label} {TOKEN_TYPE_LABELS[type].toLowerCase()}.
                </li>
            ))}
        </ul>
    );
}

/** The standing sentence, shared by every panel that shows these figures. */
export function ObservedUsageNote() {
    return <p className="usage-coverage">{OBSERVED_USAGE_NOTE}.</p>;
}
