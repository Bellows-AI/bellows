import { ADMIN_ROLE } from '@factory-ai/core';
import { useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { BuiltinSkillsSection } from '../panels/BuiltinSkillsSection.js';
import { SkillEditor, SKILL_DRAFT_ID, editorKey } from '../panels/SkillEditor.js';
import { SkillsSection, type SkillEditorTarget } from '../panels/SkillsSection.js';
import { useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import { useSkillLists, type SkillList } from '../settings/useSkillLists.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Skills section of the settings tree: the member's own skills and the organization's,
 * beside the built-ins. This page loads the two stored lists and owns which inline editor is open;
 * `SkillsSection` renders one door of them.
 */

/**
 * What the precedence strip does not say: it is the catalog and selection order, not what a running
 * task uses. `docs/skills.md` states the same limit.
 */
export const RUNTIME_PRECEDENCE_NOTE =
    'In a running task a repository skill can still win over your own skill of the same name: on claude-code the repository’s copy is the one used, and on opencode which copy is used is not fixed.';

const PRECEDENCE = ['Built-in', 'Organization', 'Repository', 'My workspace'] as const;

const skillsOf = (list: SkillList) => (list.status === 'ok' ? list.skills : []);

export function SettingsSkillsPage() {
    const { session } = useSettingsPage();
    const { lists, reload } = useSkillLists();
    const [editor, setEditor] = useState<SkillEditorTarget | null>(null);
    const [saving, setSaving] = useState(false);
    // Each opened editor gets the next token; a completion acts on the page only while its token is still the open one.
    const token = useRef(0);
    const isAdmin = session?.role === ADMIN_ROLE;
    const guard = useUnsavedChanges();

    /** Opening a different editor remounts the card, so a dirty draft is asked about first; null closes it. */
    const openEditor = async (next: SkillEditorTarget | null) => {
        const draft =
            editor && (!next || editorKey(next) !== editorKey(editor)) ? guard?.dirtyDraft(SKILL_DRAFT_ID) : null;
        if (draft && guard && !(await guard.confirmDiscard(draft))) return;
        if (next && (!editor || editorKey(next) !== editorKey(editor))) token.current += 1;
        setEditor(next);
    };
    const closeIfCurrent = (own: number) => {
        if (token.current === own) setEditor(null);
    };
    const renderEditor = (target: SkillEditorTarget) => {
        const own = token.current;
        return (
            <SkillEditor
                key={editorKey(target)}
                target={target}
                onClose={() => closeIfCurrent(own)}
                onBusyChange={(busy) => token.current === own && setSaving(busy)}
                onChanged={(doors) => void reload(doors)}
            />
        );
    };

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Skills"
                description="Instructions an agent can load during a task. Pick them in the composer’s skill menu."
            />
            <details className="skills-about">
                <summary>About skills</summary>
                <p className="muted">
                    A skill is a folder with a SKILL.md at its root, plus optional scripts and templates. A task pins
                    the exact version it started with. Repository skills come from{' '}
                    <span className="mono">.claude/skills/</span> in the repo and are listed in the composer, not here,
                    and a repository skill can also shadow an organization skill for that repository.{' '}
                    {RUNTIME_PRECEDENCE_NOTE}
                </p>
            </details>
            <section className="skill-precedence" aria-label="Which skill wins when two have the same name">
                When two skills share a name, the one further right wins:{' '}
                {PRECEDENCE.map((step, index) => (
                    <span key={step} className="skill-precedence-item">
                        {index > 0 ? <span aria-hidden="true">›</span> : null}
                        <span className="pill">{step}</span>
                    </span>
                ))}
            </section>
            <SkillsSection
                door="workspace"
                list={lists.workspace}
                canWrite
                canPromote={isAdmin}
                organizationNames={skillsOf(lists.org).map((skill) => skill.name)}
                workspaceRows={skillsOf(lists.workspace)}
                editor={editor}
                onEditor={(next) => void openEditor(next)}
                renderEditor={renderEditor}
                locked={saving}
                onChanged={(doors) => void reload(doors)}
            />
            <SkillsSection
                door="org"
                list={lists.org}
                canWrite={isAdmin}
                canPromote={false}
                organizationNames={[]}
                workspaceRows={skillsOf(lists.workspace)}
                editor={editor}
                onEditor={(next) => void openEditor(next)}
                renderEditor={renderEditor}
                locked={saving}
                onChanged={(doors) => void reload(doors)}
            />
            <BuiltinSkillsSection isAdmin={isAdmin} />
        </>
    );
}
