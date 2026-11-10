import { ERROR_CODES, MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES } from '@factory-ai/core';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
    createSkill,
    editSkillMd,
    getSkill,
    uploadVersion,
    type SkillDoor,
    type SkillRefusal,
    type StoredSkill,
} from '../api/skills.js';
import { Icon } from '../components/Icon.js';
import { UNSAVED_CHANGES_LABEL } from '../components/SettingsSaveActions.js';
import { StateNote } from '../components/StateNote.js';
import { useGuardedDraft, useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import type { SkillEditorTarget } from './SkillsSection.js';

/**
 * The inline skill editor (BEL-272): write SKILL.md, upload a .zip, edit a stored skill's SKILL.md, or
 * upload a new version. One card at a time, so one guarded draft id. A refusal is shown inline with the
 * server's own words and the draft is kept; the zip is posted whole, and SKILL.md names the skill.
 */

export const SKILL_DRAFT_ID = 'skill-editor';
export const STALE_NOTE = 'This skill changed since you opened it. Reload to see the latest version.';

const KIB = 2 ** 10;
const MIB = KIB ** 2;
const LIMITS_LINE = `SKILL.md at the root · up to ${MAX_SKILL_FILES} files · ${MAX_SKILL_BYTES / MIB} MiB total, ${MAX_SKILL_FILE_BYTES / MIB} MiB per file`;

/** The target's identity: a different key is a different editor, whose draft the page must ask about. */
export const editorKey = (target: SkillEditorTarget): string =>
    `${target.door}:${target.mode === 'zip' ? 'new' : target.mode}:${'skill' in target ? target.skill.id : ''}`;

const template = (name: string): string =>
    `---\nname: ${name || 'skill-name'}\ndescription: One line the agent reads to decide when to use this skill.\n---\n\n# ${name || 'Skill name'}\n\nSteps the agent follows.\n`;

/** A refusal as one sentence: the route's own error with its reason, a clash and a stale base in plain words. */
const refusalText = (refusal: SkillRefusal, name: string): string => {
    if (refusal.code === ERROR_CODES.NAME_TAKEN) return `“${name}” is already taken. Pick another name.`;
    if (refusal.code === ERROR_CODES.SKILL_VERSION_STALE) return STALE_NOTE;
    return refusal.reason ? `${refusal.error} (${refusal.reason})` : refusal.error;
};

function EditorFrame({
    title,
    tabs,
    busy,
    onClose,
    children,
}: {
    title: string;
    tabs?: ReactNode;
    /** A submit is in flight: nothing may close the card under it. */
    busy: boolean;
    onClose: () => void;
    children: ReactNode;
}) {
    return (
        <section className="skill-editor" aria-label={title}>
            <div className="skill-editor-head">
                <strong>{title}</strong>
                <div className="skill-editor-head-actions">
                    {tabs}
                    <button type="button" aria-label="Close editor" disabled={busy} onClick={onClose}>
                        ✕
                    </button>
                </div>
            </div>
            {children}
        </section>
    );
}

type Upload = { file: string; state: 'busy' | 'ok' | 'bad'; text: string };

/** The drop area and file picker: a file is posted the moment it is chosen, and each answer is listed. */
function ZipPanel({
    door,
    skill,
    onChanged,
    onBusy,
}: {
    door: SkillDoor;
    skill?: StoredSkill;
    onChanged: (doors: readonly SkillDoor[]) => void;
    onBusy: (busy: boolean) => void;
}) {
    const [uploads, setUploads] = useState<Upload[]>([]);
    const [over, setOver] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const busy = uploads.some((u) => u.state === 'busy');
    useEffect(() => onBusy(busy), [busy, onBusy]);

    const send = async (file: File) => {
        const mark = (next: Upload) => setUploads((all) => [...all.filter((u) => u.file !== file.name), next]);
        mark({ file: file.name, state: 'busy', text: '' });
        const result = await (skill ? uploadVersion(door, skill.id, file) : createSkill(door, { zip: file }));
        if (!result.ok) return mark({ file: file.name, state: 'bad', text: refusalText(result, file.name) });
        mark({
            file: file.name,
            state: 'ok',
            text: skill ? `Added a new version of “${result.skill.name}”` : `Added “${result.skill.name}”`,
        });
        onChanged([door]);
    };

    const choose = (file: File | undefined) => {
        if (file && !busy) void send(file);
    };
    const onDrop = (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        choose(event.dataTransfer.files[0]);
    };

    return (
        <div className="skill-editor-body">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard path */}
            <div
                className={over ? 'skill-drop skill-drop-over' : 'skill-drop'}
                onDragOver={(event) => {
                    event.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
            >
                <strong>Drop a .zip here</strong> or{' '}
                <button type="button" disabled={busy} onClick={() => input.current?.click()}>
                    Choose a file
                </button>
                <input
                    ref={input}
                    type="file"
                    hidden
                    disabled={busy}
                    accept=".zip,application/zip"
                    aria-label="Choose a .zip file"
                    onChange={(event) => {
                        choose(event.target.files?.[0]);
                        event.target.value = '';
                    }}
                />
                <p className="muted">{LIMITS_LINE}</p>
            </div>
            {uploads.map((u) => (
                <div key={u.file} className="skill-upload">
                    <span className="mono">{u.file}</span>
                    {u.state === 'busy' ? <span className="muted">Uploading…</span> : null}
                    {u.state === 'ok' ? <span role="status">{u.text}</span> : null}
                    {u.state === 'bad' ? <StateNote state="error">{u.text}</StateNote> : null}
                </div>
            ))}
        </div>
    );
}

function RefusalNote({ refusal, name, onReload }: { refusal: SkillRefusal; name: string; onReload: () => void }) {
    return (
        <div className="skill-editor-refusal">
            <StateNote state="error">{refusalText(refusal, name)}</StateNote>
            {refusal.code === ERROR_CODES.SKILL_VERSION_STALE ? (
                <button type="button" onClick={onReload}>
                    Reload
                </button>
            ) : null}
        </div>
    );
}

function SaveBar({
    dirty,
    busy,
    canSave,
    saveLabel,
    onLeave,
    onSave,
}: {
    dirty: boolean;
    busy: boolean;
    canSave: boolean;
    saveLabel: string;
    onLeave: () => void;
    onSave: () => void;
}) {
    return (
        <div className="skill-savebar">
            {dirty ? <span className="settings-dirty">{UNSAVED_CHANGES_LABEL}</span> : null}
            <button type="button" disabled={busy} onClick={onLeave}>
                {dirty ? 'Discard' : 'Cancel'}
            </button>
            <button type="button" className="primary" disabled={busy || !canSave} onClick={onSave}>
                {saveLabel}
            </button>
        </div>
    );
}

/** The Write SKILL.md form for a new skill (`base` null) or a new version of a stored one. */
function WritePanel({
    door,
    skill,
    initialMd,
    onClose,
    onChanged,
    onReload,
    onBusy,
}: {
    door: SkillDoor;
    skill: StoredSkill | null;
    initialMd: string;
    onClose: () => void;
    onChanged: (doors: readonly SkillDoor[]) => void;
    onReload: () => void;
    onBusy: (busy: boolean) => void;
}) {
    const [name, setName] = useState(skill?.name ?? '');
    const [md, setMd] = useState(initialMd);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<SkillRefusal | null>(null);
    useEffect(() => onBusy(busy), [busy, onBusy]);
    const dirty = name !== (skill?.name ?? '') || md !== initialMd;
    const nameId = useId();
    const mdId = useId();

    const discard = useMemo(
        () => () => {
            setName(skill?.name ?? '');
            setMd(initialMd);
            setRefusal(null);
        },
        [skill, initialMd]
    );
    useGuardedDraft(
        useMemo(
            () => ({
                id: SKILL_DRAFT_ID,
                label: skill ? `“${skill.name}”` : 'the new skill',
                dirty,
                discard,
            }),
            [skill, dirty, discard]
        )
    );

    const onName = (next: string) => {
        setName(next);
        if (!skill) setMd((current) => current.replace(/^name:.*$/m, `name: ${next || 'skill-name'}`));
        setRefusal(null);
    };

    const save = async () => {
        setBusy(true);
        setRefusal(null);
        const result = skill
            ? await editSkillMd(door, skill.id, md, skill.current.id)
            : await createSkill(door, { name, skillMd: md });
        setBusy(false);
        if (result.ok) {
            onChanged([door]);
            onClose();
            return;
        }
        if (result.code === ERROR_CODES.SKILL_NOT_FOUND) onChanged([door]);
        setRefusal(result);
    };

    return (
        <>
            <div className="skill-editor-body">
                <label className="skill-field" htmlFor={nameId}>
                    Name
                </label>
                <p className="muted" id={`${nameId}-hint`}>
                    Lowercase letters, digits and dashes. Must match <span className="mono">name:</span> in SKILL.md.
                    “factory-” is reserved.
                </p>
                <input
                    id={nameId}
                    className="mono"
                    value={name}
                    readOnly={skill !== null}
                    disabled={busy}
                    placeholder="skill-name"
                    aria-describedby={`${nameId}-hint`}
                    onChange={(event) => onName(event.target.value)}
                />
                <label className="skill-field" htmlFor={mdId}>
                    SKILL.md
                </label>
                <textarea
                    id={mdId}
                    className="mono"
                    value={md}
                    spellCheck={false}
                    disabled={busy}
                    onChange={(event) => {
                        setMd(event.target.value);
                        setRefusal(null);
                    }}
                />
                {refusal ? <RefusalNote refusal={refusal} name={name} onReload={onReload} /> : null}
                {skill ? (
                    <p className="muted">
                        Saving replaces SKILL.md and keeps the other files in this version. To change them, upload a
                        .zip.
                    </p>
                ) : null}
            </div>
            {skill && !dirty && !refusal ? null : (
                <SaveBar
                    dirty={dirty}
                    busy={busy}
                    canSave={dirty && (skill !== null || name !== '')}
                    saveLabel={skill ? 'Save new version' : 'Create skill'}
                    onLeave={dirty ? discardAndClose(discard, onClose) : onClose}
                    onSave={() => void save()}
                />
            )}
        </>
    );
}

const discardAndClose = (discard: () => void, onClose: () => void) => () => {
    discard();
    onClose();
};

/** A stored skill's editor: read the current SKILL.md, then edit against that version. */
function EditPanel({
    door,
    skill,
    onClose,
    onChanged,
    onBusy,
}: {
    door: SkillDoor;
    skill: StoredSkill;
    onClose: () => void;
    onChanged: (doors: readonly SkillDoor[]) => void;
    onBusy: (busy: boolean) => void;
}) {
    type Loaded =
        | { status: 'loading' }
        | { status: 'error'; error: string }
        | { status: 'ok'; skill: StoredSkill; skillMd: string };
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
    const [round, setRound] = useState(0);

    useEffect(() => {
        let alive = true;
        void getSkill(door, skill.id).then((result) => {
            if (!alive) return;
            setLoaded(
                result.ok
                    ? { status: 'ok', skill: result.skill, skillMd: result.skillMd }
                    : { status: 'error', error: result.error }
            );
        });
        return () => {
            alive = false;
        };
    }, [door, skill.id, round]);

    if (loaded.status === 'loading') return <StateNote state="loading">Loading SKILL.md…</StateNote>;
    if (loaded.status === 'error') return <StateNote state="error">{loaded.error}</StateNote>;
    return (
        <WritePanel
            key={loaded.skill.current.id}
            door={door}
            skill={loaded.skill}
            initialMd={loaded.skillMd}
            onClose={onClose}
            onChanged={onChanged}
            onBusy={onBusy}
            onReload={() => {
                setLoaded({ status: 'loading' });
                setRound((n) => n + 1);
                onChanged([door]);
            }}
        />
    );
}

export function SkillEditor({
    target,
    onClose,
    onChanged,
    onBusyChange,
}: {
    target: SkillEditorTarget;
    onClose: () => void;
    onChanged: (doors: readonly SkillDoor[]) => void;
    /** Told whenever a submit starts or settles (and false on unmount), so the page can lock the other entry points. */
    onBusyChange: (busy: boolean) => void;
}) {
    const { door } = target;
    const [tab, setTab] = useState<'write' | 'zip'>(target.mode === 'zip' ? 'zip' : 'write');
    const [busy, setBusy] = useState(false);
    const guard = useUnsavedChanges();
    const notify = useRef(onBusyChange);
    notify.current = onBusyChange;
    useEffect(() => notify.current(busy), [busy]);
    useEffect(() => () => notify.current(false), []);

    /** The ✕: a dirty draft asks first, exactly as navigating away does. */
    const requestClose = async () => {
        const draft = guard?.dirtyDraft(SKILL_DRAFT_ID);
        if (draft && guard && !(await guard.confirmDiscard(draft))) return;
        onClose();
    };

    if (target.mode === 'edit') {
        return (
            <EditorFrame title={`Edit ${target.skill.name}`} busy={busy} onClose={() => void requestClose()}>
                <EditPanel door={door} skill={target.skill} onClose={onClose} onChanged={onChanged} onBusy={setBusy} />
            </EditorFrame>
        );
    }
    if (target.mode === 'version') {
        return (
            <EditorFrame title={`New version of ${target.skill.name}`} busy={busy} onClose={onClose}>
                <ZipPanel door={door} skill={target.skill} onChanged={onChanged} onBusy={setBusy} />
            </EditorFrame>
        );
    }
    const tabs = (
        <div className="tabs" role="tablist">
            {(['write', 'zip'] as const).map((value) => (
                <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    disabled={busy}
                    onClick={() => setTab(value)}
                >
                    {value === 'write' ? (
                        'Write SKILL.md'
                    ) : (
                        <>
                            <Icon name="arrow-up" />
                            Upload .zip
                        </>
                    )}
                </button>
            ))}
        </div>
    );
    return (
        <EditorFrame
            title={door === 'org' ? 'New organization skill' : 'New skill'}
            tabs={tabs}
            busy={busy}
            onClose={() => void requestClose()}
        >
            {/* Hidden, not unmounted: a half-written draft survives a look at the zip tab. */}
            <div hidden={tab !== 'write'}>
                <WritePanel
                    door={door}
                    skill={null}
                    initialMd={template('')}
                    onClose={onClose}
                    onChanged={onChanged}
                    onReload={onClose}
                    onBusy={setBusy}
                />
            </div>
            {tab === 'zip' ? <ZipPanel door={door} onChanged={onChanged} onBusy={setBusy} /> : null}
        </EditorFrame>
    );
}
