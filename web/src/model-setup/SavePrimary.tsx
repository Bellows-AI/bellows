import { useState } from 'react';
import type { ModelSetupSave, UseModelSetup } from '../api/useModelSetup.js';

/**
 * A save's run: write (when there is something to write), re-read the setup, and only then hand over. A refused write
 * stays put with its sentence; a second press while one runs is ignored.
 */
export function useSaveRun(setup: UseModelSetup, onSaved: () => void | Promise<void>) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = async (body: ModelSetupSave | null) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        if (body !== null) {
            const saved = await setup.save(body);
            if (!saved.ok) {
                setError(saved.error);
                setBusy(false);
                return;
            }
            await setup.reread();
        }
        setBusy(false);
        await onSaved();
    };
    return { busy, error, run };
}

/** The view's one primary: `aria-disabled` while it waits, never `disabled`, with the reason under it. */
export function SavePrimary({
    ids,
    label,
    reason,
    busy,
    onPress,
}: {
    ids: string;
    label: string;
    reason: string | null;
    busy: boolean;
    onPress: () => void;
}) {
    const waiting = reason !== null || busy;
    return (
        <div className="model-primary">
            <button
                type="button"
                className="primary"
                aria-disabled={waiting || undefined}
                aria-describedby={`${ids}-why`}
                onClick={() => {
                    if (!waiting) onPress();
                }}
            >
                {label}
            </button>
            <p className="model-save-why" id={`${ids}-why`}>
                {reason}
            </p>
        </div>
    );
}
