import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { confirmLabel, confirmTitle } from '../src/panels/org-executor-confirm.js';
import {
    ALL_SUSPENDED_NOTE,
    REMOVE_LABEL,
    RESUME_LABEL,
    SUSPEND_LABEL,
    SUSPENDED_LABEL,
} from '../src/panels/WorkspaceExecutorsPanel.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, orgExecutor, personalExecutor, settingsBoard } from './settings-board.js';

/**
 * The executor rows' own actions on the real Executors page, over a stubbed board that keeps what
 * each write changes: the personal Remove confirmation, personal Suspend's all-suspended note, and
 * an organization profile's Suspend from its overflow menu. The routes' by-id contracts are
 * `server/test/routes.executor-lifecycle.test.ts`'s.
 */

const personalTable = () => screen.findByRole('region', { name: 'Executors' });
const personalRow = async (name: string) =>
    within(await personalTable()).findByRole('row', { name: new RegExp(`^${name}(?![a-z])`) });
const queryPersonalRow = async (name: string) =>
    within(await personalTable()).queryByRole('row', { name: new RegExp(`^${name}(?![a-z])`) });
const orgRow = async (name: string) =>
    within(await screen.findByRole('region', { name: 'Organization executors' })).findByRole('row', {
        name: new RegExp(name),
    });

/** The page as a fresh visit sees it: everything unmounted, then mounted again over the same board. */
function reload() {
    cleanup();
    renderApp('/settings/executors');
}

describe('Remove on a personal profile', () => {
    it('names it, asks first, and removes only that row', async () => {
        const board = settingsBoard({ executors: [personalExecutor('Scratch'), personalExecutor('Keeper')] });
        const scratchId = board.executors[0]!.id;
        const calls = stubFetch(boardHandler(board));
        const removals = () => calls.filter((call) => call.method === 'DELETE');
        const user = userEvent.setup();
        renderApp('/settings/executors');

        await user.click(within(await personalRow('Scratch')).getByRole('button', { name: REMOVE_LABEL }));
        const confirm = await screen.findByRole('dialog');
        within(confirm).getByRole('heading', { name: confirmTitle({ action: 'remove', name: 'Scratch' }) });
        expect(confirm.textContent).toMatch(/personal executor/);
        expect(confirm.textContent).toMatch(/permanently deleted/);
        await waitFor(() =>
            expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
        );

        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await personalRow('Scratch');
        expect(removals()).toEqual([]);

        await user.click(within(await personalRow('Scratch')).getByRole('button', { name: REMOVE_LABEL }));
        const again = await screen.findByRole('dialog');
        await user.click(
            within(again).getByRole('button', { name: confirmLabel({ action: 'remove', name: 'Scratch' }) })
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(async () => expect(await queryPersonalRow('Scratch')).toBeNull());
        expect(removals().map((call) => call.url)).toEqual([`/api/workspace/executors/${scratchId}`]);
        await personalRow('Keeper');

        reload();
        await personalRow('Keeper');
        expect(await queryPersonalRow('Scratch')).toBeNull();
    });
});

describe('Suspend', () => {
    it('says so when the last active personal profile is suspended, and Resume clears it', async () => {
        stubFetch(boardHandler(settingsBoard({ executors: [personalExecutor('Solo')] })));
        const user = userEvent.setup();
        renderApp('/settings/executors');

        await user.click(within(await personalRow('Solo')).getByRole('button', { name: SUSPEND_LABEL }));
        await screen.findByText(ALL_SUSPENDED_NOTE);
        await user.click(within(await personalRow('Solo')).getByRole('button', { name: RESUME_LABEL }));
        await waitFor(() => expect(screen.queryByText(ALL_SUSPENDED_NOTE)).toBeNull());
    });

    it('suspends an organization profile for everyone from its menu, withholding Make default until Resume', async () => {
        const name = 'Main ORG';
        const board = settingsBoard({ orgExecutors: [orgExecutor(name)] });
        stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/executors');

        await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
        await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: SUSPEND_LABEL }));
        await waitFor(async () => expect((await orgRow(name)).textContent).toContain(SUSPENDED_LABEL));
        expect(board.orgExecutors[0]!.suspended).toBe(true);

        reload();
        await waitFor(async () => expect((await orgRow(name)).textContent).toContain(SUSPENDED_LABEL));
        await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
        const menu = await screen.findByRole('menu');
        expect(within(menu).queryByRole('menuitem', { name: 'Make default' })).toBeNull();
        await user.click(within(menu).getByRole('menuitem', { name: RESUME_LABEL }));
        await waitFor(async () => expect((await orgRow(name)).textContent).not.toContain(SUSPENDED_LABEL));
    });
});
