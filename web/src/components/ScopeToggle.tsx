import type { KeyboardEvent } from 'react';
import type { ScopeSelection } from './RangeSelector.js';
import { scopeWord } from '../dashboardSummary.js';

const SCOPE_VALUES: readonly ScopeSelection[] = ['org', 'mine'];

/**
 * The Scope group of the analytics toolbar: Organization and Personal as the shared `.tabs`
 * strip, the selected one marked by `aria-selected`. `scopeWord` supplies the tab text, the same
 * wording the rendered-data summary sentence uses. Arrow keys move the selection (roving focus).
 *
 * Rendered only when the session reports a signed-in user — under AUTH_MODE=none there is no
 * "me", and a control that renders anyway would advertise a filter the server can never answer.
 * Absent is the honest shape there: the page reads as org-scoped, which is exactly what it is.
 */
export function ScopeToggle({ scope, onChange }: { scope: ScopeSelection; onChange: (next: ScopeSelection) => void }) {
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = SCOPE_VALUES[(SCOPE_VALUES.indexOf(scope) + 1) % SCOPE_VALUES.length]!;
        onChange(next);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
    };
    return (
        <div className="toolbar-group">
            <span className="toolbar-label">Scope</span>
            <div className="tabs" role="tablist" aria-label="Scope">
                {SCOPE_VALUES.map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        data-scope={value}
                        aria-selected={value === scope}
                        tabIndex={value === scope ? 0 : -1}
                        onClick={() => onChange(value)}
                        onKeyDown={onKeyDown}
                    >
                        {scopeWord(value)}
                    </button>
                ))}
            </div>
        </div>
    );
}
