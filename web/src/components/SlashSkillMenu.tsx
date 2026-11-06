import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ANCHOR_GAP_PX, VIEWPORT_PADDING_PX, useUpwardAnchor } from '../anchor.js';
import type { UseRepoSkills } from '../api/useRepoSkills.js';
import {
    activeSlashToken,
    filterSkills,
    insertSkill,
    type SlashSkill,
    highlightIndex,
    slashKeyAction,
} from '../slash-skills.js';

const MENU_ID = 'composer-skill-menu';
const TIP_ID = `${MENU_ID}-tip`;
const optionId = (name: string): string => `${MENU_ID}-${name}`;

/**
 * The prompt's `/` menu state: the token under the caret, the skills it filters, the highlighted
 * row. Focus never leaves the textarea, so the list is driven from its key events and exposed to
 * assistive tech through the textarea's `aria-activedescendant`.
 */
export function useSlashMenu({
    text,
    setText,
    repoSkills,
    disabled,
}: {
    text: string;
    setText: (next: string) => void;
    repoSkills: UseRepoSkills;
    disabled: boolean;
}) {
    const anchor = useUpwardAnchor('start');
    const field = useRef<HTMLTextAreaElement | null>(null);
    const [caret, setCaret] = useState(0);
    const [focused, setFocused] = useState(false);
    // The slash Escape closed the menu on: it stays closed until the token moves.
    const [dismissed, setDismissed] = useState<number | null>(null);
    const [highlight, setHighlight] = useState({ prefix: '', index: 0 });
    const pendingCaret = useRef<number | null>(null);

    const token = disabled ? null : activeSlashToken(text, caret);
    const open = focused && token !== null && dismissed !== token.start;
    const items = token === null ? [] : filterSkills(repoSkills.skills, token.prefix);
    const index = highlightIndex(highlight, token?.prefix ?? '', items.length);
    const active: SlashSkill | undefined = items[index];

    useLayoutEffect(() => {
        if (pendingCaret.current === null || field.current === null) return;
        field.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
        pendingCaret.current = null;
    });

    // A token that moved or went re-arms Escape.
    useEffect(() => {
        if (token === null || token.start !== dismissed) setDismissed(null);
    }, [token, dismissed]);

    const pick = (skill: SlashSkill) => {
        if (token === null) return;
        const next = insertSkill(text, token, skill.name);
        pendingCaret.current = next.caret;
        setCaret(next.caret);
        setText(next.text);
    };
    const pickActive = () => {
        if (active !== undefined) pick(active);
    };
    const highlightAt = (next: number) => setHighlight({ prefix: token?.prefix ?? '', index: next });
    const move = (step: number) => highlightAt((index + step + items.length) % items.length);

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || token === null) return;
        const action = slashKeyAction(e.key, { ctrl: e.ctrlKey, meta: e.metaKey }, items.length);
        if (action === null) return;
        e.preventDefault();
        if (action === 'close') setDismissed(token.start);
        else if (action === 'pick') pickActive();
        else move(action === 'down' ? 1 : -1);
    };

    const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart);
    const fieldProps = {
        ref: (el: HTMLTextAreaElement | null) => {
            field.current = el;
            anchor.setReference(el);
        },
        role: 'combobox' as const,
        'aria-autocomplete': 'list' as const,
        'aria-haspopup': 'listbox' as const,
        'aria-expanded': open,
        'aria-controls': open ? MENU_ID : undefined,
        'aria-activedescendant': open && active !== undefined ? optionId(active.name) : undefined,
        onKeyDown,
        onKeyUp: (e: KeyboardEvent<HTMLTextAreaElement>) => syncCaret(e.currentTarget),
        onClick: (e: { currentTarget: HTMLTextAreaElement }) => syncCaret(e.currentTarget),
        onSelect: (e: { currentTarget: HTMLTextAreaElement }) => syncCaret(e.currentTarget),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
    };

    return {
        fieldProps,
        /** Call from the textarea's change handler: the caret moves with the text. */
        onTextChange: (el: HTMLTextAreaElement) => setCaret(el.selectionStart),
        menu: open
            ? {
                  items,
                  prefix: token?.prefix ?? '',
                  activeName: active?.name ?? null,
                  repoSkills,
                  anchor,
                  onPick: pick,
                  onHover: (skill: SlashSkill) => highlightAt(items.indexOf(skill)),
              }
            : null,
    };
}

