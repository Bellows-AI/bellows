import { ERROR_CODES } from '@factory-ai/core';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import {
    deleteSkill,
    downloadZip,
    promote,
    setEnabled,
    type SkillDoor,
    type SkillRefusal,
    type StoredSkill,
} from '../api/skills.js';
import { Avatar } from '../components/Avatar.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { RowActions, type RowAction } from '../components/RowActions.js';
import { StateNote } from '../components/StateNote.js';
import { managedHiddenNote, shadowedForMe, versionLabel } from '../settings/skill-rows.js';
import type { SkillList } from '../settings/useSkillLists.js';
import { StoredSkillView } from './SkillView.js';
import { ScrollRegion } from '../components/ScrollRegion.js';

/**
 * One door's stored skills as a panel: My workspace (`workspace`) or Organization (`org`). Rows are the
 * wire rows; the section owns the row actions that need nothing but the board — switch, delete, promote,
 * download, view — and hands the editor's entry points (`onEditor`) to the page, which owns the inline
 * editor and upload card. `renderEditor` is where that card renders: above the table for a new skill or
 * a zip create, directly under the row for an edit or a new version.
 */

export type SkillEditorTarget =
    | { door: SkillDoor; mode: 'new' | 'zip' }
    | { door: SkillDoor; mode: 'edit' | 'version'; skill: StoredSkill };

export const NEW_SKILL_LABEL = 'New skill';
export const UPLOAD_ZIP_LABEL = 'Upload .zip';
export const NO_SKILLS = 'No skills yet.';
export const NAME_TAKEN_NOTE = 'An organization skill already has this name. Rename yours first.';

const TITLES: Record<SkillDoor, string> = { workspace: 'My workspace', org: 'Organization' };
const COLUMNS = 5;

const ledeOf = (door: SkillDoor, canWrite: boolean): string => {
    if (door === 'workspace') {
        return 'Your own skills, offered to your tasks only. They always win over an organization or repository skill of the same name.';
    }
    return canWrite
        ? 'As an admin you manage these skills for everyone in the organization.'
        : 'These are managed by your organization admins and offered to every member’s tasks.';
};

const deleteNote = (door: SkillDoor): string =>
    door === 'org'
        ? 'Every member loses this skill on new tasks. Running tasks keep the version they pinned.'
        : 'New tasks stop offering it. Running tasks keep the version they pinned.';

const PROMOTE_NOTE =
    'It moves out of your workspace and every member’s tasks can use it. Only admins can edit it afterwards.';

type Pending = { kind: 'delete' | 'promote'; skill: StoredSkill; error: string | null };

/** The writes a row can make, with the shared busy flag, status line and refusal handling. */
function useSkillWrites(door: SkillDoor, onChanged: (doors: readonly SkillDoor[]) => void) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);

    /** A refusal as a sentence; a skill that vanished says so and the list is read again. */
    const refusalNote = (refusal: SkillRefusal, skill: StoredSkill): string => {
        if (refusal.code !== ERROR_CODES.SKILL_NOT_FOUND) return refusal.error;
        onChanged([door]);
        return `“${skill.name}” no longer exists.`;
    };

    /** Runs one write; resolves to its refusal sentence, or null when it landed. */
    const write = async (
        skill: StoredSkill,
        run: () => Promise<{ ok: true } | SkillRefusal>,
        done: string,
        doors: readonly SkillDoor[] = [door]
    ): Promise<string | null> => {
        setBusy(true);
        setStatus('');
        setProblem(null);
        const result = await run();
        setBusy(false);
        if (!result.ok) return refusalNote(result, skill);
        setStatus(done);
        onChanged(doors);
        return null;
    };

    const toggle = async (skill: StoredSkill) => {
        const next = !skill.enabled;
        const done = `${next ? 'Enabled' : 'Disabled'} “${skill.name}”.`;
        setProblem(await write(skill, () => setEnabled(door, skill.id, next), done));
    };

    const download = async (skill: StoredSkill) =>
        setProblem(
            await write(skill, () => downloadZip(door, skill.id, skill.name), `Downloaded ${skill.name}.zip.`, [])
        );

    const confirm = async () => {
        if (!pending) return;
        const { skill } = pending;
        const note =
            pending.kind === 'delete'
                ? await write(skill, () => deleteSkill(door, skill.id), `Deleted “${skill.name}”.`)
                : await write(skill, () => promote(skill.id), `Promoted “${skill.name}” to the organization.`, [
                      'workspace',
                      'org',
                  ]);
        setPending(note === null ? null : { ...pending, error: note });
    };

    return { busy, status, problem, pending, setPending, toggle, download, confirm };
}

