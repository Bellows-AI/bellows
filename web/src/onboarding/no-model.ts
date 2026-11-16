import type { DeploymentMode } from '@factory-ai/core';
import type { ModelSetupView } from '../api/useModelSetup.js';
import type { WorkspacePayload } from '../api/useWorkspace.js';

/** A read as the hooks hold it: the answer, and why there is none. */
interface Read<T> {
    data: T | null;
    error: string | null;
}

interface NoModelInput {
    mode: DeploymentMode | null;
    modelSetup: Read<ModelSetupView>;
    workspace: Read<WorkspacePayload>;
}

/** The decision as the shell exposes it: `pending` while a read it needs is in flight, never on a failed one. */
export type NoModelState = 'pending' | 'shown' | 'hidden';

/** `showNoModel`'s answer with its in-flight case kept apart: a failed read is `hidden`, an unread one `pending`. */
export function noModelState({ mode, modelSetup, workspace }: NoModelInput): NoModelState {
    if (modelSetup.error !== null) return 'hidden';
    if (modelSetup.data === null) return 'pending';
    if (modelSetup.data.effective !== null) return 'hidden';
    if (mode === 'cloud') return 'shown';
    if (mode === null) return 'pending';
    if (workspace.error !== null) return 'hidden';
    if (workspace.data === null) return 'pending';
    return workspace.data.defaultExecutor === null && (workspace.data.agentDefault ?? null) === null
        ? 'shown'
        : 'hidden';
}

/**
 * Whether to say "No model yet": only where a task could not run. Cloud: a confirmed `effective: null`.
 * Self-hosted: that, and no executor profile or agent default the member could run on either — the
 * runners' own environment may supply a key the board cannot see. Any unconfirmed read says nothing.
 */
export function showNoModel(input: NoModelInput): boolean {
    return noModelState(input) === 'shown';
}
