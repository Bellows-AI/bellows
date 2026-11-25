import type { ModelProvider } from '@factory-ai/core';
import { useState } from 'react';
import type { SetupScope } from '../api/useModelSetup.js';
import type { ProviderMeta } from './providers.js';
import { secretNames } from './providers.js';
import type { KeyCheck } from './useKeyCheck.js';

const MARK: Partial<Record<KeyCheck['kind'], string>> = { ok: '✓ ', warn: '▲ ', bad: '✕ ' };

/**
 * LiteLLM's proxy URL: required, and checked from the board — which proves nothing about the runners' reach. `hidden`:
 * the saved one is a secret, so it must be entered again for the check.
 */
export function ProxyField({
    ids,
    value,
    hidden,
    onChange,
}: {
    ids: string;
    value: string;
    hidden: boolean;
    onChange: (v: string) => void;
}) {
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-proxy`}>Proxy URL</label>
            <input
                id={`${ids}-proxy`}
                className="field"
                type="url"
                value={value}
                placeholder="https://litellm.example.internal"
                aria-describedby={`${ids}-proxy-help`}
                onChange={(event) => onChange(event.target.value)}
            />
            <p className="picker-help" id={`${ids}-proxy-help`}>
                Checked from the Bellows server, which reads models from its <span className="mono">/v1/models</span>.
                Runners must reach it too — a green check here does not prove they can.
                {hidden ? ' The saved proxy URL is stored as a secret: enter it again to check the key.' : null}
            </p>
        </div>
    );
}

/** The check's one live line: pending, ✓, ▲, ✕, or that the check could not run. Always mounted, so it announces. */
function CheckLine({ ids, check }: { ids: string; check: KeyCheck & { retry: () => void } }) {
    return (
        <>
            <p
                className="model-check"
                id={`${ids}-check`}
                role="status"
                aria-live="polite"
                aria-label="Key check"
                data-state={check.kind}
            >
                {check.text ? `${MARK[check.kind] ?? ''}${check.text}` : null}
            </p>
            {check.kind === 'error' ? (
                <button type="button" className="tertiary" onClick={check.retry}>
                    Check again
                </button>
            ) : null}
        </>
    );
}

/** The key: masked with a Show toggle, where to get one, and the live check under it. */
export function KeyField({
    ids,
    meta,
    value,
    onChange,
    check,
}: {
    ids: string;
    /** The provider's copy: the field's label, its placeholder and where to get a key. */
    meta: ProviderMeta;
    value: string;
    onChange: (key: string) => void;
    check: KeyCheck & { retry: () => void };
}) {
    const [shown, setShown] = useState(false);
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-key`}>{meta.keyLabel}</label>
            <div className="model-key">
                <input
                    id={`${ids}-key`}
                    className="field"
                    type={shown ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    placeholder={meta.placeholder}
                    aria-invalid={check.kind === 'bad' || undefined}
                    aria-describedby={`${ids}-key-help ${ids}-check`}
                    onChange={(event) => onChange(event.target.value)}
                />
                <button type="button" className="tertiary" onClick={() => setShown(!shown)}>
                    {shown ? 'Hide' : 'Show'}
                </button>
            </div>
            <p className="picker-help" id={`${ids}-key-help`}>
                Get one at{' '}
                {meta.keyLink.href ? (
                    <a href={meta.keyLink.href} target="_blank" rel="noreferrer">
                        {meta.keyLink.text}
                    </a>
                ) : (
                    meta.keyLink.text
                )}
                . Paste any key — the provider is detected from its prefix.
            </p>
            <CheckLine ids={ids} check={check} />
        </div>
    );
}

/** The optional base URL, for a gateway the member runs; LiteLLM and a subscription have none here. */
export function AdvancedBase({
    ids,
    name,
    value,
    hidden,
    onChange,
}: {
    ids: string;
    /** The env name the base URL is saved beside, for the help's sentence. */
    name: string;
    value: string;
    /** A base URL is saved as a secret: it stays unless the member enters another. */
    hidden: boolean;
    onChange: (v: string) => void;
}) {
    return (
        <details className="model-advanced">
            <summary>Advanced</summary>
            <div className="picker-field">
                <label htmlFor={`${ids}-base`}>Base URL (optional)</label>
                <input
                    id={`${ids}-base`}
                    className="field"
                    type="url"
                    value={value}
                    placeholder={hidden ? 'Saved (hidden)' : undefined}
                    aria-describedby={`${ids}-base-help`}
                    onChange={(event) => onChange(event.target.value)}
                />
                <p className="picker-help" id={`${ids}-base-help`}>
                    Only for a gateway you run. Saved as <span className="mono">{name}</span> beside your key.
                    {hidden ? ' One is saved as a secret and stays unless you enter another.' : null}
                </p>
            </div>
        </details>
    );
}

/** Where the key goes: the env names a save writes, in which scope, and that nobody reads it back. */
export function SecretNote({
    provider,
    scope,
    withBase,
}: {
    provider: ModelProvider;
    scope: SetupScope;
    withBase: boolean;
}) {
    const names = secretNames(provider, withBase);
    return (
        <p className="model-secret-note">
            {scope === 'org' ? 'Saved as an organization secret ' : 'Saved as your personal secret '}
            {names.map((name, index) => (
                <span key={name}>
                    {index > 0 ? ' + ' : null}
                    <span className="mono">{name}</span>
                </span>
            ))}{' '}
            (Settings → Environment). Nobody — admins included — can read it back; you can only replace it.
            {scope === 'personal' ? ' A personal key wins over the organization’s.' : null}
        </p>
    );
}
