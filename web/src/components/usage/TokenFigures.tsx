import type { PerType, TokenType, Tokens, UsagePrecision } from '@factory-ai/core';
import { inputTokens } from '@factory-ai/core';
import { PrecisionBadge } from './PrecisionBadge.js';
import {
    TOKEN_TYPE_LABELS,
    TOTAL_INPUT_CAPTION,
    TOTAL_INPUT_LABEL,
    USAGE_TOKEN_TYPES,
    coverageLabel,
    figure,
} from './usage-format.js';

interface Props {
    tokens: Tokens;
    precision?: PerType<UsagePrecision | null>;
    coverage?: PerType<{ measured: number; contributors: number }>;
    /** Highlights one type, or the labelled input-side sum. */
    selected?: TokenType | 'inputSide';
    /** Adds the "Total input" figure, the only sum this component renders. */
    inputSide?: boolean;
}

/** A sum of parts: estimated only when every measured part is, mixed when any part is not exact. */
function sumPrecision(parts: (UsagePrecision | null)[]): UsagePrecision | null {
    const measured = parts.filter((part) => part !== null);
    if (measured.every((part) => part === 'estimated') && measured.length > 0) return 'estimated';
    return measured.some((part) => part !== 'exact') ? 'mixed' : null;
}

/** Four labelled figures for one `Tokens`. There is no four-type total, by construction. */
export function TokenFigures({ tokens, precision, coverage, selected, inputSide }: Props) {
    const side = inputSide === true ? inputTokens(tokens) : null;
    const sideParts = [tokens.input, tokens.cacheRead, tokens.cacheCreation];
    const sidePartial = side !== null && side.total !== null && sideParts.some((part) => part === null);
    const sidePrecision =
        precision === undefined ? null : sumPrecision([precision.input, precision.cacheRead, precision.cacheCreation]);
    return (
        <dl className="usage-figures">
            {USAGE_TOKEN_TYPES.map((type) => {
                const note = coverage === undefined ? null : coverageLabel(coverage[type]);
                return (
                    <div
                        key={type}
                        className="usage-figure"
                        data-type={type}
                        aria-current={selected === type ? 'true' : undefined}
                    >
                        <dt className="usage-figure-label">{TOKEN_TYPE_LABELS[type]}</dt>
                        <dd>
                            {figure(tokens[type])}
                            <PrecisionBadge precision={precision?.[type] ?? null} />
                            {note === null ? null : <small className="usage-coverage"> {note}</small>}
                        </dd>
                    </div>
                );
            })}
            {side === null ? null : (
                <div
                    className="usage-figure"
                    data-type="inputSide"
                    title={TOTAL_INPUT_CAPTION}
                    aria-current={selected === 'inputSide' ? 'true' : undefined}
                >
                    <dt className="usage-figure-label">{TOTAL_INPUT_LABEL}</dt>
                    <dd>
                        {figure(side.total)}
                        <PrecisionBadge precision={sidePrecision} />
                        <small className="usage-coverage"> {TOTAL_INPUT_CAPTION}</small>
                        {sidePartial ? (
                            <small className="usage-coverage"> (partial: a part is unmeasured)</small>
                        ) : null}
                    </dd>
                </div>
            )}
        </dl>
    );
}
