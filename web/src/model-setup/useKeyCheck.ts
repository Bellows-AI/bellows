import type { ModelProvider } from '@factory-ai/core';
import { useEffect, useState } from 'react';
import { verifyKey } from '../api/useModelSetup.js';
import { type CheckKind, checkLine, keyRefusal, PROVIDER_META } from './providers.js';

/** How long typing must pause before the key is checked: one call per pasted or settled key. */
export const CHECK_DEBOUNCE_MS = 350;

export interface KeyCheck {
    kind: CheckKind;
    text: string;
    /** The models the check returned, when it returned any. */
    models?: string[];
}

interface Tagged extends KeyCheck {
    /** The input this state answers: a state for any other input is stale and never shown. */
    tag: string;
}

/**
 * The live key check (`POST /api/model-setup/verify`): debounced, one request at a time. Every new input — and
 * unmounting — aborts the request in flight, and an answer is shown only for the input it was asked for. The server
 * bounds the check; the client waits for it, and retries only when the member asks (`retry`).
 */
export function useKeyCheck(input: {
    provider: ModelProvider;
    key: string;
    baseUrl: string;
    /** Whether the org may configure a Claude subscription token: when not, a pasted one is refused unchecked. */
    subscriptionAllowed: boolean;
}): KeyCheck & { retry: () => void } {
    const { provider, subscriptionAllowed } = input;
    const key = input.key.trim();
    const baseUrl = provider === 'subscription' ? '' : input.baseUrl.trim();
    const [attempt, setAttempt] = useState(0);
    const tag = JSON.stringify([provider, key, baseUrl, subscriptionAllowed, attempt]);
    const [state, setState] = useState<Tagged>({ tag: '', kind: 'idle', text: '' });

    useEffect(() => {
        const own = JSON.stringify([provider, key, baseUrl, subscriptionAllowed, attempt]);
        const refusal = keyRefusal(key, subscriptionAllowed);
        if (!key || (provider === 'litellm' && !baseUrl)) {
            setState({ tag: own, kind: 'idle', text: '' });
            return;
        }
        if (refusal) {
            setState({ tag: own, kind: 'bad', text: refusal });
            return;
        }
        setState({ tag: own, kind: 'wait', text: PROVIDER_META[provider].checking });
        const abort = new AbortController();
        const timer = setTimeout(async () => {
            const result = await verifyKey({ provider, key, ...(baseUrl ? { baseUrl } : {}) }, abort.signal);
            if (abort.signal.aborted) return;
            if (!result.ok) {
                setState({ tag: own, kind: 'error', text: `Bellows could not check the key: ${result.error}` });
                return;
            }
            const models = result.value.ok ? result.value.models : undefined;
            setState({ tag: own, ...checkLine(provider, result.value), ...(models ? { models } : {}) });
        }, CHECK_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            abort.abort();
        };
    }, [provider, key, baseUrl, subscriptionAllowed, attempt]);

    const retry = () => setAttempt((n) => n + 1);
    // Between an input change and its effect, the state still answers the previous input: show it as pending.
    if (state.tag !== tag) return { kind: key ? 'wait' : 'idle', text: '', retry };
    return { kind: state.kind, text: state.text, ...(state.models ? { models: state.models } : {}), retry };
}