function SkillRow({
    skill,
    canWrite,
    busy,
    shadowed,
    actions,
    onToggle,
    onPrimary,
}: {
    skill: StoredSkill;
    canWrite: boolean;
    busy: boolean;
    shadowed: boolean;
    actions: readonly RowAction[];
    onToggle: () => void;
    onPrimary: () => void;
}) {
    const hidden = managedHiddenNote(skill);
    return (
        <tr>
            <td data-label="Name">
                <span className="member-identity">
                    <Avatar author={{ login: skill.name, avatarUrl: null }} size={28} />
                    <span className="member-login mono" title={skill.name}>
                        {skill.name}
                    </span>
                    {shadowed ? (
                        <span className="pill-list">
                            <span className="pill pill-warn" title="Only for you: other members still get this one">
                                Shadowed for you
                            </span>
                        </span>
                    ) : null}
                </span>
                {shadowed ? (
                    <p className="skill-note skill-note-warn">Not used in your tasks: your own “{skill.name}” wins.</p>
                ) : null}
                {hidden ? <p className="skill-note">Hidden from tasks · {hidden}</p> : null}
            </td>
            <td data-label="Description">
                <span className="skill-description" title={skill.current.description}>
                    {skill.current.description}
                </span>
            </td>
            <td data-label="Version" className="muted">
                {versionLabel(skill.current)}
            </td>
            <td data-label="Enabled">
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        role="switch"
                        aria-checked={skill.enabled}
                        className="switch"
                        checked={skill.enabled}
                        disabled={!canWrite || busy}
                        aria-label={`Enable ${skill.name}`}
                        onChange={onToggle}
                    />
                </label>
            </td>
            <td data-label="Actions">
                <RowActions
                    rowName={skill.name}
                    primary={{ label: canWrite ? 'Edit' : 'View', onSelect: onPrimary }}
                    actions={actions}
                    disabled={busy}
                />
            </td>
        </tr>
    );
}

/** A full-width row under a skill's own: its view or its inline editor. */
const UnderRow = ({ children }: { children: ReactNode }) => (
    <tr>
        <td colSpan={COLUMNS}>{children}</td>
    </tr>
);

function SkillConfirm({
    door,
    pending,
    busy,
    organizationNames,
    onClose,
    onConfirm,
}: {
    door: SkillDoor;
    pending: Pending;
    busy: boolean;
    organizationNames: readonly string[];
    onClose: () => void;
    onConfirm: () => void;
}) {
    const { kind, skill, error } = pending;
    const isDelete = kind === 'delete';
    return (
        <ConfirmDialog
            open
            busy={busy}
            title={isDelete ? `Delete “${skill.name}”?` : `Promote “${skill.name}” to the organization?`}
            confirmClassName={isDelete ? 'chat-remove' : 'primary'}
            confirmText={isDelete ? 'Delete skill' : 'Promote'}
            confirmDisabled={!isDelete && organizationNames.includes(skill.name)}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <p className="muted">{isDelete ? deleteNote(door) : PROMOTE_NOTE}</p>
            {error ? <StateNote state="error">{error}</StateNote> : null}
        </ConfirmDialog>
    );
}

/** The head actions of a writer: a zip create and a new skill, both opening the page's editor. */
function HeadActions({
    door,
    busy,
    onEditor,
}: {
    door: SkillDoor;
    busy: boolean;
    onEditor: (t: SkillEditorTarget) => void;
}) {
    return (
        <div className="skill-head-actions">
            <button type="button" className="skill-add" disabled={busy} onClick={() => onEditor({ door, mode: 'zip' })}>
                <Icon name="arrow-up" />
                {UPLOAD_ZIP_LABEL}
            </button>
            <button type="button" className="skill-add" disabled={busy} onClick={() => onEditor({ door, mode: 'new' })}>
                <Icon name="plus" />
                {NEW_SKILL_LABEL}
            </button>
        </div>
    );
}

function ListNote({ list, hasRows }: { list: SkillList; hasRows: boolean }) {
    if (list.status === 'loading') return <StateNote state="loading">Loading skills…</StateNote>;
    if (list.status === 'error') return <StateNote state="error">{list.error}</StateNote>;
    return !hasRows ? <StateNote state="empty">{NO_SKILLS}</StateNote> : null;
}

/**
 * The rows a section shows. An open row editor holds a draft, so its row stays rendered where it is
 * whatever a re-read says: the last good rows stand in for a failed read, and an edited skill the list
 * dropped is kept.
 */
function useShownRows(list: SkillList, here: SkillEditorTarget | null): readonly StoredSkill[] {
    const lastRows = useRef<readonly StoredSkill[]>([]);
    if (list.status === 'ok') lastRows.current = list.skills;
    const editing = here && 'skill' in here ? here.skill : null;
    const shown = list.status === 'ok' ? list.skills : editing ? lastRows.current : [];
    return editing && !shown.some((s) => s.id === editing.id) ? [...shown, editing] : shown;
}

