import type { Session } from '../api/useSession.js';
import { KeyField } from './KeyField.js';
import { keyReason, PROVIDER_META } from './providers.js';
import { useKeyCheck } from './useKeyCheck.js';
import { useState } from 'react';
import type { ProviderConnectionMeta } from '@factory-ai/core';

/**
 * Replacing a connection's key in place: the key's field and its live check, naming the connection. The executor, its
 * model and the connection's name and endpoint stay; running tasks keep the key they were started with.
 */
export function useReplaceKey(session: Session | null, connection: ProviderConnectionMeta | null) {
    const [key, setKey] = useState('');
    const check = useKeyCheck({
        provider: connection?.provider ?? 'anthropic',
        key,
        baseUrl: connection?.baseUrl ?? '',
        subscriptionAllowed: session?.subscriptionToken === true,
    });
    const reason = keyReason(key, check.kind);
    return { key, setKey, check, reason };
}

export type ReplaceKeyDraft = ReturnType<typeof useReplaceKey>;

export function ReplaceKey({
    ids,
    connection,
    draft,
    onCancel,
}: {
    ids: string;
    connection: ProviderConnectionMeta;
    draft: ReplaceKeyDraft;
    onCancel: () => void;
}) {
    return (
        <>
            <p>
                Replace the key of <b>{connection.name}</b>. Executors that use it pick the new key up on their next
                task; running tasks keep theirs.
            </p>
            <KeyField
                ids={ids}
                meta={PROVIDER_META[connection.provider]}
                value={draft.key}
                check={draft.check}
                onChange={draft.setKey}
            />
            <button type="button" className="tertiary" onClick={onCancel}>
                Cancel
            </button>
        </>
    );
}
