import { ERROR_CODES } from '@factory-ai/core';
import { useState } from 'react';
import {
    changeOrgExecutorScope,
    type DefaultsResolution,
    deleteOrgExecutor,
    listOrgExecutorConfigs,
} from '../api/orgExecutors.js';
import type { OrgExecutor } from '../api/useWorkspace.js';
import { CLEAR_DEFAULTS_CHOICE, confirmedWrite, type OrgRowConfirm } from './org-executor-confirm.js';

/** The admin's answer in the dialog: nothing yet, clear, or an organization executor's id to re-point at. */
const resolutionOf = (choice: string): DefaultsResolution | undefined => {
    if (choice === '') return undefined;
    return choice === CLEAR_DEFAULTS_CHOICE ? { clearDefaults: true } : { replaceDefaultsWith: choice };
};

/**
 * The org row's confirmed Delete and Make personal (issue 411): the only place either reaches its route. A row click
 * only asks; when the board refuses because defaults still name the row, the dialog stays open and asks what becomes of
 * them — clear them or re-point them — and the retry carries that explicit answer.
 */
export function useOrgRowConfirm({
    executors,
    onError,
    onRefresh,
}: {
    executors: readonly OrgExecutor[];
    onError: (message: string | null) => void;
    onRefresh: () => void;
}) {
    const [confirm, setConfirm] = useState<OrgRowConfirm | null>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [choice, setChoice] = useState('');

    const close = () => {
        setConfirm(null);
        setRefusal(null);
        setChoice('');
    };

    const run = async (): Promise<void> => {
        if (!confirm) return;
        setBusy(true);
        onError(null);
        const read = await listOrgExecutorConfigs();
        const row = read.ok ? read.executors.find((executor) => executor.name === confirm.name) : undefined;
        const refused = !read.ok
            ? { error: read.error }
            : !row
              ? { error: `"${confirm.name}" no longer exists — refresh the page.` }
              : await confirmedWrite(confirm.action, row, {
                    remove: (id) => deleteOrgExecutor(id, resolutionOf(choice)),
                    demote: (id) => changeOrgExecutorScope(id, 'user', resolutionOf(choice)),
                });
        setBusy(false);
        if (refused && 'code' in refused && refused.code === ERROR_CODES.EXECUTOR_IS_DEFAULT) {
            setRefusal(refused.error);
            return;
        }
        close();
        if (refused) onError(refused.error);
        else onRefresh();
    };

    const options = [
        { value: CLEAR_DEFAULTS_CHOICE, label: 'Clear those defaults' },
        ...executors
            .filter((executor) => executor.name !== confirm?.name && !executor.suspended)
            .map((executor) => ({ value: executor.id, label: `Replace with ${executor.name}` })),
    ];

    return {
        ask: setConfirm,
        dialog: {
            confirm,
            busy,
            onClose: close,
            onConfirm: () => void run(),
            defaults: refusal === null ? null : { refusal, choice, options, onChoice: setChoice },
        },
    };
}
