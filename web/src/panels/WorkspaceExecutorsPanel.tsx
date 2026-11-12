import type { DefaultExecutor, WorkspaceExecutor } from '../api/useWorkspace.js';
import { Icon } from '../components/Icon.js';
import { Avatar } from '../components/Avatar.js';
import { RowActions, type RowAction } from '../components/RowActions.js';
import { commitDate } from '../format.js';
import { ADD_LABEL, executorTypeLabel } from '../workspace/executors.js';
import { ScrollRegion } from '../components/ScrollRegion.js';

/**
 * One row per configured personal executor — each with the Edit action that reopens the dialog on
 * it, and the Make default action that stores the member's preference naming it (issue 391) — and
 * the empty state that makes "none" a sentence rather than a blank panel. The head carries the
 * scope's own Add action beside "My workspace" (issue 183); the page's one disclosure explains the
 * task-scoped runner choice. Edit is the row's inline action; the rest sit in its overflow menu.
 */

/** The row action that flags an executor as the default (issue 215, re-cut as a preference by 391). */
export const MAKE_DEFAULT_LABEL = 'Make default';

/** The tag on the row the member's preference resolves to — the composer autoselects it. */
export const DEFAULT_LABEL = 'Default';

/** The lifecycle actions and status (issue 440), here so the e2e specs assert the strings the DOM renders. */
export const SUSPENDED_LABEL = 'Suspended';
export const SUSPEND_LABEL = 'Suspend';
export const RESUME_LABEL = 'Resume';
export const REMOVE_LABEL = 'Remove';
/** The empty state once every profile is suspended: configured, but nothing a task can select. */
export const ALL_SUSPENDED_NOTE = 'Every executor is suspended. Resume one, or select an organization executor.';

export function WorkspaceExecutorsPanel({
    executors,
    defaultExecutor,
    onAdd,
    onEdit,
    onMakeDefault,
    onSuspend,
    onRemove,
    saving,
}: {
    executors: readonly WorkspaceExecutor[];
    /** The member's resolved default, from the same poll; null when nothing is selectable. */
    defaultExecutor: DefaultExecutor | null;
    onAdd: () => void;
    onEdit: (name: string) => void;
    onMakeDefault: (name: string) => void;
    onSuspend: (id: string, suspended: boolean) => void;
    onRemove: (name: string) => void;
    saving: boolean;
}) {
    /** Overflow entries; the destructive Remove sorts last in `RowActions`. A suspended row cannot be a default (issue 440). */
    const isDefaultRow = (executor: WorkspaceExecutor) =>
        defaultExecutor !== null && defaultExecutor.scope === 'user' && defaultExecutor.name === executor.name;
    const overflow = (executor: WorkspaceExecutor): RowAction[] => {
        return [
            ...(executor.suspended || isDefaultRow(executor)
                ? []
                : [{ label: MAKE_DEFAULT_LABEL, onSelect: () => onMakeDefault(executor.name) }]),
            {
                label: executor.suspended ? RESUME_LABEL : SUSPEND_LABEL,
                onSelect: () => onSuspend(executor.id, !executor.suspended),
            },
            { label: REMOVE_LABEL, onSelect: () => onRemove(executor.name), danger: true },
        ];
    };
    return (
        <section className="panel">
            <div className="panel-head">
                <h2>
                    My workspace
                    <span className="count">{executors.length}</span>
                </h2>
                <button type="button" className="executor-add" onClick={onAdd}>
                    <Icon name="plus" />
                    {ADD_LABEL}
                </button>
            </div>
            {executors.length > 0 && executors.every((executor) => executor.suspended) ? (
                <p className="muted">{ALL_SUSPENDED_NOTE}</p>
            ) : null}
            {executors.length === 0 ? (
                <p className="muted">
                    No personal executors. Add one, or select an organization executor for a new task.
                </p>
            ) : (
                <ScrollRegion className="table-wrap" aria-label="Executors">
                    <table className="data data-compact table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Type</th>
                                <th scope="col">Gate repair</th>
                                <th scope="col">Added</th>
                                <th scope="col">
                                    <span className="muted">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {executors.map((executor) => (
                                <tr key={executor.name}>
                                    <td data-label="Name">
                                        <span className="member-identity">
                                            <Avatar author={{ login: executor.name, avatarUrl: null }} size={28} />
                                            <span className="member-login" title={executor.name}>
                                                {executor.name}
                                            </span>
                                            {isDefaultRow(executor) || executor.suspended ? (
                                                <span className="pill-list">
                                                    {isDefaultRow(executor) ? (
                                                        <span className="pill">{DEFAULT_LABEL}</span>
                                                    ) : null}
                                                    {executor.suspended ? (
                                                        <span className="pill">{SUSPENDED_LABEL}</span>
                                                    ) : null}
                                                </span>
                                            ) : null}
                                        </span>
                                    </td>
                                    <td data-label="Type">
                                        <span className="pill">{executorTypeLabel(executor.type)}</span>
                                    </td>
                                    <td data-label="Gate repair">
                                        {/* The default-workflow repair budget tasks on this executor
                                            launch with (#49); 0 means automatic repair is off. */}
                                        {executor.gateFixRounds}
                                    </td>
                                    <td data-label="Added" className="muted">
                                        {commitDate(executor.createdAt)}
                                    </td>
                                    <td data-label="Actions">
                                        <RowActions
                                            rowName={executor.name}
                                            primary={{ label: 'Edit', onSelect: () => onEdit(executor.name) }}
                                            actions={overflow(executor)}
                                            disabled={saving}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </ScrollRegion>
            )}
        </section>
    );
}
