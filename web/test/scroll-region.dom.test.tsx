import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ScrollRegion } from '../src/components/ScrollRegion.js';

describe('ScrollRegion', () => {
    afterEach(cleanup);

    it('is a focusable region named by its label, so overflow is reachable from the keyboard', () => {
        render(
            <ScrollRegion className="table-wrap" aria-label="Executors">
                <table />
            </ScrollRegion>
        );
        const region = screen.getByRole('region', { name: 'Executors' });
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(region.className).toBe('table-wrap');
    });

    it('wraps a log well as a focusable pre and hands its ref through', () => {
        const ref = createRef<HTMLPreElement>();
        const { container } = render(
            <ScrollRegion as="pre" className="chat-output" ref={ref}>
                the log
            </ScrollRegion>
        );
        const pre = container.querySelector('pre');
        expect(pre?.getAttribute('tabindex')).toBe('0');
        expect(ref.current).toBe(pre);
    });
});
