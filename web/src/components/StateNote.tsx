import type { ReactNode } from 'react';

export type StateNoteState = 'loading' | 'empty' | 'error';

/**
 * The one loading / empty / error line. The role is the contract: loading is a polite status,
 * an error is an alert, and empty is plain text — so a failed or unconfirmed read is always
 * said as an error and never passes for "nothing here".
 */
export function StateNote({ state, id, children }: { state: StateNoteState; id?: string; children: ReactNode }) {
    if (state === 'error') {
        return (
            <p className="state-note error" role="alert" id={id}>
                {children}
            </p>
        );
    }
    return (
        <p className="state-note" role={state === 'loading' ? 'status' : undefined} id={id}>
            {children}
        </p>
    );
}
