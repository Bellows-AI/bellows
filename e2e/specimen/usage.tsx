import type { ReactNode } from 'react';
import { emptyBlock } from '@factory-ai/core';
import type { UsageBlock, UsageRow } from '@factory-ai/core';
import { CoverageNote, ObservedUsageNote } from '../../web/src/components/usage/CoverageNote.js';
import { TokenFigures } from '../../web/src/components/usage/TokenFigures.js';
import { UsageBreakdown } from '../../web/src/components/usage/UsageBreakdown.js';
import { UsageDiagnostics } from '../../web/src/components/usage/UsageDiagnostics.js';
import { UsageStateNote } from '../../web/src/components/usage/UsageStateNote.js';
import { USAGE_STATES, usageCellId } from './matrix.js';
import type { UsageState } from './matrix.js';

const full = { measured: 4, contributors: 4 };
const block = (patch: Partial<UsageBlock>): UsageBlock => ({ ...emptyBlock('measured'), ...patch });

const rows: UsageRow[] = [
    {
        model: 'model-a',
        rawModels: ['model-a', 'model-a-20250101'],
        querySource: null,
        tokens: { input: 120_000, cacheRead: 2_400_000, cacheCreation: 30_000, output: 18_000 },
        children: [
            {
                model: 'model-a',
                rawModels: [],
                querySource: 'repl',
                tokens: { input: 100_000, cacheRead: 2_000_000, cacheCreation: 30_000, output: 15_000 },
            },
            {
                model: 'model-a',
                rawModels: [],
                querySource: 'unknown',
                tokens: { input: 20_000, cacheRead: 400_000, cacheCreation: 0, output: 3_000 },
            },
        ],
    },
    {
        model: 'unknown',
        rawModels: ['a-model-with-a-rather-long-unrecognized-identifier'],
        querySource: null,
        tokens: { input: 5_000, cacheRead: null, cacheCreation: null, output: 400 },
    },
];

const withRows = block({
    tokens: { input: 125_000, cacheRead: 2_400_000, cacheCreation: 30_000, output: 18_400 },
    precision: { input: 'exact', cacheRead: 'estimated', cacheCreation: 'exact', output: 'exact' },
    rows,
});

const CELLS: Record<UsageState, ReactNode> = {
    Measured: <TokenFigures tokens={withRows.tokens} precision={withRows.precision} inputSide selected="inputSide" />,
    Unmeasured: (
        <>
            <TokenFigures tokens={emptyBlock('unmeasured').tokens} inputSide />
            <UsageStateNote block={emptyBlock('unmeasured')} />
        </>
    ),
    'Measured zero': <TokenFigures tokens={{ input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }} />,
    Estimated: (
        <TokenFigures
            tokens={withRows.tokens}
            precision={{ input: 'exact', cacheRead: 'estimated', cacheCreation: 'mixed', output: 'exact' }}
        />
    ),
    'Partial coverage': (
        <>
            <TokenFigures
                tokens={{ input: 90_000, cacheRead: null, cacheCreation: 0, output: 4_100 }}
                coverage={{
                    input: full,
                    cacheRead: { measured: 0, contributors: 4 },
                    cacheCreation: full,
                    output: { measured: 3, contributors: 4 },
                }}
            />
            <CoverageNote
                coverage={{
                    input: full,
                    cacheRead: { measured: 0, contributors: 4 },
                    cacheCreation: full,
                    output: { measured: 3, contributors: 4 },
                }}
            />
            <ObservedUsageNote />
        </>
    ),
    Provisional: (
        <>
            <TokenFigures tokens={{ input: 8_000, cacheRead: 61_000, cacheCreation: 2_000, output: 900 }} />
            <UsageStateNote block={block({ provisional: true })} />
        </>
    ),
    Unavailable: <UsageStateNote block={emptyBlock('unavailable')} />,
    'Breakdown collapsed': <UsageBreakdown usage={withRows} />,
    'Breakdown expanded': <UsageBreakdown usage={withRows} />,
    Diagnostics: (
        <UsageDiagnostics
            usage={block({
                unlocated: { input: 1_200, cacheRead: null, cacheCreation: null, output: 80 },
                unresolvedTemporality: { observations: 3 },
                unassigned: [
                    { reason: 'no-segment', tokens: { input: 4_000, cacheRead: 0, cacheCreation: 0, output: 300 } },
                    { reason: 'overlap', tokens: { input: 900, cacheRead: null, cacheCreation: null, output: null } },
                ],
            })}
        />
    ),
};

/** The usage components in every state they have, beside the primitives grid. */
export function UsageSpecimen() {
    return (
        <section className="specimen-usage" aria-labelledby="specimen-usage-title">
            <h2 id="specimen-usage-title">Token usage</h2>
            <div className="specimen-usage-grid">
                {USAGE_STATES.map((state) => (
                    <article key={state} className="specimen-usage-cell" data-cell={usageCellId(state)}>
                        <h3>{state}</h3>
                        {CELLS[state]}
                    </article>
                ))}
            </div>
        </section>
    );
}
