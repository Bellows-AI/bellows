import { emptyBlock } from '@factory-ai/core';
import type { UsageBlock } from '@factory-ai/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UsageBreakdown } from '../src/components/usage/UsageBreakdown.js';
import './dom.js';

const usage: UsageBlock = {
    ...emptyBlock('measured'),
    tokens: { input: 100, output: 50, cacheRead: 7, cacheCreation: 0 },
    rows: [
        {
            model: 'model-a',
            rawModels: ['model-a', 'model-a-20250101'],
            querySource: null,
            tokens: { input: 60, output: 50, cacheRead: 7, cacheCreation: 0 },
            children: [
                {
                    model: 'model-a',
                    rawModels: [],
                    querySource: 'repl',
                    tokens: { input: 40, output: 30, cacheRead: 7, cacheCreation: 0 },
                },
                {
                    model: 'model-a',
                    rawModels: [],
                    querySource: 'unknown',
                    tokens: { input: 20, output: 20, cacheRead: null, cacheCreation: 0 },
                },
            ],
        },
        {
            model: 'unknown',
            rawModels: ['mystery-1'],
            querySource: null,
            tokens: { input: 40, output: null, cacheRead: null, cacheCreation: null },
        },
    ],
};

const footer = (container: HTMLElement) => container.querySelector('tfoot')!.textContent;

describe('UsageBreakdown (dom)', () => {
    it('expands to query-source rows without changing the footer or the block', () => {
        const before = JSON.stringify(usage);
        const { container } = render(<UsageBreakdown usage={usage} />);
        const footerBefore = footer(container);
        const toggle = screen.getByRole('button', { name: 'Show query sources for model-a' });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelectorAll('.usage-child-row')).toHaveLength(0);

        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.textContent).toBe('Hide query sources');
        const children = container.querySelectorAll('.usage-child-row');
        expect(children).toHaveLength(2);
        expect(children[0]!.getAttribute('aria-label')).toBe('Part of model-a');
        expect(footer(container)).toBe(footerBefore);
        expect(footer(container)).toContain('100');
        expect(footer(container)).not.toContain('160');
        expect(JSON.stringify(usage)).toBe(before);

        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelectorAll('.usage-child-row')).toHaveLength(0);
        expect(footer(container)).toBe(footerBefore);
    });

    it('shows unknown model and source buckets and the raw variants', () => {
        const { container } = render(<UsageBreakdown usage={usage} />);
        expect(screen.getByText('Unknown model')).toBeTruthy();
        expect(container.querySelector('[data-model="unknown"]')).not.toBeNull();
        expect(screen.getByText('Variants: model-a-20250101')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Show query sources for model-a/ }));
        const source = container.querySelector('[data-source="unknown"]') as HTMLElement;
        expect(within(source).getByText('Unknown source')).toBeTruthy();
        expect(within(source).getAllByText('—')).toHaveLength(1);
    });

    it('expands each model on its own', () => {
        const two: UsageBlock = {
            ...usage,
            rows: [
                usage.rows[0]!,
                {
                    ...usage.rows[0]!,
                    model: 'model-b',
                    rawModels: [],
                    children: [{ ...usage.rows[0]!.children![0]!, model: 'model-b' }],
                },
            ],
        };
        const { container } = render(<UsageBreakdown usage={two} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show query sources for model-b' }));
        expect(container.querySelectorAll('.usage-child-row')).toHaveLength(1);
        expect(
            screen.getByRole('button', { name: 'Show query sources for model-a' }).getAttribute('aria-expanded')
        ).toBe('false');
    });
});
