import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BranchCombobox } from '../src/components/BranchCombobox.js';
import { type FetchCall, stubFetch } from './dom.js';

/**
 * The base-branch picker over a stubbed board: pick-only, server-side debounced search, pages by
 * cursor, and a failed listing that says so instead of showing an empty list.
 */

const REPO = 'acme/web';
const BRANCHES_URL = `/api/repos/${REPO}/branches`;

const page = (branches: string[], cursor: string | null = null) => ({ branches, cursor, defaultBranch: 'main' });

const queryOf = (call: FetchCall): URLSearchParams => new URL(call.url, 'http://board').searchParams;
const listCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.startsWith(BRANCHES_URL));

function mount(value = '') {
    const onChange = vi.fn();
    render(<BranchCombobox repo={REPO} value={value} onChange={onChange} />);
    return { onChange, input: screen.getByRole('combobox') as HTMLInputElement };
}

describe('the base-branch picker', () => {
    it('lists the default first, then the branches, once opened', async () => {
        const calls = stubFetch(({ url }) => (url.startsWith(BRANCHES_URL) ? page(['feature-a', 'main']) : undefined));
        const user = userEvent.setup();
        const { input } = mount();
        expect(listCalls(calls)).toHaveLength(0);

        await user.click(input);
        const options = await screen.findAllByRole('option');
        expect(options.map((o) => o.textContent)).toEqual(['Default (main)', 'feature-a', 'main']);
        expect(listCalls(calls)).toHaveLength(1);
        expect(queryOf(listCalls(calls)[0] as FetchCall).has('q')).toBe(false);
    });

    it('sends ONE debounced search after the pause, not one per keystroke', async () => {
        const calls = stubFetch(({ url }) => (url.startsWith(BRANCHES_URL) ? page(['feature-a']) : undefined));
        const user = userEvent.setup();
        const { input } = mount();
        await user.click(input);
        await screen.findByRole('option', { name: 'feature-a' });

        await user.type(input, 'fea');
        await waitFor(() => expect(listCalls(calls).some((c) => queryOf(c).get('q') === 'fea')).toBe(true));
        const searches = listCalls(calls).filter((c) => queryOf(c).has('q'));
        expect(searches.map((c) => queryOf(c).get('q'))).toEqual(['fea']);
    });

    it('Load more sends the cursor and appends, deduping a repeated name', async () => {
        const calls = stubFetch(({ url }) => {
            if (!url.startsWith(BRANCHES_URL)) return;
            return queryOf({ url } as FetchCall).get('cursor') === 'c1' ? page(['b', 'c']) : page(['a', 'b'], 'c1');
        });
        const user = userEvent.setup();
        const { input } = mount();
        await user.click(input);
        await user.click(await screen.findByRole('option', { name: 'Load more' }));

        await screen.findByRole('option', { name: 'c' });
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Default (main)', 'a', 'b', 'c']);
        expect(screen.queryByRole('option', { name: 'Load more' })).toBeNull();
        expect(listCalls(calls).map((c) => queryOf(c).get('cursor'))).toEqual([null, 'c1']);
        // Load more is not a choice: the list stayed open and nothing was committed.
        expect(screen.getByRole('listbox')).toBeTruthy();
    });

    it('typed text with no option picked leaves the value unchanged', async () => {
        stubFetch(({ url }) => (url.startsWith(BRANCHES_URL) ? page([]) : undefined));
        const user = userEvent.setup();
        const { input, onChange } = mount('release');
        await user.click(input);
        await user.type(input, 'made-up-branch');
        await user.keyboard('{Escape}');
        await user.tab();
        expect(onChange).not.toHaveBeenCalled();
        expect(input.value).toBe('');
        expect(input.placeholder).toBe('release');
    });

    it('commits only what an option picks, and the default as an empty value', async () => {
        stubFetch(({ url }) => (url.startsWith(BRANCHES_URL) ? page(['feature-a']) : undefined));
        const user = userEvent.setup();
        const { input, onChange } = mount('release');
        await user.click(input);
        await user.click(await screen.findByRole('option', { name: 'feature-a' }));
        expect(onChange).toHaveBeenLastCalledWith('feature-a');
        await user.click(input);
        await user.click(await screen.findByRole('option', { name: 'Default (main)' }));
        expect(onChange).toHaveBeenLastCalledWith('');
    });

    it('a 503 shows the error with Retry, never "no branches"', async () => {
        let failing = true;
        const calls = stubFetch(({ url }) => {
            if (!url.startsWith(BRANCHES_URL)) return;
            return failing ? { status: 503, body: { error: 'GitHub is unreachable' } } : page(['feature-a']);
        });
        const user = userEvent.setup();
        const { input } = mount();
        await user.click(input);
        expect((await screen.findByRole('alert')).textContent).toBe('GitHub is unreachable');
        expect(screen.queryByText('No matching branches')).toBeNull();

        failing = false;
        await user.click(screen.getByRole('option', { name: 'Retry' }));
        await screen.findByRole('option', { name: 'feature-a' });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(listCalls(calls)).toHaveLength(2);
    });

    it('"No matching branches" only for a confirmed empty answer', async () => {
        stubFetch(({ url }) => (url.startsWith(BRANCHES_URL) ? page([]) : undefined));
        const user = userEvent.setup();
        const { input } = mount();
        await user.click(input);
        await screen.findByText('No matching branches');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('discards a late answer for an earlier query', async () => {
        let releaseFirst: (reply: unknown) => void = () => undefined;
        const first = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        stubFetch(({ url }) => {
            if (!url.startsWith(BRANCHES_URL)) return;
            const q = new URL(url, 'http://board').searchParams.get('q');
            if (q === 'a') return first;
            return q === 'ab' ? page(['ab-branch']) : page(['seed']);
        });
        const user = userEvent.setup();
        const { input } = mount();
        await user.click(input);
        await screen.findByRole('option', { name: 'seed' });
        await user.type(input, 'a');
        await waitFor(() => expect(screen.getByText('Loading branches…')).toBeTruthy());
        await user.type(input, 'b');
        await screen.findByRole('option', { name: 'ab-branch' });

        releaseFirst(page(['stale-a']));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole('option', { name: 'stale-a' })).toBeNull();
        expect(screen.getByRole('option', { name: 'ab-branch' })).toBeTruthy();
    });
});
