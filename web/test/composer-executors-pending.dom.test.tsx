import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposerDraftInput } from '../src/composer-draft.js';
import { TaskComposer } from '../src/panels/TaskComposer.js';
import { inertDraftStore } from './tasks-fixtures.js';

// The composer reads the attachment limits on mount; unmount before jsdom goes so that read never lands after it.
afterEach(cleanup);

/**
 * The repositories and the executors are two reads now. A restored draft's executor must survive
 * the window where the repositories have answered and the workspace read has not: the executor
 * list is empty only for lack of an answer, and clamping against it would drop the choice.
 */

const restored: ComposerDraftInput = {
    draft: 'fix it',
    executor: 'heavy',
    executorScope: 'user',
    repo: 'acme/web',
    repoTouched: true,
    workflowRepo: 'acme/web',
    workflow: '',
    storedParams: { workflowId: null, values: {} },
    paramTouched: {},
};

describe('the composer while only the repositories have answered', () => {
    it('keeps a restored executor until the workspace read names the list', () => {
        const saved: ComposerDraftInput[] = [];
        render(
            <MemoryRouter>
                <TaskComposer
                    repos={[{ owner: 'acme', name: 'web' }]}
                    reposError={null}
                    onRetryRepos={() => {}}
                    workspaceLoaded={false}
                    workspaceError={null}
                    onRetryWorkspace={() => {}}
                    executors={[]}
                    defaultExecutor={null}
                    workflows={null}
                    actionError={null}
                    sending={false}
                    onSend={async () => null}
                    draftStore={inertDraftStore({
                        state: { ...restored, owner: 'org-1:user-1' },
                        save: (next) => saved.push(next),
                    })}
                />
            </MemoryRouter>
        );
        expect(saved.every((draft) => draft.executor === 'heavy')).toBe(true);
    });
});
