import type { UsagePrecision } from '@factory-ai/core';
import { precisionLabel, precisionMark } from './usage-format.js';

/** `~` for an estimated or mixed figure; the words always render, so meaning never rides on the glyph. */
export function PrecisionBadge({ precision }: { precision: UsagePrecision | null }) {
    const mark = precisionMark(precision);
    if (mark === '') return null;
    return (
        <span className="usage-precision">
            <span aria-hidden="true">{mark}</span>
            <span className="usage-precision-words">{precisionLabel(precision)}</span>
        </span>
    );
}
