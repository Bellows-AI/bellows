import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchSelect } from '../src/components/SearchSelect.js';

afterEach(cleanup);

/** The composer's shared searchable list, on its own: filtering, the keyboard, and where the search sits. */

const REPOS = [
    { value: 'acme/web', prefix: 'acme/', label: 'web' },
    { value: 'acme/api', prefix: 'acme/', label: 'api' },
    { value: 'globex/web', prefix: 'globex/', label: 'web' },
];

function mount(props: Partial<Parameters<typeof SearchSelect>[0]> = {}) {
    const onChange = vi.fn();
    render(
        <SearchSelect
            field="Repository"
            icon="repo"
            valueLabel="web"
            fullLabel="acme/web"
            value="acme/web"
            options={REPOS}
            help="The codebase the task runs in."
            onChange={onChange}
            {...props}
        />
    );
    return { onChange, chip: screen.getByRole('button', { name: 'Repository: acme/web' }) as HTMLButtonElement };
}

const search = () => screen.getByRole('combobox', { name: 'Search repository' }) as HTMLInputElement;
const names = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('the searchable select', () => {
    it('shows the value as the chip text and opens with the search focused, the note under it', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        expect(chip.textContent).toBe('web');
        expect(chip.title).toBe('acme/web');
        await user.click(chip);
        expect(document.activeElement).toBe(search());
        expect(names()).toEqual(['acme/web', 'acme/api', 'globex/web']);
        const selected = screen.getByRole('option', { selected: true });
        expect(selected.textContent).toBe('acme/web');
        const note = screen.getByText('The codebase the task runs in.');
        // Search, then note, then the options.
        expect(search().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(note.compareDocumentPosition(selected) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('filters on the owner or the name and marks the match bold and underlined, never by color alone', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        await user.click(chip);
        await user.type(search(), 'glo');
        expect(names()).toEqual(['globex/web']);
        const mark = within(screen.getByRole('option')).getByText('glo');
        expect(mark.tagName).toBe('B');
        expect(mark.className).toBe('popover-match');

        await user.clear(search());
        await user.type(search(), 'AP');
        expect(names()).toEqual(['acme/api']);

        await user.clear(search());
        await user.type(search(), 'nothing');
        expect(screen.queryByRole('option')).toBeNull();
        expect(screen.getByText('No matches')).toBeTruthy();
    });

    it('renders the owner muted and the name plain', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        await user.click(chip);
        const row = screen.getByRole('option', { name: 'globex/web' });
        expect(row.querySelector('.popover-prefix')?.textContent).toBe('globex/');
    });

    it('moves with the arrows, chooses with Enter and returns focus to the chip', async () => {
        const user = userEvent.setup();
        const { chip, onChange } = mount();
        await user.click(chip);
        await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('globex/web');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(document.activeElement).toBe(chip);
    });

    it('stops at the ends of the list rather than wrapping', async () => {
        const user = userEvent.setup();
        const { chip, onChange } = mount();
        await user.click(chip);
        await user.keyboard('{ArrowUp}{ArrowUp}{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('acme/web');
    });

    it('Esc closes and focuses the chip; Tab closes', async () => {
        const user = userEvent.setup();
        const { chip, onChange } = mount();
        await user.click(chip);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(document.activeElement).toBe(chip);

        await user.click(chip);
        await user.tab();
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('skips a disabled row when moving', async () => {
        const user = userEvent.setup();
        const { chip, onChange } = mount({
            options: [REPOS[0]!, { ...REPOS[1]!, disabled: true }, REPOS[2]!],
        });
        await user.click(chip);
        await user.keyboard('{ArrowDown}{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('globex/web');
    });

    it('Enter right after a character typed on the chip takes the first row, not the chosen one', async () => {
        const user = userEvent.setup();
        const { chip, onChange } = mount();
        chip.focus();
        await user.keyboard('a{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('acme/web');
        onChange.mockClear();
        chip.focus();
        await user.keyboard('api{Enter}');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('acme/api');
    });

    it('a character typed on the focused chip opens the list with it already searched', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        chip.focus();
        await user.keyboard('g');
        expect(search().value).toBe('g');
        expect(document.activeElement).toBe(search());
        expect(names()).toEqual(['globex/web']);
    });

    it('opens on an arrow key, without a search', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        chip.focus();
        await user.keyboard('{ArrowDown}');
        expect(search().value).toBe('');
        expect(names()).toHaveLength(3);
    });

    it('a click outside closes it', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        await user.click(chip);
        await user.click(document.body);
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('a disabled chip does not open', async () => {
        const user = userEvent.setup();
        const { chip } = mount({ disabled: true });
        await user.click(chip);
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('opens downward with the search on top, and upward with the search on the bottom edge by the chip', async () => {
        const user = userEvent.setup();
        const { chip } = mount();
        await user.click(chip);
        const down = screen.getByRole('listbox').closest('.popover-search-select') as HTMLElement;
        expect(down.dataset.placement).toBe('down');
        expect(down.firstElementChild?.className).toBe('popover-head');
        await user.keyboard('{Escape}');

        cleanup();
        mount({ side: 'up' });
        await user.click(screen.getByRole('button', { name: 'Repository: acme/web' }));
        const up = screen.getByRole('listbox').closest('.popover-search-select') as HTMLElement;
        // jsdom has no layout, so the panel keeps the side it was asked for; the flip itself is `upwardMiddleware`'s.
        expect(up.dataset.placement).toBe('up');
        expect(up.lastElementChild?.className).toBe('popover-head');
        expect(up.firstElementChild?.className).toBe('popover-list');
    });

    it('wears the form skin only when asked: the chip stays frameless in the composer', async () => {
        mount();
        expect(screen.getByRole('button', { name: 'Repository: acme/web' }).classList.contains('in-form')).toBe(false);
        cleanup();
        mount({ variant: 'form' });
        const chip = screen.getByRole('button', { name: 'Repository: acme/web' });
        expect(chip.classList.contains('select-trigger')).toBe(true);
        expect(chip.classList.contains('in-form')).toBe(true);
    });
});
