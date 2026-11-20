import { useEffect, useRef, useState } from 'react';
import type { AccessTokenView, MintResult } from '../api/useAccessTokens.js';
import { useAccessTokens } from '../api/useAccessTokens.js';
import { AccessTokenDialog } from './AccessTokenDialog.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { taskTime } from '../format.js';
import { StateNote } from '../components/StateNote.js';

/** One token row: its label and timestamps, and Revoke — or the fact that it already is one.
 * Split out of `AccessTokensPanel` so its own conditional cell does not add to the panel's
 * cognitive complexity. */
function AccessTokenRow({ token, flash, onRevoke }: { token: AccessTokenView; flash: boolean; onRevoke: () => void }) {
    return (
        <tr className={flash ? 'token-flash' : undefined}>
            <td>{token.label}</td>
            <td>{taskTime(token.createdAt)}</td>
            <td>{taskTime(token.lastUsedAt)}</td>
            <td>
                {token.revokedAt !== null ? (
                    <span className="muted">revoked</span>
                ) : (
                    <button
                        type="button"
                        className="chat-remove"
                        aria-label={`Revoke ${token.label}`}
                        onClick={onRevoke}
                    >
                        Revoke
                    </button>
                )}
            </td>
        </tr>
    );
}

/** The token table, or the dashed empty state with its own New token button. Split out of
 * `AccessTokensPanel` so its conditionals do not add to the panel's cognitive complexity. */
function TokenList({
    tokens,
    loading,
    emptyText,
    flash,
    onNew,
    onRevoke,
}: {
    tokens: readonly AccessTokenView[];
    loading: boolean;
    emptyText: string;
    flash: ReadonlySet<string>;
    onNew: () => void;
    onRevoke: (id: string) => void;
}) {
    if (loading) return <p className="muted">Loading…</p>;
    if (tokens.length === 0) {
        return (
            <div className="token-empty">
                <p className="muted">{emptyText}</p>
                <button type="button" className="primary token-new" onClick={onNew}>
                    New token
                </button>
            </div>
        );
    }
    return (
        <table className="data">
            <thead>
                <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last used</th>
                    <th scope="col">
                        <span className="visually-hidden">Revoke</span>
                    </th>
                </tr>
            </thead>
            <tbody>
                {tokens.map((token) => (
                    <AccessTokenRow
                        key={token.id}
                        token={token}
                        flash={flash.has(token.id)}
                        onRevoke={() => onRevoke(token.id)}
                    />
                ))}
            </tbody>
        </table>
    );
}

export interface AccessTokensPanelProps {
    scope: 'personal' | 'org';
    title: string;
    /** One sentence on what this scope is for; rendered under the heading and in the create dialog. */
    hint: string;
    tokens: AccessTokenView[];
    loading: boolean;
    error: string | null;
    onCreate: (label: string) => Promise<MintResult>;
    onRevoke: (id: string) => Promise<string | null>;
}

/** How long a freshly created row wears its `--ok-wash`. */
const FLASH_MS = 1600;

/**
 * One access-token scope: the list, a New token button, and the create dialog.
 *
 * The list shows labels and last use, never a token — the plaintext exists exactly once, in the
 * mint response, and `AccessTokenDialog` keeps it on screen until Done is pressed. The list stays
 * mounted behind the dialog for the whole flow. No `<form>`: the CSP sends `form-action 'none'`,
 * the same trap that makes LoginGate an anchor.
 */
