import { Radio, RadioGroup } from '@headlessui/react';
import type { ScopeSelection } from './RangeSelector.js';
import { scopeWord } from '../dashboardSummary.js';

const SCOPE_VALUES: readonly ScopeSelection[] = ['org', 'mine'];

/**
 * The Scope group of the analytics toolbar: Organization and Personal as a radiogroup on the
 * shared `.tabs` skin — a filter over one view owns no panel, so it is not a tablist. Headless UI
 * supplies `aria-checked`, the roving tabindex and the arrow keys. `scopeWord` supplies the label,
 * the same wording the rendered-data summary sentence uses.
 *
 * Rendered only when the session reports a signed-in user — under AUTH_MODE=none there is no
 * "me", and a control that renders anyway would advertise a filter the server can never answer.
 * Absent is the honest shape there: the page reads as org-scoped, which is exactly what it is.
 */
export function ScopeToggle({ scope, onChange }: { scope: ScopeSelection; onChange: (next: ScopeSelection) => void }) {
    return (
        <div className="toolbar-group">
            <span className="toolbar-label">Scope</span>
            <RadioGroup className="tabs" aria-label="Scope" value={scope} onChange={onChange}>
                {SCOPE_VALUES.map((value) => (
                    <Radio key={value} as="button" type="button" value={value}>
                        {scopeWord(value)}
                    </Radio>
                ))}
            </RadioGroup>
        </div>
    );
}
