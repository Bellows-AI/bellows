import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopeSelection } from '../src/components/RangeSelector.js';
import { ScopeToggle } from '../src/components/ScopeToggle.js';

/** The analytics Scope filter: a radiogroup, because it filters one view and owns no panel. */

const mount = (scope: ScopeSelection) => {
    const onChange = vi.fn();
    render(<ScopeToggle scope={scope} onChange={onChange} />);
    return onChange;
};

describe('ScopeToggle', () => {
    afterEach(cleanup);

    it('is a radiogroup named Scope with the selected scope checked and the other not', () => {
        mount('org');
        const group = screen.getByRole('radiogroup', { name: 'Scope' });
        expect(group).toBeTruthy();
        expect(screen.queryByRole('tablist')).toBeNull();
        expect(screen.queryByRole('tab')).toBeNull();
        expect(screen.getByRole('radio', { name: 'Organization' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'Personal' }).getAttribute('aria-checked')).toBe('false');
    });

    it('checks the personal scope, spelled out in full', () => {
        mount('mine');
        expect(screen.getByRole('radio', { name: 'Personal' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'Organization' }).getAttribute('aria-checked')).toBe('false');
    });

    it('rolls focus to the checked radio only, and an arrow key selects and focuses the other', async () => {
        const onChange = mount('org');
        expect(screen.getByRole('radio', { name: 'Organization' }).getAttribute('tabindex')).toBe('0');
        expect(screen.getByRole('radio', { name: 'Personal' }).getAttribute('tabindex')).toBe('-1');
        screen.getByRole('radio', { name: 'Organization' }).focus();
        await userEvent.setup().keyboard('{ArrowRight}');
        expect(onChange).toHaveBeenCalledWith('mine');
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Personal' }));
    });
});
