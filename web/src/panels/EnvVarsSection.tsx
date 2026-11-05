import { useState } from 'react';
import type { EnvSaveResult } from '../api/useEnv.js';
import { ConfigurationScope } from '../components/ConfigurationScope.js';
import type { ConfigurationScopeProps } from '../components/ConfigurationScope.js';
import { EnvVarsDialog } from '../components/EnvVarsDialog.js';
import type { EnvPayloadRow } from './env-draft.js';

/** How many names the summary lists before it says "and N more". */
const NAMES_SHOWN = 5;

export interface EnvVarsSectionProps {
    title: string;
    /** Which scope this section writes: its impact, editability and precedence render under the title. */
    scope: ConfigurationScopeProps;
    /** The scope's stored rows. A secret's value is null (write-only) and no value is ever rendered here. */
    vars: readonly EnvPayloadRow[];
    /** The whole-list PUT; the section reads the refreshed `vars` back from its page. */
    onSave: (vars: EnvPayloadRow[]) => Promise<EnvSaveResult>;
    /** The scope's stable id in the settings area's unsaved-change guard. */
    draftId: string;
    /** The scope's label in the guard dialog's body sentence. */
    draftLabel: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * One environment scope on a settings page (BEL-262b): a compact summary — the variable and
 * secret counts and the first few names, never a value — and the Edit variables button that
 * opens the editor dialog. The dialog owns the draft and is mounted only while open, so every
 * exit clears it; its draft rides the settings area's unsaved-change guard, which therefore
 * holds navigation while the dialog has unsaved edits. A successful save closes the dialog and
 * the page's own `useEnv` refetch refreshes `vars`.
 */
export function EnvVarsSection({ title, scope, vars, onSave, draftId, draftLabel }: EnvVarsSectionProps) {
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState(false);

    const variables = vars.filter((row) => !row.isSecret);
    const secrets = vars.filter((row) => row.isSecret);
    const names = vars.slice(0, NAMES_SHOWN);

    const save = async (next: EnvPayloadRow[]) => {
        const result = await onSave(next);
        if (!result.error) setSaved(true);
        return result;
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>{title}</h2>
                <button
                    type="button"
                    className="env-edit"
                    onClick={() => {
                        setSaved(false);
                        setOpen(true);
                    }}
                >
                    Edit variables
                </button>
            </div>
            <ConfigurationScope {...scope} />
            {vars.length === 0 ? (
                <p className="muted">No variables or secrets configured yet.</p>
            ) : (
                <div className="env-summary">
                    <p className="env-summary-counts">
                        {plural(variables.length, 'variable')} · {plural(secrets.length, 'secret')}
                    </p>
                    <ul className="env-summary-names">
                        {names.map((row) => (
                            <li key={`${row.isSecret ? 's' : 'v'}:${row.name}`}>
                                <code>{row.name}</code>
                                {row.isSecret ? <span className="muted"> secret, value hidden</span> : null}
                            </li>
                        ))}
                    </ul>
                    {vars.length > NAMES_SHOWN ? <p className="muted">and {vars.length - NAMES_SHOWN} more</p> : null}
                </div>
            )}
            <p className="muted" role="status">
                {saved ? 'Changes saved.' : ''}
            </p>
            {open ? (
                <EnvVarsDialog
                    title={title}
                    scope={scope}
                    initialVars={vars}
                    onSave={save}
                    onClose={() => setOpen(false)}
                    draftId={draftId}
                    draftLabel={draftLabel}
                />
            ) : null}
        </section>
    );
}
