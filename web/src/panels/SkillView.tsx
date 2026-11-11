import { useEffect, useState, type ReactNode } from 'react';
import { getSkill, type SkillDoor, type SkillFile, type StoredSkill } from '../api/skills.js';
import { StateNote } from '../components/StateNote.js';
import { commitDate } from '../format.js';
import { shortSha } from '../settings/skill-rows.js';

/**
 * A skill's read-only view: its SKILL.md, the file list with sizes and one meta line. `SkillViewFrame` is
 * the presentational half — a stored skill and a built-in differ only in the meta line — and
 * `StoredSkillView` loads a stored skill into it. A failed read is an alert, never an empty view.
 */

const KIB = 1024;

export const fileSizeLabel = (bytes: number): string =>
    bytes < KIB ? `${bytes} B` : `${(bytes / KIB).toFixed(1)} KiB`;

export function SkillViewFrame({
    name,
    meta,
    skillMd,
    files,
    onClose,
}: {
    name: string;
    /** The spans of the meta line above the source. */
    meta: ReactNode;
    skillMd: string;
    files: readonly SkillFile[];
    onClose: () => void;
}) {
    return (
        <div className="skill-view">
            <div className="skill-view-head">
                <strong className="mono">{name}</strong>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </div>
            <p className="skill-meta">{meta}</p>
            <div className="skill-view-body">
                <pre className="skill-view-source">{skillMd}</pre>
                <div className="skill-files">
                    <h4>Files</h4>
                    <ul>
                        {files.map((file) => (
                            <li key={file.path}>
                                <span className="mono">{file.path}</span>
                                <span className="muted">{fileSizeLabel(file.size)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

type Loaded =
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'ok'; skill: StoredSkill; skillMd: string; files: SkillFile[] };

/** The meta line of a stored skill: the version, who wrote it and when, and the file count. */
const storedMeta = (skill: StoredSkill, files: readonly SkillFile[]): ReactNode => (
    <>
        <span>Version {shortSha(skill.current)}</span>
        <span>
            Updated {commitDate(skill.current.createdAt)} by {skill.current.author?.login ?? '—'}
        </span>
        <span>{files.length === 1 ? '1 file' : `${files.length} files`}</span>
    </>
);

export function StoredSkillView({
    door,
    id,
    name,
    onClose,
}: {
    door: SkillDoor;
    id: string;
    name: string;
    onClose: () => void;
}) {
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

    useEffect(() => {
        let alive = true;
        void getSkill(door, id).then((result) => {
            if (!alive) return;
            setLoaded(
                result.ok
                    ? { status: 'ok', skill: result.skill, skillMd: result.skillMd, files: result.files }
                    : { status: 'error', error: result.error }
            );
        });
        return () => {
            alive = false;
        };
    }, [door, id]);

    if (loaded.status === 'loading') return <StateNote state="loading">Loading {name}…</StateNote>;
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
    return (
        <SkillViewFrame
            name={name}
            meta={storedMeta(loaded.skill, loaded.files)}
            skillMd={loaded.skillMd}
            files={loaded.files}
            onClose={onClose}
        />
    );
}