/**
 * The `/` menu over the prompt: one compact row per skill name, the typed prefix marked. The
 * highlighted row's description sits in a tooltip beside the menu, outside it so the menu's
 * scroll never clips it, and is that row's `aria-describedby`. Mouse picks keep the textarea
 * focused.
 */
export function SlashSkillMenu({
    items,
    prefix,
    activeName,
    repoSkills,
    anchor,
    onPick,
    onHover,
}: {
    items: readonly SlashSkill[];
    prefix: string;
    activeName: string | null;
    repoSkills: UseRepoSkills;
    anchor: ReturnType<typeof useUpwardAnchor>;
    onPick: (skill: SlashSkill) => void;
    onHover: (skill: SlashSkill) => void;
}) {
    const { status, repoError, unreadable, error } = repoSkills;
    const tip = useFloating({
        placement: 'right-start',
        strategy: 'fixed',
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(ANCHOR_GAP_PX),
            flip({ padding: VIEWPORT_PADDING_PX }),
            shift({ padding: VIEWPORT_PADDING_PX }),
        ],
    });
    const active = items.find((skill) => skill.name === activeName);
    const listbox = useRef<HTMLDivElement | null>(null);
    // Keyboard moves keep the highlighted row in view inside the menu's own scroll.
    useLayoutEffect(() => {
        if (activeName === null) return;
        listbox.current?.ownerDocument.getElementById(optionId(activeName))?.scrollIntoView?.({ block: 'nearest' });
    }, [activeName]);
    return (
        <>
            <div ref={anchor.setFloating} style={anchor.floatingStyles} className="popover composer-skill-menu">
                <div id={MENU_ID} ref={listbox} role="listbox" aria-label="Skills" className="composer-skill-list">
                    {items.map((skill) => {
                        const isActive = skill.name === activeName;
                        const typed = skill.name.slice(0, prefix.length);
                        return (
                            <div
                                key={skill.name}
                                id={optionId(skill.name)}
                                ref={isActive ? tip.refs.setReference : undefined}
                                role="option"
                                tabIndex={-1}
                                aria-selected={isActive}
                                aria-describedby={isActive && skill.description !== '' ? TIP_ID : undefined}
                                data-focus={isActive ? '' : undefined}
                                className="popover-option composer-skill-option"
                                onMouseEnter={() => onHover(skill)}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    onPick(skill);
                                }}
                            >
                                <span className="composer-skill-name">
                                    /{typed === '' ? null : <span className="composer-skill-match">{typed}</span>}
                                    {skill.name.slice(prefix.length)}
                                </span>
                                {skill.source === 'repo' ? <span className="composer-skill-source">repo</span> : null}
                            </div>
                        );
                    })}
                </div>
                {status === 'loading' ? (
                    <p className="composer-note" role="status">
                        Loading skills…
                    </p>
                ) : null}
                {status === 'ready' && items.length === 0 ? (
                    <p className="composer-note" role="status">
                        No matching skills
                    </p>
                ) : null}
                {error !== null ? (
                    <p className="composer-note composer-branch-error" role="alert">
                        {error}
                    </p>
                ) : null}
                {repoError !== null ? (
                    <p className="composer-note" role="status">
                        Repository skills unavailable: {repoError}
                    </p>
                ) : null}
                {unreadable.length > 0 ? (
                    <p className="composer-note" role="status">
                        {unreadable.length} {unreadable.length === 1 ? 'skill' : 'skills'} could not be read
                    </p>
                ) : null}
            </div>
            {active === undefined || active.description === '' ? null : (
                <div
                    id={TIP_ID}
                    ref={tip.refs.setFloating}
                    style={tip.floatingStyles}
                    role="tooltip"
                    className="composer-skill-tip"
                >
                    {active.description}
                </div>
            )}
        </>
    );
}
