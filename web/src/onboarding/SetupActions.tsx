import { type ReactNode, useId } from 'react';
import { StateNote } from '../components/StateNote.js';

/**
 * A step's action row: Back (when the step has one), Skip for now (when it can be skipped) and the one primary action.
 * A busy or waiting primary is `aria-disabled`, never `disabled`, and the walk ignores a second press; `reason` is the
 * line under it that says what it waits for (`null` once it may run, absent for a primary that never waits; `ready` then takes its place). A failed
 * save is the shared alert above the row.
 */
export function SetupActions({
    back,
    onSkip,
    primary,
    reason,
    ready,
    busy,
    error,
    onPrimary,
}: {
    back?: ReactNode;
    onSkip?: () => void;
    primary: string;
    reason?: string | null;
    /** The line under the primary once it may run (what pressing it does); with `reason` set, it is never shown. */
    ready?: string;
    busy: boolean;
    error: string | null;
    onPrimary: () => void;
}) {
    const why = useId();
    const waiting = busy || (reason ?? null) !== null;
    return (
        <>
            {error ? <StateNote state="error">{error}</StateNote> : null}
            <div className="setup-actions">
                {back ?? null}
                {onSkip ? (
                    <button type="button" className="tertiary" aria-disabled={busy || undefined} onClick={onSkip}>
                        Skip for now
                    </button>
                ) : null}
                <div className="model-primary">
                    <button
                        type="button"
                        className="primary"
                        aria-disabled={waiting || undefined}
                        aria-describedby={reason === undefined ? undefined : why}
                        onClick={() => {
                            if (!waiting) onPrimary();
                        }}
                    >
                        {primary}
                    </button>
                    {reason === undefined ? null : (
                        <p className="model-save-why" id={why}>
                            {reason ?? ready}
                        </p>
                    )}
                </div>
            </div>
        </>
    );
}
