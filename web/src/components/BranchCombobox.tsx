import { useState } from 'react';
import { useBranches } from '../api/useBranches.js';
import { type SearchNote, type SearchRow, SearchSelect } from './SearchSelect.js';

/** An action row's value; it runs and is never a branch the picker commits. */
const LOAD_MORE = '\u0000load-more';
const RETRY = '\u0000retry';

const DEFAULT_LABEL = 'Default';
const BRANCH_HELP = 'The branch the agent starts from. Search to narrow the list; the default is the repository’s own.';

/**
 * The branches hook lives here, enabled only while the list is open, so a closed picker reads nothing.
 * '' is the repository's default branch.
 */
function useBranchRows(repo: string, query: string, open: boolean) {
    const list = useBranches(repo, query, open);
    const defaultLabel = list.defaultBranch === null ? DEFAULT_LABEL : `${DEFAULT_LABEL} (${list.defaultBranch})`;
    const options: SearchRow[] = [
        { value: '', label: defaultLabel, highlight: false },
        ...list.branches.map((name) => ({ value: name, label: name })),
    ];
    const after: SearchRow[] = [];
    if (list.hasMore) {
        after.push({
            value: LOAD_MORE,
            label: list.loadingMore ? 'Loading more…' : 'Load more',
            action: list.loadMore,
            disabled: list.loadingMore,
            highlight: false,
        });
    }
    if (list.error !== null) {
        after.push({ value: RETRY, label: 'Retry', action: list.retry, highlight: false });
    }
    const notes: SearchNote[] = [];
    if (list.status === 'loading') notes.push({ text: 'Loading branches…', tone: 'status' });
    if (list.status === 'ready' && list.branches.length === 0)
        notes.push({ text: 'No matching branches', tone: 'status' });
    if (list.error !== null) notes.push({ text: list.error, tone: 'alert' });
    return { options, after, notes };
}

/**
 * The base-branch chip. Pick-only: the search is only the filter sent to the board (debounced, server-side prefix);
 * the value changes through a row and nowhere else.
 */
export function BranchCombobox({
    repo,
    value,
    onChange,
}: {
    repo: string;
    value: string;
    onChange: (branch: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const { options, after, notes } = useBranchRows(repo, query, open);
    return (
        <SearchSelect
            field="Base branch"
            icon="git-branch"
            valueLabel={value === '' ? DEFAULT_LABEL : value}
            value={value}
            options={options}
            after={after}
            notes={notes}
            filter={false}
            help={BRANCH_HELP}
            disabled={repo === ''}
            onChange={onChange}
            onOpenChange={setOpen}
            onQueryChange={setQuery}
        />
    );
}
