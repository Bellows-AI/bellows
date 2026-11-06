import { useId, useState } from 'react';
import { inputTokens, type Tokens, type UsageBlock, type UsageRow } from '@factory-ai/core';
import { pct, tokens as short } from '../../format.js';
import { TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES, figure, isUnknownBucket, rowKey, totalTokens } from './usage-format.js';

/** A fraction to a CSS width percent. */
const PERCENT = 100;

/** The exact four types, for the Total cell's tooltip: the strip rounds, the hover does not. */
const exactTitle = (t: Tokens): string =>
    USAGE_TOKEN_TYPES.map((type) => `${TOKEN_TYPE_LABELS[type]} ${figure(t[type])}`).join('\n');

function Figures({ tokens }: { tokens: Tokens }) {
    const input = inputTokens(tokens);
    return (
        <>
            <td className="align-end" data-label="Total" title={exactTitle(tokens)}>
                {short(totalTokens(tokens))}
            </td>
            <td className="align-end" data-label="Input">
                {short(input.total)}
            </td>
            <td className="align-end" data-label="Output">
                {short(tokens.output)}
            </td>
            <td className="align-end" data-label="Cache rate">
                {pct(input.cacheHitRatio)}
            </td>
        </>
    );
}

/** Share of the whole: a bar plus the rounded percent. Nothing renders when either side is unmeasured. */
function Share({ part, whole }: { part: number | null; whole: number | null }) {
    if (part === null || whole === null || whole === 0) return <td data-label="Share">—</td>;
    const share = part / whole;
    return (
        <td data-label="Share">
            <span className="model-share">
                <span className="usage-track" aria-hidden="true">
                    <span className="usage-bar" style={{ width: `${share * PERCENT}%` }} />
                </span>
                {pct(share)}
            </span>
        </td>
    );
}

/**
 * The dashboard's By model table: Total, Input, Output and Cache rate per model, rounded, with
 * the exact four types on the Total cell's hover. Each model expands to its query sources; a
 * source row is part of its model, never added to it, so expanding moves no figure.
 */
export function ModelUsageTable({ usage }: { usage: UsageBlock }) {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const prefix = useId();
    const whole = totalTokens(usage.tokens);
    const toggle = (key: string) =>
        setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    const rowLabel = (row: UsageRow) => (isUnknownBucket(row.model) ? 'Unknown model' : row.model);
    return (
        <div className="table-wrap">
            <table className="data table-cards model-usage">
                <thead>
                    <tr>
                        <th scope="col">Model</th>
                        <th scope="col">Share of total</th>
                        <th scope="col" className="align-end">
                            Total
                        </th>
                        <th scope="col" className="align-end">
                            Input
                        </th>
                        <th scope="col" className="align-end">
                            Output
                        </th>
                        <th scope="col" className="align-end">
                            Cache rate
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {usage.rows.map((row, index) => {
                        const key = rowKey(row);
                        const label = rowLabel(row);
                        const children = row.children ?? [];
                        const expanded = open.has(key);
                        const ids = children.map((_, i) => `${prefix}-${index}-${i}`);
                        return [
                            <tr key={key} data-model={row.model}>
                                <td data-label="Model">
                                    {label}
                                    {children.length === 0 ? null : (
                                        <button
                                            type="button"
                                            className="model-sources-toggle"
                                            aria-expanded={expanded}
                                            aria-controls={expanded ? ids.join(' ') : undefined}
                                            aria-label={`${expanded ? 'Hide' : 'Show'} sources for ${label}`}
                                            onClick={() => toggle(key)}
                                        >
                                            {expanded ? 'Hide sources' : 'Show sources'}
                                        </button>
                                    )}
                                </td>
                                <Share part={totalTokens(row.tokens)} whole={whole} />
                                <Figures tokens={row.tokens} />
                            </tr>,
                            ...(expanded
                                ? children.map((child, i) => (
                                      <tr
                                          key={`${key}-${rowKey(child)}`}
                                          id={ids[i]}
                                          className="usage-child-row"
                                          aria-label={`Part of ${label}`}
                                      >
                                          <td data-label="Source">
                                              {child.querySource === null || isUnknownBucket(child.querySource)
                                                  ? 'Unknown source'
                                                  : child.querySource}
                                          </td>
                                          <td />
                                          <Figures tokens={child.tokens} />
                                      </tr>
                                  ))
                                : []),
                        ];
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <th scope="row">All models</th>
                        <td />
                        <Figures tokens={usage.tokens} />
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
