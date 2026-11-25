import { useId, useState } from 'react';
import { createGitlabConnection, type GitlabConnectionInput } from '../api/gitlab.js';

/** The groups field's separators: a comma, a space or a newline. */
const GROUP_SEPARATOR = /[\s,]+/;

/**
 * Connect a GitLab instance (admin): the host, the OAuth application the admin registered on it, the root groups the
 * org may track and, for a private CA, its bundle. The secret only goes up; nothing here reads one back. No `<form>`:
 * the CSP sends `form-action 'none'`. A refusal keeps what was typed so a correction is one edit.
 */
export function GitlabConnectForm({ redirectUri, onConnected }: { redirectUri: string; onConnected: () => void }) {
    const ids = useId();
    const [host, setHost] = useState('');
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [groups, setGroups] = useState('');
    const [caBundle, setCaBundle] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        const input: GitlabConnectionInput = {
            host: host.trim(),
            clientId: clientId.trim(),
            clientSecret,
            allowedGroups: groups.split(GROUP_SEPARATOR).filter((group) => group !== ''),
            ...(caBundle.trim() === '' ? {} : { caBundle }),
        };
        setError(null);
        setSaving(true);
        const created = await createGitlabConnection(input);
        setSaving(false);
        if (!created.ok) {
            setError(created.error);
            return;
        }
        setClientSecret('');
        setHost('');
        setClientId('');
        setGroups('');
        setCaBundle('');
        onConnected();
    };

    return (
        <section className="panel" aria-labelledby={`${ids}-title`}>
            <h2 id={`${ids}-title`}>Connect a GitLab instance</h2>
            <p className="muted">
                Register an OAuth application on the instance with the scope <code>api</code> and the redirect URI{' '}
                <code>{redirectUri}</code>, then enter it here.
            </p>
            <div className="picker-field">
                <label htmlFor={`${ids}-host`}>GitLab host</label>
                <input
                    id={`${ids}-host`}
                    className="field"
                    type="text"
                    placeholder="gitlab.example.com"
                    value={host}
                    disabled={saving}
                    onChange={(e) => setHost(e.target.value)}
                />
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-client`}>OAuth application ID</label>
                <input
                    id={`${ids}-client`}
                    className="field"
                    type="text"
                    value={clientId}
                    disabled={saving}
                    onChange={(e) => setClientId(e.target.value)}
                />
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-secret`}>OAuth application secret</label>
                <input
                    id={`${ids}-secret`}
                    className="field"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    disabled={saving}
                    onChange={(e) => setClientSecret(e.target.value)}
                />
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-groups`}>Allowed root groups</label>
                <input
                    id={`${ids}-groups`}
                    className="field"
                    type="text"
                    placeholder="acme, platform"
                    value={groups}
                    disabled={saving}
                    aria-describedby={`${ids}-groups-help`}
                    onChange={(e) => setGroups(e.target.value)}
                />
                <p className="picker-help" id={`${ids}-groups-help`}>
                    Only projects under these top-level groups can be tracked. Separate them with commas.
                </p>
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-ca`}>CA bundle (optional)</label>
                <textarea
                    id={`${ids}-ca`}
                    className="field"
                    rows={4}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    value={caBundle}
                    disabled={saving}
                    aria-describedby={`${ids}-ca-help`}
                    onChange={(e) => setCaBundle(e.target.value)}
                />
                <p className="picker-help" id={`${ids}-ca-help`}>
                    PEM certificates, only for an instance behind a private certificate authority.
                </p>
            </div>
            {error ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="picker-actions">
                <button type="button" className="primary" disabled={saving} onClick={() => void submit()}>
                    {saving ? 'Connecting…' : 'Connect GitLab'}
                </button>
            </div>
        </section>
    );
}
