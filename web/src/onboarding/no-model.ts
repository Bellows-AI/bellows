import type { DeploymentMode } from '@factory-ai/core';
import type { ModelSetupView } from '../api/useModelSetup.js';
import type { WorkspacePayload } from '../api/useWorkspace.js';

/** A read as the hooks hold it: the answer, and why there is none. */
interface Read<T> {
    data: T | null;
    error: string | null;
}

/**
 * Whether to say "No model yet": only where a task could not run. Cloud: a confirmed `effective: null`.
 * Self-hosted: that, and no executor profile or agent default the member could run on either — the
 * runners' own environment may supply a key the board cannot see. Any unconfirmed read says nothing.
 */
export function showNoModel({
    mode,
    modelSetup,
    workspace,
}: {
    mode: DeploymentMode | null;
    modelSetup: Read<ModelSetupView>;
    workspace: Read<WorkspacePayload>;
}): boolean {
    if (modelSetup.error !== null || modelSetup.data?.effective !== null) return false;
    if (mode === 'cloud') return true;
    if (mode === null || workspace.error !== null || workspace.data === null) return false;
    return workspace.data.defaultExecutor === null && (workspace.data.agentDefault ?? null) === null;
}
