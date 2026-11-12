import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listConnections } from '../api/connections.js';
import { getBuiltin, listCatalog, setBuiltinEnabled, type BuiltinSkill, type CatalogSkill } from '../api/skills.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { builtinHiddenNote, needsOf, type ConnectionsState } from '../settings/skill-rows.js';
import { SkillViewFrame } from './SkillView.js';
import { ScrollRegion } from '../components/ScrollRegion.js';

/**
 * The Built-in section of the Skills page (BEL-272): the skills that ship with Bellows, read-only, with
 * one org-wide switch an admin can flip. It reads the catalog (`GET /api/skills`) and the caller's
 * connections itself. A failed catalog read is an alert, never an empty table, and a failed connections
 * read is `'unknown'`: no row then claims a connection is missing.
 */

const COLUMNS = 5;
export const CONNECTIONS_UNREAD_NOTE =
    'The connection status could not be read, so which skills a missing connection hides is not shown.';

type Catalog = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; skills: CatalogSkill[] };

/** Both reads of the section; `reload` re-reads the catalog after a switch. */
function useBuiltinData() {
    const [catalog, setCatalog] = useState<Catalog>({ status: 'loading' });
    /** `null` until the read lands, so the unread note never flashes while loading. */
    const [connections, setConnections] = useState<ConnectionsState | null>(null);
    const alive = useRef(true);

    const reload = useCallback(async () => {
        const result = await listCatalog();
        if (!alive.current) return;
        setCatalog(
            result.ok
                ? { status: 'ok', skills: result.skills.filter((skill) => skill.source === 'builtin') }
                : { status: 'error', error: result.error }
        );
    }, []);

    useEffect(() => {
        alive.current = true;
        void reload();
        void listConnections().then((result) => {
            if (alive.current) setConnections(result.ok ? result.connections : 'unknown');
        });
        return () => {
            alive.current = false;
        };
    }, [reload]);

    return { catalog, connections, reload };
}

const ledeOf = (isAdmin: boolean): string =>
    `Loaded into every task unless switched off here or a connection they need is missing. They update with each Bellows release. Names starting with factory- are reserved for them. ${
        isAdmin
            ? 'As an admin you can switch one off for the whole organization.'
            : 'Your admins can switch one off for the organization.'
    }`;

/** The Needs cell: tools as plain pills, each connection as ok or "not connected" (never claimed when unread). */
function Needs({ skill, connections }: { skill: CatalogSkill; connections: ConnectionsState }) {
    const labels = needsOf(skill.requires);
    const missing = connections === 'unknown' ? null : builtinHiddenNote(skill, connections);
    if (skill.requires.tools.length === 0 && labels.length === 0) return <span className="muted">—</span>;
    return (
        <span className="pill-list">
            {skill.requires.tools.map((tool) => (
                <span key={tool} className="pill mono" title="Ships in both runner images">
                    {tool}
                </span>
            ))}
            {labels.map((label) => {
                const absent = missing === `Needs ${label}`;
                return (
                    <span
                        key={label}
                        className={absent ? 'pill pill-warn' : 'pill'}
                        title={absent ? `Not loaded into tasks until ${label} is connected` : undefined}
                    >
                        {absent ? `${label} not connected` : label}
                    </span>
                );
            })}
        </span>
    );
}

function BuiltinView({ name, onClose }: { name: string; onClose: () => void }) {
    const [loaded, setLoaded] = useState<
        { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; builtin: BuiltinSkill }
    >({ status: 'loading' });

    useEffect(() => {
        let alive = true;
        void getBuiltin(name).then((result) => {
            if (alive)
                setLoaded(
                    result.ok ? { status: 'ok', builtin: result.builtin } : { status: 'error', error: result.error }
                );
        });
        return () => {
            alive = false;
        };
    }, [name]);

    if (loaded.status === 'loading') return <StateNote state="loading">Loading skill…</StateNote>;
    if (loaded.status === 'error') {
        return (
            <>
                <StateNote state="error">{loaded.error}</StateNote>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </>
        );
    }
    const { builtin } = loaded;
    const needs = needsOf(builtin.requires);
    return (
        <SkillViewFrame
            name={name}
            meta={
                <>
                    <span>Built-in · ships with Bellows v{builtin.version}</span>
                    <span>Read-only</span>
                    {needs.length > 0 ? <span>Needs {needs.join(', ')}</span> : null}
                </>
            }
            skillMd={builtin.skillMd}
            files={builtin.files}
            onClose={onClose}
        />
    );
}

/** What the section says above its table: the catalog read, an unread connections list, the missing-connection line. */
function SectionNotes({
    catalog,
    connections,
    missing,
}: {
    catalog: Catalog;
    connections: ConnectionsState | null;
    missing: number;
}) {
    return (
        <>
            {connections === 'unknown' && catalog.status === 'ok' ? (
                <StateNote state="error">{CONNECTIONS_UNREAD_NOTE}</StateNote>
            ) : null}
            {missing > 0 ? (
                <p className="skill-note skill-note-warn">
                    {missing} {missing === 1 ? 'skill is' : 'skills are'} hidden from tasks until{' '}
                    {missing === 1 ? 'it gets' : 'they get'} a connection.{' '}
                    <Link to="/settings/integrations">Set up in Integrations →</Link>
                </p>
            ) : null}
            {catalog.status === 'loading' ? <StateNote state="loading">Loading skills…</StateNote> : null}
            {catalog.status === 'error' ? <StateNote state="error">{catalog.error}</StateNote> : null}
        </>
    );
}

