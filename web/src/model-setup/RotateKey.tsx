import { useState } from 'react';
import type { SelectedExecutorView, UseModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { KeyField } from './KeyField.js';
import { PROVIDER_META, saveReason } from './providers.js';
import { rotateBody } from './save-body.js';
import { useSaveRun } from './SavePrimary.js';
import { useKeyCheck } from './useKeyCheck.js';

/**
 * Explicit rotation: a fresh key for the selected executor's own connection, in place under its id. The executor, its
 * model and the connection's name and endpoint stay; running tasks keep the key they were started with.
 */
export function useRotate(
    session: Session | null,
    setup: UseModelSetup,
    onSaved: () => void | Promise<void>,
    selected: SelectedExecutorView | undefined
) {
    const connection = selected?.connection ?? null;
    const [key, setKey] = useState('');
    const check = useKeyCheck({
        provider: connection?.provider ?? 'anthropic',
        key,
        baseUrl: connection?.baseUrl ?? '',
        subscriptionAllowed: session?.subscriptionToken === true,
    });
    const save = useSaveRun(setup, async () => {
        setKey('');
        await onSaved();
    });
    return {
        connection,
        key,
        setKey,
        check,
        save,
        reason: !connection
            ? 'No connection to replace the key of.'
            : !selected?.model
              ? 'This executor has no model recorded; choose one first.'
              : saveReason({
                    provider: connection.provider,
                    key,
                    baseUrl: connection.baseUrl ?? '',
                    model: selected.model,
                    check: check.kind,
                }),
        press: () => {
            if (!selected || !connection || !selected.model) return;
            void save.run(
                rotateBody({
                    selected,
                    connectionId: connection.id,
                    key,
                    agentType: selected.agentType,
                    model: selected.model,
                })
            );
        },
    };
}

export type RotateState = ReturnType<typeof useRotate>;

/** The replacement key's field and its live check, naming the connection it replaces. */
export function RotateView({ ids, state, onCancel }: { ids: string; state: RotateState; onCancel: () => void }) {
    const { connection } = state;
    if (!connection) return null;
    return (
        <>
            <p>
                Replace the key of <b>{connection.name}</b>. Executors that use it pick the new key up on their next
                task; running tasks keep theirs.
            </p>
            <KeyField
                ids={ids}
                meta={PROVIDER_META[connection.provider]}
                value={state.key}
                check={state.check}
                onChange={state.setKey}
            />
            {state.save.error ? <StateNote state="error">{state.save.error}</StateNote> : null}
            <button type="button" className="tertiary" onClick={onCancel}>
                Cancel
            </button>
        </>
    );
}
