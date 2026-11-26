import { useState } from 'react';
import { listGitlabProjects, saveGitlabTracked, type GitlabProjectView } from '../api/gitlab.js';
import { StateNote } from '../components/StateNote.js';

type Listing =
    | { state: 'idle' | 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; projects: GitlabProjectView[] };

/**
 * The admin's tracking picker for one active connection: the projects under the allowed root groups, listed with the
 * admin's own grant. A listing the board could not confirm is an error with a Retry, never an empty list; a tracked
 * project the listing no longer shows stays in the list, checked and marked, so a save never drops a row unseen.
 */
export function GitlabTracking({ connectionId }: { connectionId: string }) {
    const [listing, setListing] = useState<Listing>({ state: 'idle' });
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setListing({ state: 'loading' });
        setSaved(false);
        setError(null);
        const read = await listGitlabProjects(connectionId);
        if (!read.ok) {
            setListing({ state: 'error', error: read.error });
            return;
        }
        setPicked(new Set(read.projects.filter((project) => project.tracked).map((project) => project.path)));
        setListing({ state: 'ok', projects: read.projects });
    };

    const toggle = (path: string) => {
        setSaved(false);
        setPicked((current) => {
            const next = new Set(current);
            if (!next.delete(path)) next.add(path);
            return next;
        });
    };

    const save = async () => {
        setError(null);
        setSaved(false);
        setSaving(true);
        const result = await saveGitlabTracked(connectionId, [...picked].sort());
        setSaving(false);
        if (result.ok) setSaved(true);
        else setError(result.error);
    };

    return (
        <div>
            <h3>Tracked projects</h3>
            {listing.state === 'idle' ? (
                <button type="button" onClick={() => void load()}>
                    Load projects
                </button>
            ) : null}
            {listing.state === 'loading' ? <StateNote state="loading">Loading projects…</StateNote> : null}
            {listing.state === 'error' ? (
                <>
                    <StateNote state="error">{listing.error}</StateNote>
                    <button type="button" onClick={() => void load()}>
                        Retry
                    </button>
                </>
            ) : null}
            {listing.state === 'ok' ? (
                <>
                    {listing.projects.length === 0 ? (
                        <StateNote state="empty">The allowed groups hold no projects your account can see.</StateNote>
                    ) : (
                        <ul className="integration-list" aria-label="Projects">
                            {listing.projects.map((project) => (
                                <li key={project.path}>
                                    <label className="settings-toggle">
                                        <input
                                            type="checkbox"
                                            checked={picked.has(project.path)}
                                            disabled={saving}
                                            onChange={() => toggle(project.path)}
                                        />
                                        {project.path}
                                    </label>
                                    {project.listed ? null : (
                                        <span className="muted"> Tracked, but no longer listed for your account.</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {error ? (
                        <p className="status error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    {saved ? <p className="status">Saved.</p> : null}
                    <div className="picker-actions">
                        <button type="button" onClick={() => void load()} disabled={saving}>
                            Reload
                        </button>
                        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
                            {saving ? 'Saving…' : 'Save tracked projects'}
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    );
}
