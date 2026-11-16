import type { ReactNode } from 'react';
import { StateNote } from '../components/StateNote.js';

/**
 * A step's action row: Back (when the step has one) and the one primary action. A busy primary is
 * `aria-disabled`, never `disabled`, and the walk ignores a second press; a failed save is the
 * shared alert above the row.
 */
export function SetupActions({
    back,
    primary,
    busy,
    error,
    onPrimary,
}: {
    back?: ReactNode;
    primary: string;
    busy: boolean;
    error: string | null;
    onPrimary: () => void;
}) {
    return (
        <>
            {error ? <StateNote state="error">{error}</StateNote> : null}
            <div className="setup-actions">
                {back ?? null}
                <button type="button" className="primary" aria-disabled={busy || undefined} onClick={onPrimary}>
                    {primary}
                </button>
            </div>
        </>
    );
}
