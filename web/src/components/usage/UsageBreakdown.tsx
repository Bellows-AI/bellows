import { useId, useState } from 'react';
import type { UsageBlock, UsageRow } from '@factory-ai/core';
import { PrecisionBadge } from './PrecisionBadge.js';
import { TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES, figure, isUnknownBucket, rowKey } from './usage-format.js';

const cells = (tokens: UsageRow['tokens']) =>
    USAGE_TOKEN_TYPES.map((type) => (
        <td key={type} className="align-end" data-label={TOKEN_TYPE_LABELS[type]}>
            {figure(tokens[type])}
        </td>
    ));

const variantsOf = (row: UsageRow): string[] => row.rawModels.filter((raw) => raw !== row.model);

function ChildRow({ child, id, label }: { child: UsageRow; id: string | undefined; label: string }) {
    const unknown = child.querySource === null || isUnknownBucket(child.querySource);
    return (
        <tr
            id={id}
            className="usage-child-row"
            data-source={child.querySource ?? 'unknown'}
            aria-label={`Part of ${label}`}
        >
            <td data-label="Query source">{unknown ? 'Unknown source' : child.querySource}</td>
            {cells(child.tokens)}
        </tr>
    );
}

interface ModelRowsProps {
    row: UsageRow;
    idPrefix: string;
    expanded: boolean;
    onToggle: () => void;
}

/** One model row and, when expanded, its query-source rows. */
function ModelRows({ row, idPrefix, expanded, onToggle }: ModelRowsProps) {
    const children = row.children ?? [];
    const variants = variantsOf(row);
    const label = isUnknownBucket(row.model) ? 'Unknown model' : row.model;
    const ids = children.map((_, childIndex) => `${idPrefix}-${childIndex}`);
    return (
        <>
            <tr data-model={row.model}>
                <td data-label="Model">
                    {label}
                    {variants.length === 0 ? null : (
                        <span className="usage-variants">Variants: {variants.join(', ')}</span>
                    )}
                    {children.length === 0 ? null : (
                        <button
                            type="button"
                            className="usage-breakdown-toggle"
                            aria-expanded={expanded}
                            aria-controls={expanded ? ids.join(' ') : undefined}
                            aria-label={`${expanded ? 'Hide' : 'Show'} query sources for ${label}`}
                            onClick={onToggle}
                        >
                            {expanded ? 'Hide query sources' : 'Show query sources'}
                        </button>
                    )}
                </td>
                {cells(row.tokens)}
            </tr>
            {expanded
                ? children.map((child, childIndex) => (
                      <ChildRow key={rowKey(child)} child={child} id={ids[childIndex]} label={label} />
                  ))
                : null}
        </>
    );
}

/**
 * Model rows, each expandable to its query-source rows (collapsed by default). The footer reads
 * `usage.tokens` only: a child row is a part of its parent, never added to it, so expanding
 * cannot change any figure.
 */
export function UsageBreakdown({ usage }: { usage: UsageBlock }) {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const prefix = useId();
    if (usage.rows.length === 0) return null;
    const toggle = (key: string) =>
        setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    return (
        <div className="table-wrap">
            <table className="data table-cards usage-breakdown">
                <thead>
                    <tr>
                        <th scope="col">Model</th>
                        {USAGE_TOKEN_TYPES.map((type) => (
                            <th key={type} scope="col" className="align-end">
                                {TOKEN_TYPE_LABELS[type]}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {usage.rows.map((row, index) => (
                        <ModelRows
                            key={rowKey(row)}
                            row={row}
                            idPrefix={`${prefix}-${index}`}
                            expanded={open.has(rowKey(row))}
                            onToggle={() => toggle(rowKey(row))}
                        />
                    ))}
                </tbody>
                <tfoot>
                    <tr>
                        <th scope="row">All models</th>
                        {USAGE_TOKEN_TYPES.map((type) => (
                            <td key={type} className="align-end" data-label={TOKEN_TYPE_LABELS[type]}>
                                {figure(usage.tokens[type])}
                                <PrecisionBadge precision={usage.precision[type]} />
                            </td>
                        ))}
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