export function SkillsSection({
    door,
    list,
    canWrite,
    canPromote,
    organizationNames,
    workspaceRows,
    editor,
    onEditor,
    renderEditor,
    locked,
    onChanged,
}: {
    door: SkillDoor;
    list: SkillList;
    /** The workspace door always writes; the org door only for an admin. An unknown session is a member. */
    canWrite: boolean;
    /** A workspace row can be promoted by an admin. */
    canPromote: boolean;
    /** The names the organization already holds, to refuse a promote before it is asked. */
    organizationNames: readonly string[];
    /** The viewer's workspace skills: an org row sharing the name of an enabled one is shadowed for them. */
    workspaceRows: readonly StoredSkill[];
    editor: SkillEditorTarget | null;
    onEditor: (target: SkillEditorTarget | null) => void;
    renderEditor?: (target: SkillEditorTarget) => ReactNode;
    /** An editor's save is in flight: no other editor may be opened and no row changes under it. */
    locked: boolean;
    /** Re-reads these doors' lists after a write. */
    onChanged: (doors: readonly SkillDoor[]) => void;
}) {
    const title = TITLES[door];
    const writes = useSkillWrites(door, onChanged);
    const { pending, setPending } = writes;
    const busy = writes.busy || locked;
    const [viewing, setViewing] = useState<string | null>(null);
    const here = editor?.door === door ? editor : null;

    const rows = useShownRows(list, here);

    const promoteEntry = (skill: StoredSkill): RowAction[] =>
        door === 'workspace' && canPromote
            ? [
                  {
                      label: 'Promote to organization',
                      onSelect: () =>
                          setPending({
                              kind: 'promote',
                              skill,
                              error: organizationNames.includes(skill.name) ? NAME_TAKEN_NOTE : null,
                          }),
                  },
              ]
            : [];

    const overflow = (skill: StoredSkill): RowAction[] => [
        { label: 'View SKILL.md and files', onSelect: () => setViewing(skill.id) },
        { label: 'Upload new version (.zip)', onSelect: () => onEditor({ door, mode: 'version', skill }) },
        ...promoteEntry(skill),
        { label: 'Download .zip', onSelect: () => void writes.download(skill) },
        { label: 'Delete', onSelect: () => setPending({ kind: 'delete', skill, error: null }), danger: true },
    ];

    const row = (skill: StoredSkill) => (
        <Fragment key={skill.id}>
            <SkillRow
                skill={skill}
                canWrite={canWrite}
                busy={busy}
                shadowed={door === 'org' && shadowedForMe(skill, workspaceRows)}
                actions={canWrite ? overflow(skill) : []}
                onToggle={() => void writes.toggle(skill)}
                onPrimary={() => (canWrite ? onEditor({ door, mode: 'edit', skill }) : setViewing(skill.id))}
            />
            {viewing === skill.id ? (
                <UnderRow>
                    <StoredSkillView door={door} id={skill.id} name={skill.name} onClose={() => setViewing(null)} />
                </UnderRow>
            ) : null}
            {here && 'skill' in here && here.skill.id === skill.id ? <UnderRow>{renderEditor?.(here)}</UnderRow> : null}
        </Fragment>
    );

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>
                    {title}
                    <span className="count">{list.status === 'ok' ? list.skills.length : 0}</span>
                </h2>
                {canWrite ? <HeadActions door={door} busy={busy} onEditor={onEditor} /> : null}
            </div>
            <p className="muted">{ledeOf(door, canWrite)}</p>
            {here && !('skill' in here) ? renderEditor?.(here) : null}
            <ListNote list={list} hasRows={rows.length > 0} />
            {rows.length > 0 ? (
                <ScrollRegion className="table-wrap" aria-label={`${title} skills`}>
                    <table className="data data-compact table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Description</th>
                                <th scope="col">Version</th>
                                <th scope="col">Enabled</th>
                                <th scope="col">
                                    <span className="muted">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>{rows.map(row)}</tbody>
                    </table>
                </ScrollRegion>
            ) : null}
            <p className="muted" role="status">
                {writes.status}
            </p>
            {writes.problem ? <StateNote state="error">{writes.problem}</StateNote> : null}
            {pending ? (
                <SkillConfirm
                    door={door}
                    pending={pending}
                    busy={busy}
                    organizationNames={organizationNames}
                    onClose={() => setPending(null)}
                    onConfirm={() => void writes.confirm()}
                />
            ) : null}
        </section>
    );
}
