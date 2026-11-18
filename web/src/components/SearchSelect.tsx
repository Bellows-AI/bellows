import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type AnchorSide, useSideAnchor } from '../anchor.js';
import { Icon, type IconName } from './Icon.js';

/** One row of the open list. An `action` row runs and keeps the list open; any other commits `value`. */
export interface SearchRow {
    value: string;
    label: string;
    /** Muted text before the label (a repository's owner); the search matches the two joined. */
    prefix?: string;
    action?: () => void;
    disabled?: boolean;
    /** False for a row the search does not describe (Load more, "Use “typed”"); default true. */
    highlight?: boolean;
}

/** A line under the options — a status or an error, never a choice. */
export interface SearchNote {
    text: string;
    tone: 'status' | 'alert';
    key?: string;
}

const matchRange = (full: string, query: string): [number, number] | null => {
    const typed = query.trim().toLowerCase();
    if (typed === '') return null;
    const at = full.toLowerCase().indexOf(typed);
    return at < 0 ? null : [at, at + typed.length];
};

/** The part of `full` that `text` covers (from `offset`), with the matched span bold and underlined. */
function Highlighted({ text, offset, full, query }: { text: string; offset: number; full: string; query: string }) {
    const range = matchRange(full, query);
    if (range === null) return <>{text}</>;
    const from = Math.max(range[0] - offset, 0);
    const to = Math.min(range[1] - offset, text.length);
    if (from >= to) return <>{text}</>;
    return (
        <>
            {text.slice(0, from)}
            <b className="popover-match">{text.slice(from, to)}</b>
            {text.slice(to)}
        </>
    );
}

/** The rows whose joined prefix and label hold the search, case-insensitively; all of them for an empty search. */
export function filterRows(rows: readonly SearchRow[], query: string): SearchRow[] {
    const typed = query.trim().toLowerCase();
    return rows.filter((row) => `${row.prefix ?? ''}${row.label}`.toLowerCase().includes(typed));
}

const isOpenKey = (e: KeyboardEvent): boolean =>
    e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;

/** The search a key on the closed chip opens the list with: none for an arrow, the character for a typed one. */
function openSeed(e: KeyboardEvent): string | null {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return '';
    return isOpenKey(e) ? e.key : null;
}