export function AccessTokensPanel({
    scope,
    title,
    hint,
    tokens,
    loading,
    error,
    onCreate,
    onRevoke,
}: AccessTokensPanelProps) {
    const [creating, setCreating] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, setPending] = useState<AccessTokenView | null>(null);
    const [revoking, setRevoking] = useState(false);
    // The ids on screen when the token was minted: after Done, the rows not in it are the new ones.
    const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
    const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
    const newRef = useRef<HTMLButtonElement>(null);

    const create = async (label: string): Promise<MintResult> => {
        const result = await onCreate(label);
        if (result.ok) setBefore(new Set(tokens.map((t) => t.id)));
        return result;
    };

    // After the dialog closes focus goes to the panel's New token button (the empty state's own
    // button unmounts with the first row), and a created row flashes once.
    const [closed, setClosed] = useState(false);
    useEffect(() => {
        if (!closed) return;
        const timer = setTimeout(() => {
            newRef.current?.focus();
            setClosed(false);
        }, 0);
        return () => clearTimeout(timer);
    }, [closed]);
    useEffect(() => {
        if (flash.size === 0) return;
        const timer = setTimeout(() => setFlash(new Set()), FLASH_MS);
        return () => clearTimeout(timer);
    }, [flash]);
    useEffect(() => {
        // The refetch can land after Done: keep waiting on `before` until a new row shows.
        if (before === null || creating) return;
        const fresh = tokens.filter((t) => !before.has(t.id)).map((t) => t.id);
        if (fresh.length === 0) return;
        setFlash(new Set(fresh));
        setBefore(null);
    }, [before, creating, tokens]);

    const close = () => {
        setCreating(false);
        setClosed(true);
    };

    const revoke = async (id: string): Promise<boolean> => {
        setFailure(null);
        const reason = await onRevoke(id);
        if (reason) setFailure(reason);
        return !reason;
    };

    // A revoked row loses its Revoke button on the refetch, so the dialog's own focus return would
    // land on a removed control: after a confirmed revoke focus moves to the panel heading, which
    // outlives every row. A refused revoke keeps its button, so the library's return stands.
    const headingRef = useRef<HTMLHeadingElement>(null);
    const [focusHeading, setFocusHeading] = useState(false);
    useEffect(() => {
        if (!focusHeading) return;
        const timer = setTimeout(() => {
            headingRef.current?.focus();
            setFocusHeading(false);
        }, 0);
        return () => clearTimeout(timer);
    }, [focusHeading]);

    const confirmRevoke = async () => {
        if (pending === null) return;
        setRevoking(true);
        try {
            if (await revoke(pending.id)) setFocusHeading(true);
        } finally {
            setRevoking(false);
            setPending(null);
        }
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2 ref={headingRef} tabIndex={-1}>
                    {title}
                </h2>
                <button ref={newRef} type="button" className="primary token-new" onClick={() => setCreating(true)}>
                    New token
                </button>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {error ? <StateNote state="error">{error}</StateNote> : null}
            {failure ? <StateNote state="error">{failure}</StateNote> : null}

            <TokenList
                tokens={tokens}
                loading={loading}
                emptyText={scope === 'org' ? 'No organization tokens yet.' : 'No tokens yet.'}
                flash={flash}
                onNew={() => setCreating(true)}
                onRevoke={(id) => setPending(tokens.find((t) => t.id === id) ?? null)}
            />
            <AccessTokenDialog
                open={creating}
                scope={scope}
                purpose={hint}
                onCreate={create}
                onCancel={close}
                onDone={close}
            />
            <ConfirmDialog
                open={pending !== null}
                busy={revoking}
                title={`Revoke ${pending?.label ?? ''}?`}
                confirmClassName="chat-remove"
                confirmText={revoking ? 'Revoking…' : 'Revoke'}
                onClose={() => setPending(null)}
                onConfirm={() => void confirmRevoke()}
            >
                <p>
                    Anything using the token “{pending?.label}” stops working at once. This cannot be undone; a revoked
                    token is replaced by creating a new one.
                </p>
            </ConfirmDialog>
        </section>
    );
}

/**
 * One scope bound to its data. Mounted only where the caller may actually use it — the org scope
 * is admin-only, so a member's settings page never even asks the server for it.
 */
export function AccessTokensSection({ scope }: { scope: 'personal' | 'org' }) {
    const access = useAccessTokens(scope);
    return (
        <AccessTokensPanel
            scope={scope}
            title={scope === 'org' ? 'Organization access tokens' : 'Personal access tokens'}
            hint={
                scope === 'org'
                    ? 'Acts for the organization on read-only routes — for automation that outlives any member. Minted by an admin.'
                    : 'Acts as you on the API routes, in an Authorization: Bearer header. Shown once at creation; revoke any time.'
            }
            tokens={access.tokens ?? []}
            loading={access.loading}
            error={access.error}
            onCreate={access.create}
            onRevoke={access.revoke}
        />
    );
}