export function BuiltinSkillsSection({ isAdmin }: { isAdmin: boolean }) {
    const { catalog, connections, reload } = useBuiltinData();
    const [viewing, setViewing] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<{ name: string; error: string | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [problem, setProblem] = useState<string | null>(null);

    const write = async (name: string, enabled: boolean): Promise<string | null> => {
        setBusy(true);
        setStatus('');
        setProblem(null);
        const result = await setBuiltinEnabled(name, enabled);
        setBusy(false);
        if (!result.ok) return result.error;
        setStatus(enabled ? `Switched “${name}” back on.` : `Switched “${name}” off for the organization.`);
        await reload();
        return null;
    };

    const confirm = async () => {
        if (!confirming) return;
        const error = await write(confirming.name, false);
        setConfirming(error === null ? null : { ...confirming, error });
    };

    const toggle = async (skill: CatalogSkill) => {
        if (skill.switchedOff !== true) return setConfirming({ name: skill.name, error: null });
        setProblem(await write(skill.name, true));
    };

    const skills = catalog.status === 'ok' ? catalog.skills : [];
    const known = connections ?? 'unknown';
    const missing =
        known === 'unknown'
            ? 0
            : skills.filter((skill) => builtinHiddenNote(skill, known)?.startsWith('Needs ')).length;

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>
                    Built-in
                    <span className="count">{skills.length}</span>
                </h2>
                <span className="muted">
                    <Icon name="lock" />
                    Ships with Bellows · read-only
                </span>
            </div>
            <p className="muted">{ledeOf(isAdmin)}</p>
            <SectionNotes catalog={catalog} connections={connections} missing={missing} />
            {catalog.status === 'ok' && skills.length > 0 ? (
                <ScrollRegion className="table-wrap" aria-label="Built-in skills">
                    <table className="data data-compact table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Description</th>
                                <th scope="col">Needs</th>
                                <th scope="col">Enabled</th>
                                <th scope="col">
                                    <span className="muted">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {skills.map((skill) => {
                                const hidden = builtinHiddenNote(skill, known);
                                return (
                                    <FragmentRows
                                        key={skill.name}
                                        open={viewing === skill.name}
                                        view={<BuiltinView name={skill.name} onClose={() => setViewing(null)} />}
                                    >
                                        <td data-label="Name">
                                            <span className="mono" title={skill.name}>
                                                {skill.name}
                                            </span>
                                            {hidden ? <p className="skill-note">Hidden from tasks · {hidden}</p> : null}
                                        </td>
                                        <td data-label="Description">
                                            <span className="skill-description" title={skill.description}>
                                                {skill.description}
                                            </span>
                                        </td>
                                        <td data-label="Needs">
                                            <Needs skill={skill} connections={known} />
                                        </td>
                                        <td data-label="Enabled">
                                            <label className="settings-toggle">
                                                <input
                                                    type="checkbox"
                                                    role="switch"
                                                    className="switch"
                                                    aria-checked={skill.switchedOff !== true}
                                                    checked={skill.switchedOff !== true}
                                                    disabled={!isAdmin || busy}
                                                    aria-label={`Offer ${skill.name}`}
                                                    onChange={() => void toggle(skill)}
                                                />
                                            </label>
                                        </td>
                                        <td data-label="Actions">
                                            <button type="button" onClick={() => setViewing(skill.name)}>
                                                View
                                            </button>
                                        </td>
                                    </FragmentRows>
                                );
                            })}
                        </tbody>
                    </table>
                </ScrollRegion>
            ) : null}
            <p className="muted" role="status">
                {status}
            </p>
            {problem ? <StateNote state="error">{problem}</StateNote> : null}
            {confirming ? (
                <ConfirmDialog
                    open
                    busy={busy}
                    title={`Switch off “${confirming.name}” for the organization?`}
                    confirmClassName="chat-remove"
                    confirmText="Switch off"
                    onClose={() => setConfirming(null)}
                    onConfirm={() => void confirm()}
                >
                    <p className="muted">
                        No task in the organization is offered it from now on. Running tasks keep what they started
                        with.
                    </p>
                    {confirming.error ? <StateNote state="error">{confirming.error}</StateNote> : null}
                </ConfirmDialog>
            ) : null}
        </section>
    );
}

/** A table row and, when open, the full-width row of its view beneath it. */
function FragmentRows({ children, open, view }: { children: ReactNode; open: boolean; view: ReactNode }) {
    return (
        <>
            <tr>{children}</tr>
            {open ? (
                <tr>
                    <td colSpan={COLUMNS}>{view}</td>
                </tr>
            ) : null}
        </>
    );
}
