import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { useRef, useState } from 'react';
import { useDownwardAnchor } from '../anchor.js';
import { useBranches } from '../api/useBranches.js';
import { Icon } from './Icon.js';

/** An option that runs an action instead of choosing a branch; never a value the picker commits. */
const LOAD_MORE = '\u0000load-more';
const RETRY = '\u0000retry';
const isAction = (value: string): boolean => value === LOAD_MORE || value === RETRY;

const DEFAULT_LABEL = 'Default';
const BRANCH_HELP = 'The branch the agent starts from. Search to narrow the list; the default is the repository’s own.';

/** Selects `data-branch-action` options on the keyboard path: Enter on one runs it and keeps the list open. */
const ACTIVE_ACTION = '[data-branch-action][data-focus]';

/**
 * The open list. Mounted only while the picker is open, so a closed picker reads nothing; the
 * branches hook lives here and ends with it.
 */
function BranchOptions({
    repo,
    query,
    anchor,
}: {
    repo: string;
    query: string;
    anchor: ReturnType<typeof useDownwardAnchor>;
}) {
    const list = useBranches(repo, query, true);
    const defaultLabel = list.defaultBranch === null ? DEFAULT_LABEL : `${DEFAULT_LABEL} (${list.defaultBranch})`;
    const run = (action: () => void) => (event: { preventDefault: () => void }) => {
        // Headless UI chooses an option on mousedown unless the event was already handled here,
        // so the option runs its action and the picker stays open.
        event.preventDefault();
        action();
    };
    return (
        <ComboboxOptions
            ref={anchor.setFloating}
            style={anchor.floatingStyles}
            portal
            className="popover composer-branch-options"
        >
            <p className="composer-note" role="presentation">
                {BRANCH_HELP}
            </p>
            <ComboboxOption value="" className="popover-option">
                {defaultLabel}
            </ComboboxOption>
            {list.branches.map((name) => (
                <ComboboxOption key={name} value={name} className="popover-option">
                    {name}
                </ComboboxOption>
            ))}
            {list.status === 'loading' ? (
                <p className="composer-note" role="status">
                    Loading branches…
                </p>
            ) : null}
            {list.status === 'ready' && list.branches.length === 0 ? (
                <p className="composer-note" role="status">
                    No matching branches
                </p>
            ) : null}
            {list.hasMore ? (
                <ComboboxOption
                    value={LOAD_MORE}
                    disabled={list.loadingMore}
                    data-branch-action=""
                    className="popover-option composer-branch-action"
                    onMouseDown={run(list.loadMore)}
                >
                    {list.loadingMore ? 'Loading more…' : 'Load more'}
                </ComboboxOption>
            ) : null}
            {list.error !== null ? (
                <>
                    <p className="composer-note composer-branch-error" role="alert">
                        {list.error}
                    </p>
                    <ComboboxOption
                        value={RETRY}
                        data-branch-action=""
                        className="popover-option composer-branch-action"
                        onMouseDown={run(list.retry)}
                    >
                        Retry
                    </ComboboxOption>
                </>
            ) : null}
        </ComboboxOptions>
    );
}

/**
 * The base-branch chip. Pick-only: the text typed in the field is only the search sent to the
 * board (debounced, server-side prefix); the value changes through an option and nowhere else. ''
 * is the repository's default branch.
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
    const anchor = useDownwardAnchor('start');
    const [query, setQuery] = useState('');
    const toggle = useRef<HTMLButtonElement | null>(null);
    const label = value === '' ? DEFAULT_LABEL : value;
    return (
        <Combobox
            immediate
            value={value}
            disabled={repo === ''}
            onChange={(next: string | null) => {
                if (next !== null && !isAction(next)) onChange(next);
            }}
            onClose={() => setQuery('')}
        >
            {({ open }) => (
                <>
                    <div ref={anchor.setReference} className="select-trigger composer-branch" title={label}>
                        <ComboboxButton ref={toggle} className="composer-branch-toggle" aria-label="Show branches">
                            <Icon name="git-branch" />
                        </ComboboxButton>
                        <ComboboxInput
                            className="composer-branch-input"
                            aria-label={`Base branch: ${label}`}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={label}
                            // The text field holds only the search; the chosen branch is its placeholder.
                            displayValue={() => ''}
                            onChange={(e) => setQuery(e.target.value)}
                            // `immediate` opens on focus only: a click on the still-focused field reopens.
                            onClick={() => {
                                if (!open) toggle.current?.click();
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                const action = document.querySelector<HTMLElement>(ACTIVE_ACTION);
                                if (action === null) return;
                                e.preventDefault();
                                action.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            }}
                        />
                    </div>
                    {open ? <BranchOptions repo={repo} query={query} anchor={anchor} /> : null}
                </>
            )}
        </Combobox>
    );
}
