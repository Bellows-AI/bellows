import { emptyBlock } from '@factory-ai/core';
import type { UsageBlock } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoverageNote, ObservedUsageNote } from '../src/components/usage/CoverageNote.js';
import { PrecisionBadge } from '../src/components/usage/PrecisionBadge.js';
import { TokenFigures } from '../src/components/usage/TokenFigures.js';
import { UsageBreakdown } from '../src/components/usage/UsageBreakdown.js';
import { UsageDiagnostics } from '../src/components/usage/UsageDiagnostics.js';
import { UsageStateNote } from '../src/components/usage/UsageStateNote.js';

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const none = { input: null, output: null, cacheRead: null, cacheCreation: null };
const block = (patch: Partial<UsageBlock>): UsageBlock => ({ ...emptyBlock('measured'), ...patch });

describe('TokenFigures', () => {
    it('renders null as a dash, a measured zero as 0 and a value grouped, per type', () => {
        const html = renderToStaticMarkup(
            <TokenFigures tokens={{ input: 1200, output: 0, cacheRead: null, cacheCreation: 7 }} />
        );
        expect(html).toMatch(/Uncached input<\/dt><dd>1,200</);
        expect(html).toMatch(/Output<\/dt><dd>0</);
        expect(html).toMatch(/Cache read<\/dt><dd>—</);
        expect(html).toMatch(/Cache write<\/dt><dd>7</);
        expect(html).not.toMatch(/Total/i);
    });

    it('never offers a combined figure, and labels the input-side sum when asked for it', () => {
        const tokens = { input: 10, output: 5, cacheRead: 20, cacheCreation: 30 };
        const plain = text(renderToStaticMarkup(<TokenFigures tokens={tokens} />));
        expect(plain).not.toMatch(/total|cost|\b65\b|\b60\b/i);
        const html = renderToStaticMarkup(<TokenFigures tokens={tokens} inputSide />);
        expect(html).toMatch(/Total input<\/dt><dd>60/);
        expect(html).toContain('title="uncached input + cache read + cache write"');
        expect(html).not.toMatch(/\b65\b/);
        expect(text(html).match(/total/gi)).toHaveLength(1);
    });

    it('keeps the input-side sum null when no input type was measured and flags a partial one', () => {
        const unmeasured = renderToStaticMarkup(<TokenFigures tokens={{ ...none, output: 4 }} inputSide />);
        expect(unmeasured).toMatch(/Total input<\/dt><dd>—/);
        const partial = renderToStaticMarkup(<TokenFigures tokens={{ ...none, input: 3, output: 4 }} inputSide />);
        expect(partial).toMatch(/Total input<\/dt><dd>3/);
        expect(partial).toContain('partial');
    });

    it('marks the input-side sum with the precision derived from its measured parts', () => {
        const sum = (
            precision: Record<
                'input' | 'cacheRead' | 'cacheCreation' | 'output',
                'exact' | 'estimated' | 'mixed' | null
            >
        ) =>
            renderToStaticMarkup(
                <TokenFigures
                    tokens={{ input: 10, output: 1, cacheRead: 20, cacheCreation: 30 }}
                    precision={precision}
                    inputSide
                />
            ).split('data-type="inputSide"')[1]!;
        const exact = { input: 'exact', output: 'exact', cacheRead: 'exact', cacheCreation: 'exact' } as const;
        expect(sum(exact)).not.toContain('usage-precision');
        expect(sum({ ...exact, cacheRead: 'estimated' })).toContain('mixed estimated and exact');
        expect(sum({ ...exact, cacheRead: 'mixed' })).toContain('mixed estimated and exact');
        expect(
            sum({ input: 'estimated', output: 'exact', cacheRead: 'estimated', cacheCreation: 'estimated' })
        ).toMatch(/usage-precision-words">estimated</);
        const partial = renderToStaticMarkup(
            <TokenFigures
                tokens={{ ...none, input: 3, cacheRead: 4 }}
                precision={{ input: 'estimated', output: null, cacheRead: 'estimated', cacheCreation: null }}
                inputSide
            />
        );
        expect(partial.split('data-type="inputSide"')[1]).toMatch(/usage-precision-words">estimated</);
    });

    it('does not flag a fully measured sum or an unmeasured one as partial', () => {
        const full = renderToStaticMarkup(
            <TokenFigures tokens={{ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }} inputSide />
        );
        expect(full).not.toContain('partial');
        expect(renderToStaticMarkup(<TokenFigures tokens={none} inputSide />)).not.toContain('partial');
    });

    it('marks estimates, coverage and the selected type', () => {
        const html = renderToStaticMarkup(
            <TokenFigures
                tokens={{ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }}
                precision={{ input: 'exact', output: 'estimated', cacheRead: 'mixed', cacheCreation: null }}
                coverage={{
                    input: { measured: 2, contributors: 2 },
                    output: { measured: 1, contributors: 3 },
                    cacheRead: { measured: 2, contributors: 2 },
                    cacheCreation: { measured: 2, contributors: 2 },
                }}
                selected="output"
            />
        );
        expect(html).toContain('estimated</span>');
        expect(html).toContain('mixed estimated and exact');
        expect(html).toContain('1 of 3 sessions measured');
        expect(html.match(/sessions measured/g)).toHaveLength(1);
        expect(html).toMatch(/data-type="output" aria-current="true"/);
    });
});

describe('PrecisionBadge, CoverageNote, UsageStateNote', () => {
    it('renders nothing for exact or unknown precision, and the words beside the glyph otherwise', () => {
        expect(renderToStaticMarkup(<PrecisionBadge precision="exact" />)).toBe('');
        expect(renderToStaticMarkup(<PrecisionBadge precision={null} />)).toBe('');
        const html = renderToStaticMarkup(<PrecisionBadge precision="estimated" />);
        expect(html).toContain('<span aria-hidden="true">~</span>');
        expect(html).toContain('usage-precision-words">estimated<');
    });

    it('states the coverage sentence only when fewer sessions measured a type than contributed', () => {
        const full = { measured: 2, contributors: 2 };
        const all = { input: full, output: full, cacheRead: full, cacheCreation: full };
        expect(renderToStaticMarkup(<CoverageNote coverage={all} />)).toBe('');
        const html = renderToStaticMarkup(
            <CoverageNote coverage={{ ...all, cacheRead: { measured: 3, contributors: 5 } }} />
        );
        expect(text(html)).toContain('Observed usage; 3 of 5 sessions measured cache read.');
        expect(text(renderToStaticMarkup(<ObservedUsageNote />))).toContain(
            'Figures describe observed usage, not guaranteed complete consumption.'
        );
    });

    it('words loading, unavailable, unmeasured and live in one place, and is silent for settled data', () => {
        expect(text(renderToStaticMarkup(<UsageStateNote loading />))).toContain('Loading usage');
        expect(text(renderToStaticMarkup(<UsageStateNote block={emptyBlock('unavailable')} />))).toContain(
            'unavailable'
        );
        expect(text(renderToStaticMarkup(<UsageStateNote block={emptyBlock('unmeasured')} />))).toContain('No usage');
        expect(text(renderToStaticMarkup(<UsageStateNote block={block({ provisional: true })} />))).toContain(
            'Live: figures are provisional'
        );
        expect(renderToStaticMarkup(<UsageStateNote block={block({})} />)).toBe('');
    });
});

describe('UsageDiagnostics', () => {
    it('renders nothing when nothing is outside the figures', () => {
        expect(renderToStaticMarkup(<UsageDiagnostics usage={block({})} />)).toBe('');
        const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        expect(
            renderToStaticMarkup(
                <UsageDiagnostics usage={block({ unassigned: [{ reason: 'overlap', tokens: zero }] })} />
            )
        ).toBe('');
    });

    it('treats null, false and empty children as absent and renders real children', () => {
        for (const empty of [null, false, undefined, [null, false]]) {
            expect(renderToStaticMarkup(<UsageDiagnostics usage={block({})}>{empty}</UsageDiagnostics>)).toBe('');
        }
        const onlyChildren = renderToStaticMarkup(
            <UsageDiagnostics usage={block({})}>
                <p>tenant note</p>
            </UsageDiagnostics>
        );
        expect(onlyChildren).toContain('tenant note');
        expect(onlyChildren).not.toContain('<ul');
    });

    it('words a single unresolved observation in the singular', () => {
        const one = text(
            renderToStaticMarkup(<UsageDiagnostics usage={block({ unresolvedTemporality: { observations: 1 } })} />)
        );
        expect(one).toContain('1 observation whose counting mode is unresolved');
        expect(one).not.toContain('observations');
    });

    it('lists unlocated, unresolved and unassigned amounts apart from totals', () => {
        const html = renderToStaticMarkup(
            <UsageDiagnostics
                usage={block({
                    unlocated: { ...none, input: 9 },
                    unresolvedTemporality: { observations: 2 },
                    unassigned: [{ reason: 'no-segment', tokens: { ...none, output: 5 } }],
                })}
            />
        );
        const body = text(html);
        expect(body).toContain('Not in the figures above');
        expect(body).toContain('usage whose time is unknown');
        expect(body).toContain('2 observations whose counting mode is unresolved');
        expect(body).toContain('usage between runs of this task');
        expect(html).toContain('data-reason="no-segment"');
    });
});

describe('UsageBreakdown', () => {
    const usage = block({
        tokens: { input: 100, output: 50, cacheRead: null, cacheCreation: 0 },
        precision: { input: 'exact', output: 'estimated', cacheRead: null, cacheCreation: null },
        rows: [
            {
                model: 'model-a',
                rawModels: ['model-a', 'model-a-20250101'],
                querySource: null,
                tokens: { input: 60, output: 50, cacheRead: null, cacheCreation: 0 },
                children: [
                    {
                        model: 'model-a',
                        rawModels: [],
                        querySource: 'repl',
                        tokens: { input: 60, output: 50, cacheRead: null, cacheCreation: 0 },
                    },
                ],
            },
            {
                model: 'unknown',
                rawModels: [],
                querySource: null,
                tokens: { input: 40, output: null, cacheRead: null, cacheCreation: null },
            },
        ],
    });

    it('renders collapsed model rows, the variants line and unknown bucket, with the footer from the block', () => {
        const html = renderToStaticMarkup(<UsageBreakdown usage={usage} />);
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('usage-child-row');
        expect(html).toContain('Variants: model-a-20250101');
        expect(html).toContain('Unknown model');
        expect(html).toContain('data-model="unknown"');
        expect(html).toMatch(/<tfoot>.*All models.*>100</s);
        expect(html).toMatch(/<tfoot>.*>—</s);
        expect(text(html)).not.toMatch(/total|cost/i);
    });

    it('renders nothing without rows', () => {
        expect(renderToStaticMarkup(<UsageBreakdown usage={block({})} />)).toBe('');
    });
});
