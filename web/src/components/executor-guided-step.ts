import type { ExecutorProvider } from '@factory-ai/core';
import type { Dispatch, SetStateAction } from 'react';
import { useKeyCheck } from '../model-setup/useKeyCheck.js';
import { modelOptions } from '../model-setup/providers.js';
import { applyGuidedChoice, type GuidedChoice } from '../workspace/executor-guided.js';
import { parseExecutorConfig, readModel, type ExecutorDraft } from '../workspace/executors.js';

/**
 * The guided provider step's state, split out of ExecutorDialog so the dialog stays the
 * draft's owner without growing past its lint budget. The choice lives in the draft per agent;
 * the live key check and the model suggestions ride beside it, recomputed from it, never stored.
 * A guided change regenerates the whole configuration from the choice; a raw edit that parses
 * re-reads the choice from the configuration, and one that does not hands the text back to the
 * raw editor.
 */
export function useGuidedStep(
    draft: ExecutorDraft,
    setDraft: Dispatch<SetStateAction<ExecutorDraft>>,
    subscriptionRefused: boolean
) {
    const { type } = draft;
    const guided = draft.guided[type];

    // The live key check the model step runs, over the guided choice's provider and key: idle while
    // no provider is picked, no key stands, the key is a stored marker (nothing typed to check), or
    // the endpoint is the member's own (nothing to check against here — a task reaches it when one
    // starts).
    const guidedKey = guided?.key.kind === 'key' ? guided.key.value : '';
    const check = useKeyCheck({
        provider: guided !== null && guided.provider !== 'openai-compatible' ? guided.provider : 'anthropic',
        // The member's own endpoint is not checked here (nothing to check against): no verify
        // request fires for it, for a pasted key, a stored marker or a secret reference alike.
        key:
            guided !== null && guided.provider !== 'openai-compatible' && !guidedKey.startsWith('stored-credential:')
                ? guidedKey
                : '',
        baseUrl: guided?.baseUrl ?? '',
        subscriptionAllowed: !subscriptionRefused,
    });
    const suggestions =
        guided === null || guided.provider === 'openai-compatible'
            ? []
            : modelOptions(guided.provider, type, check.models);

    /** One guided field's new value, regenerated into the configuration text. */
    const setGuided = (patch: Partial<GuidedChoice>) =>
        setDraft((current) => {
            const choice = current.guided[current.type];
            if (choice === null) return current;
            const next = { ...choice, ...patch };
            return {
                ...current,
                guided: { ...current.guided, [current.type]: next },
                configs: {
                    ...current.configs,
                    [current.type]: JSON.stringify(applyGuidedChoice(current.type, next), null, 2),
                },
                customModel: { ...current.customModel, [current.type]: true },
            };
        });

    /** Picking a provider starts the guided step from blank and keeps the text it replaces. */
    const pickProvider = (id: string) => {
        const choice: GuidedChoice = {
            provider: id as ExecutorProvider,
            key: { kind: 'none' },
            baseUrl: '',
            model: '',
        };
        setDraft((current) => ({
            ...current,
            guided: { ...current.guided, [current.type]: choice },
            preGuided: { ...current.preGuided, [current.type]: current.configs[current.type] },
            configs: {
                ...current.configs,
                [current.type]: JSON.stringify(applyGuidedChoice(current.type, choice), null, 2),
            },
            customModel: { ...current.customModel, [current.type]: true },
        }));
    };

    /** Removing the provider settings puts back the configuration the pick started from. */
    const removeGuided = () =>
        setDraft((current) => {
            const restored = current.preGuided[current.type];
            const parsed = parseExecutorConfig(restored);
            return {
                ...current,
                guided: { ...current.guided, [current.type]: null },
                configs: { ...current.configs, [current.type]: restored },
                customModel: {
                    ...current.customModel,
                    [current.type]: parsed.ok && readModel(parsed.value).kind === 'custom',
                },
            };
        });

    return { guided, check, suggestions, setGuided, pickProvider, removeGuided };
}