/** Calls `onAway` for a mousedown outside every element `inside` returns, while `enabled`. */
function useMouseDownAway(enabled: boolean, inside: () => (Element | null)[], onAway: () => void) {
    const latest = useRef({ inside, onAway });
    latest.current = { inside, onAway };
    useEffect(() => {
        if (!enabled) return;
        const away = (e: MouseEvent) => {
            if (!latest.current.inside().some((element) => element?.contains(e.target as Node)))
                latest.current.onAway();
        };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [enabled]);
}

/** One row. Focus stays in the search field (`aria-activedescendant`), so the row takes the pointer only. */
function SearchOption({
    row,
    id,
    selected,
    active,
    query,
    onHover,
    onPick,
}: {
    row: SearchRow;
    id: string;
    selected: boolean;
    active: boolean;
    query: string;
    onHover: () => void;
    onPick: () => void;
}) {
    const full = `${row.prefix ?? ''}${row.label}`;
    const shown = row.highlight === false ? '' : query;
    return (
        <div
            id={id}
            role="option"
            tabIndex={-1}
            aria-selected={selected}
            aria-disabled={row.disabled === true ? true : undefined}
            data-selected={selected ? '' : undefined}
            data-focus={active ? '' : undefined}
            className={row.action === undefined ? 'popover-option' : 'popover-option popover-action'}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={onHover}
            onClick={onPick}
            onKeyDown={undefined}
        >
            {row.prefix === undefined ? null : (
                <span className="popover-prefix">
                    <Highlighted text={row.prefix} offset={0} full={full} query={shown} />
                </span>
            )}
            <span>
                <Highlighted text={row.label} offset={row.prefix?.length ?? 0} full={full} query={shown} />
            </span>
        </div>
    );
}

/** The chip: glyph, value, ▾. Its name is "Field: value"; the value is always its text. */
function SearchTrigger({
    triggerRef,
    icon,
    name,
    text,
    open,
    disabled,
    missing,
    onClick,
    onKeyDown,
}: {
    triggerRef: (node: HTMLButtonElement | null) => void;
    icon: IconName;
    name: string;
    text: string;
    open: boolean;
    disabled: boolean;
    missing: boolean;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            ref={triggerRef}
            type="button"
            className={missing ? 'select-trigger composer-trigger-missing' : 'select-trigger'}
            aria-label={name}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-open={open ? '' : undefined}
            title={name.slice(name.indexOf(': ') + 2)}
            disabled={disabled}
            onClick={onClick}
            onKeyDown={onKeyDown}
        >
            <Icon name={icon} />
            <span className="composer-context-value">{text}</span>
        </button>
    );
}

/** The open list's body: the search field and note (first below the chip, last above it), the rows, the notes. */
function SearchPanel({
    field,
    listId,
    upward,
    help,
    query,
    rows,
    value,
    activeIndex,
    emptyText,
    notes,
    searchRef,
    onQuery,
    onKeyDown,
    onHover,
    onPick,
}: {
    field: string;
    listId: string;
    upward: boolean;
    help: ReactNode;
    query: string;
    rows: readonly SearchRow[];
    value: string;
    activeIndex: number;
    emptyText: string;
    notes: readonly SearchNote[];
    searchRef: RefObject<HTMLInputElement | null>;
    onQuery: (query: string) => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    onHover: (index: number) => void;
    onPick: (row: SearchRow) => void;
}) {
    const header = (
        <div className="popover-head">
            <div className="popover-search">
                <input
                    ref={searchRef}
                    className="popover-search-input"
                    role="combobox"
                    aria-label={`Search ${field.toLowerCase()}`}
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
                    aria-autocomplete="list"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Search…"
                    value={query}
                    onChange={(e) => onQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                />
            </div>
            {help === undefined ? null : (
                <p className="composer-note" role="presentation">
                    {help}
                </p>
            )}
        </div>
    );
    const list = (
        <div className="popover-list">
            <div id={listId} role="listbox" aria-label={field}>
                {rows.map((row, index) => (
                    <SearchOption
                        key={`${row.action === undefined ? 'o' : 'a'}:${row.value}`}
                        row={row}
                        id={optionId(listId, index)}
                        selected={isChosen(row, value)}
                        active={index === activeIndex}
                        query={query}
                        onHover={() => onHover(index)}
                        onPick={() => onPick(row)}
                    />
                ))}
            </div>
            {rows.some((row) => row.action === undefined) ? null : (
                <p className="composer-note" role="status">
                    {emptyText}
                </p>
            )}
            {notes.map((note) => (
                <p
                    key={note.key ?? note.text}
                    className={note.tone === 'alert' ? 'composer-note popover-error' : 'composer-note'}
                    role={note.tone}
                >
                    {note.text}
                </p>
            ))}
        </div>
    );
    return upward ? (
        <>
            {list}
            {header}
        </>
    ) : (
        <>
            {header}
            {list}
        </>
    );
}

/** The arrow keys' move through the rows. */
const STEP_KEYS: Record<string, number | undefined> = { ArrowDown: 1, ArrowUp: -1 };

const optionId = (listId: string, index: number): string => `${listId}-${index}`;
const isChosen = (row: SearchRow, value: string): boolean => row.action === undefined && row.value === value;

/** Whether the list is open, the search typed in it and the active row; each change is told to the caller. */
function useListState(
    trigger: RefObject<HTMLButtonElement | null>,
    onOpenChange: ((open: boolean) => void) | undefined,
    onQueryChange: ((query: string) => void) | undefined
) {
    const [open, setOpenState] = useState(false);
    const [query, setQueryState] = useState('');
    const [active, setActive] = useState(0);
    const setQuery = (next: string) => {
        setQueryState(next);
        setActive(0);
        onQueryChange?.(next);
    };
    const setOpen = (next: boolean, seed = '') => {
        setOpenState(next);
        setQueryState(seed);
        setActive(0);
        onOpenChange?.(next);
        onQueryChange?.(seed);
    };
    const close = (refocus: boolean) => {
        setOpen(false);
        if (refocus) trigger.current?.focus();
    };
    return { open, query, active, setActive, setQuery, setOpen, close };
}

/**
 * The composer's one dropdown: a chip (glyph, value, ▾) whose open list has a search field, the field's help note, then
 * the rows. The chip always shows the value; the search is only ever a filter, so the value changes through a row and
 * nowhere else. `down` opens below, `up` above and flips below only for want of room; an upward list puts the search
 * on its bottom edge, next to the chip.
 */
export function SearchSelect({
    field,
    icon,
    valueLabel,
    fullLabel,
    value,
    options,
    before,
    after,
    notes,
    filter = true,
    help,
    emptyText = 'No matches',
    side = 'down',
    disabled,
    missing,
    onChange,
    onOpenChange,
    onQueryChange,
}: {
    field: string;
    icon: IconName;
    valueLabel: string;
    /** What the chip names in full when `valueLabel` is a short form (a repository's owner/name); else the value. */
    fullLabel?: string;
    value: string;
    options: readonly SearchRow[];
    /** Rows ahead of the options, for the search typed so far. */
    before?: (query: string) => readonly SearchRow[];
    /** Rows after the options: actions the list runs. */
    after?: readonly SearchRow[];
    notes?: readonly SearchNote[];
    /** False when the caller searches (Branch asks the board), so the options arrive already narrowed. */
    filter?: boolean;
    help?: ReactNode;
    emptyText?: string;
    side?: AnchorSide;
    disabled?: boolean;
    missing?: boolean;
    onChange: (value: string) => void;
    onOpenChange?: (open: boolean) => void;
    onQueryChange?: (query: string) => void;
}) {
    const anchor = useSideAnchor(side, 'start');
    const listId = useId();
    const trigger = useRef<HTMLButtonElement | null>(null);
    const panel = useRef<HTMLDivElement | null>(null);
    const search = useRef<HTMLInputElement | null>(null);
    const { open, query, active, setActive, setQuery, setOpen, close } = useListState(
        trigger,
        onOpenChange,
        onQueryChange
    );

    const shown = filter ? filterRows(options, query) : options;
    const rows = open ? [...(before?.(query) ?? []), ...shown, ...(after ?? [])] : [];
    const activeIndex = Math.min(active, rows.length - 1);
    const chosen = rows.findIndex((row) => isChosen(row, value));

    // Opening lands on the chosen row, else the first; the search takes focus either way.
    useEffect(() => {
        if (!open) return;
        search.current?.focus();
        setActive(Math.max(chosen, 0));
    }, [open]);
    useEffect(() => {
        if (open) document.getElementById(optionId(listId, activeIndex))?.scrollIntoView?.({ block: 'nearest' });
    }, [open, listId, activeIndex]);
    useMouseDownAway(
        open,
        () => [panel.current, trigger.current],
        () => setOpen(false)
    );

    const pick = (row: SearchRow | undefined) => {
        if (row === undefined || row.disabled === true) return;
        if (row.action !== undefined) {
            row.action();
            search.current?.focus();
            return;
        }
        onChange(row.value);
        close(true);
    };

    const move = (step: number) => {
        const enabled = rows.flatMap((row, index) => (row.disabled === true ? [] : [index]));
        const at = enabled.indexOf(activeIndex);
        const next = enabled[Math.min(Math.max(at + step, 0), enabled.length - 1)];
        if (next !== undefined) setActive(next);
    };

    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
        const step = STEP_KEYS[e.key];
        if (step !== undefined) move(step);
        else if (e.key === 'Enter') pick(rows[activeIndex]);
        else if (e.key === 'Escape') close(true);
        else if (e.key === 'Tab')
            close(true); // and the browser carries focus on from the chip
        else return;
        if (e.key !== 'Tab') {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
        const seed = open || disabled === true ? null : openSeed(e);
        if (seed === null) return;
        e.preventDefault();
        setOpen(true, seed);
    };

    return (
        <>
            <SearchTrigger
                triggerRef={(node) => {
                    trigger.current = node;
                    anchor.setReference(node);
                }}
                icon={icon}
                name={`${field}: ${fullLabel ?? valueLabel}`}
                text={valueLabel}
                open={open}
                disabled={disabled === true}
                missing={missing === true}
                onClick={() => (open ? close(false) : setOpen(true))}
                onKeyDown={onTriggerKey}
            />
            {open
                ? createPortal(
                      <div
                          ref={(node) => {
                              panel.current = node;
                              anchor.setFloating(node);
                          }}
                          style={anchor.floatingStyles}
                          className="popover popover-search-select"
                          data-placement={anchor.placement.startsWith('top') ? 'up' : 'down'}
                      >
                          <SearchPanel
                              field={field}
                              listId={listId}
                              upward={anchor.placement.startsWith('top')}
                              help={help}
                              query={query}
                              rows={rows}
                              value={value}
                              activeIndex={activeIndex}
                              emptyText={emptyText}
                              notes={notes ?? []}
                              searchRef={search}
                              onQuery={setQuery}
                              onKeyDown={onSearchKey}
                              onHover={setActive}
                              onPick={pick}
                          />
                      </div>,
                      document.body
                  )
                : null}
        </>
    );
}
