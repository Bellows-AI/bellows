import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTION } from '../src/panels/WorkspaceExecutorsPanel.js';
import {
    ADD_LABEL,
    ADVANCED_LABEL,
    AGENT_HELP,
    CONFIG_JSON_LABEL,
    EXECUTOR_GUIDANCE,
    EXECUTOR_SCOPE,
    EXECUTOR_TYPE_META,
    executorSavedMessage,
    FORMAT_JSON_LABEL,
    INHERITED_NOTE,
    MODEL_BLOCKED_NOTE,
    MODEL_CUSTOM_LABEL,
    MODEL_DEFAULT_LABEL,
    NAME_HELP,
    NO_CHANGES_REASON,
    RUNNER_MANAGED_NOTE,
    SAVE_HINTS,
    SAVE_LABEL,
} from '../src/workspace/executors.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/**
 * The personal executor dialog on the real Executors page, over a stubbed board that stores what
 * the whole-list PUT sends: guided setup with no JSON typed, the discard confirmation, focus
 * restoration, and the Advanced editor's lossless, per-agent drafts across a failed save. The
 * validation and draft logic is `executors.test.ts`'s; the server round trip
 * `server/test/routes.workspace.test.ts`'s.
 */

const executorDialog = () => screen.getByRole('dialog', { name: /^(Add|Edit) executor$/ });
const inDialog = () => within(executorDialog());
const confirmDialog = 'Discard unsaved changes?';

/** The text of everything a control names with aria-describedby. */
function describedBy(element: HTMLElement): string {
    const ids = element.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    expect(ids.length, 'the field names no describedby target').toBeGreaterThan(0);
    return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

const field = (label: string) => inDialog().getByLabelText<HTMLInputElement>(label, { exact: true });
const button = (name: string) => inDialog().getByRole<HTMLButtonElement>('button', { name });
const modelGroup = () => inDialog().getByRole('group', { name: 'Model' });
const modelRadio = (name: string) => within(modelGroup()).getByRole<HTMLInputElement>('radio', { name });
const customModel = () => within(modelGroup()).getByRole<HTMLInputElement>('textbox', { name: MODEL_CUSTOM_LABEL });
const json = () => inDialog().getByRole<HTMLTextAreaElement>('textbox', { name: CONFIG_JSON_LABEL });
const status = () => screen.getAllByRole('status').map((node) => node.textContent ?? '');
const dialogGone = () =>
    waitFor(() => expect(screen.queryByRole('dialog', { name: /^(Add|Edit) executor$/ })).toBeNull());
const editButton = async (name: string) =>
    within(
        await within(await screen.findByRole('region', { name: 'Executors' })).findByRole('row', {
            name: new RegExp(`^${name}(?![a-z])`),
        })
    ).getByRole<HTMLButtonElement>('button', { name: 'Edit' });

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: ADD_LABEL }));
    await screen.findByRole('dialog', { name: /^(Add|Edit) executor$/ });
}

describe('the executor dialog', () => {
    it('adds an executor through guided setup, with no JSON typed', async () => {
        const board = settingsBoard();
        stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/executors');

        // The page's scope sentence and the panel's guidance, asserted against the constants they render.
        await screen.findByRole('button', { name: ADD_LABEL });
        expect(document.querySelector('.page-header-description')?.textContent).toBe(EXECUTOR_SCOPE);
        const panel = screen.getByRole('heading', { name: 'My workspace' }).closest('section') as HTMLElement;
        expect(panel.textContent).toContain(EXECUTOR_GUIDANCE);

        const add = screen.getByRole('button', { name: ADD_LABEL });
        await openAdd(user);
        expect(executorDialog().getAttribute('aria-modal')).toBe('true');
        expect(executorDialog().querySelector('.picker')).not.toBeNull();

        // Guided order, visible labels, each help wired to its field.
        expect(describedBy(field('Name'))).toContain(NAME_HELP);
        expect(describedBy(field('Agent'))).toContain(AGENT_HELP);
        expect(modelRadio(MODEL_DEFAULT_LABEL).checked).toBe(true);
        expect(executorDialog().textContent).toContain(INHERITED_NOTE);
        // Advanced is collapsed: no JSON is in front of the member.
        expect(json().closest('details')?.open).toBe(false);

        // Nothing typed yet: Save is unavailable, and the reason sits beside it.
        expect(button(ADD_LABEL).disabled).toBe(true);
        expect(describedBy(button(ADD_LABEL))).toBe(SAVE_HINTS.name);

        await user.type(field('Name'), 'main');
        expect(button(ADD_LABEL).disabled).toBe(false);
        await user.click(button(ADD_LABEL));
        await dialogGone();

        // Focus went back to the trigger, and the save was announced in the page's status region.
        await waitFor(() => expect(document.activeElement).toBe(add));
        expect(status()).toContain(executorSavedMessage('main', false));
        await editButton('main');
        const row = (await editButton('main')).closest('tr') as HTMLElement;
        expect(row.querySelector('.pill')?.textContent).toBe('Claude Code');
        expect(screen.getAllByText(DEFAULT_CAPTION)).toHaveLength(1);
        expect(board.executors.map((executor) => executor.name)).toEqual(['main']);

        // A duplicate name is refused beside the Name field, before any save.
        await openAdd(user);
        await user.type(field('Name'), 'main');
        inDialog().getByText('An executor named "main" already exists.');
        expect(field('Name').getAttribute('aria-invalid')).toBe('true');
        expect(button(ADD_LABEL).disabled).toBe(true);

        // Dirty dismissal asks first. Escape, then the safe answer, keeps every field.
        await user.keyboard('{Escape}');
        const confirm = await screen.findByRole('dialog', { name: confirmDialog });
        within(confirm).getByRole('heading', { name: confirmDialog });
        await user.click(within(confirm).getByRole('button', { name: 'Continue editing' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: confirmDialog })).toBeNull());
        expect(field('Name').value).toBe('main');
        // Cancel asks too; Discard changes closes, and focus returns to the trigger.
        await user.click(button('Cancel'));
        await user.click(
            within(await screen.findByRole('dialog', { name: confirmDialog })).getByRole('button', {
                name: 'Discard changes',
            })
        );
        await dialogGone();
        await waitFor(() => expect(document.activeElement).toBe(add));

        // Edit: nothing changed, nothing to save.
        await user.click(await editButton('main'));
        await screen.findByRole('dialog', { name: 'Edit executor' });
        expect(button(SAVE_LABEL).disabled).toBe(true);
        expect(describedBy(button(SAVE_LABEL))).toBe(NO_CHANGES_REASON);

        // A custom model through the guided control is the configuration's `model`.
        await user.click(modelRadio(MODEL_CUSTOM_LABEL));
        expect(button(SAVE_LABEL).disabled).toBe(true);
        await user.type(customModel(), 'opus');
        await user.click(inDialog().getByText(ADVANCED_LABEL));
        expect(json().value).toBe('{\n  "model": "opus"\n}');
        await user.click(button(SAVE_LABEL));
        await dialogGone();
        await waitFor(async () => expect(document.activeElement).toBe(await editButton('main')));
        expect(status()).toContain(executorSavedMessage('main', true));

        // Reopened with identical settings; a pristine Escape closes without asking.
        await user.click(await editButton('main'));
        await screen.findByRole('dialog', { name: 'Edit executor' });
        expect(modelRadio(MODEL_CUSTOM_LABEL).checked).toBe(true);
        expect(customModel().value).toBe('opus');
        await user.keyboard('{Escape}');
        await dialogGone();
        expect(screen.queryByRole('dialog', { name: confirmDialog })).toBeNull();
    });

    it('keeps advanced editing lossless and per agent, and survives a failed save', async () => {
        const board = settingsBoard();
        let failNext = true;
        const calls = stubFetch(
            boardHandler(board, ({ method, url }) => {
                if (method !== 'PUT' || url !== '/api/workspace/executors' || !failNext) return;
                failNext = false;
                return { status: 500, body: { error: 'The board is unavailable' } };
            })
        );
        const user = userEvent.setup();
        renderApp('/settings/executors');

        await openAdd(user);
        await user.type(field('Name'), 'advanced');
        await user.click(inDialog().getByText(ADVANCED_LABEL));
        expect(json().value).toBe('{}');
        expect(describedBy(json())).toContain(EXECUTOR_TYPE_META[CLAUDE_CODE].configHelp);

        // Invalid JSON: marked, located, kept, and the guided model waits for it instead of overwriting it.
        fireEvent.change(json(), { target: { value: '{ model: }' } });
        expect(json().getAttribute('aria-invalid')).toBe('true');
        inDialog().getByText(/^Not valid JSON at line 1, column 3: /);
        expect(json().value).toBe('{ model: }');
        expect(modelRadio(MODEL_DEFAULT_LABEL).disabled).toBe(true);
        expect(modelGroup().textContent).toContain(MODEL_BLOCKED_NOTE);
        expect(button(ADD_LABEL).disabled).toBe(true);
        expect(describedBy(button(ADD_LABEL))).toBe(SAVE_HINTS.config);

        // Tab leaves the editor rather than indenting inside it.
        json().focus();
        await user.tab();
        expect(document.activeElement).not.toBe(json());
        expect(json().value).toBe('{ model: }');

        // Valid again: unknown keys stay, the runner-managed key is named, and the guided control reads the model.
        fireEvent.change(json(), { target: { value: '{"custom":1,"hooks":{},"model":"sonnet"}' } });
        expect(json().getAttribute('aria-invalid')).toBeNull();
        const managed = executorDialog().querySelector('.picker-managed')?.textContent ?? '';
        expect(managed).toContain(RUNNER_MANAGED_NOTE);
        expect(managed).toContain('hooks');
        expect(customModel().value).toBe('sonnet');
        await user.click(button(FORMAT_JSON_LABEL));
        expect(json().value).toBe('{\n  "custom": 1,\n  "hooks": {},\n  "model": "sonnet"\n}');
        await user.clear(customModel());
        await user.type(customModel(), 'opus');
        const edited = '{\n  "custom": 1,\n  "hooks": {},\n  "model": "opus"\n}';
        expect(json().value).toBe(edited);

        // Each agent keeps its own draft: OpenCode starts inherited, and Claude Code's is waiting.
        await user.selectOptions(field('Agent'), 'OpenCode');
        expect(modelRadio(MODEL_DEFAULT_LABEL).checked).toBe(true);
        expect(json().value).toBe('{}');
        expect(describedBy(json())).toContain(EXECUTOR_TYPE_META[OPENCODE].configHelp);
        await user.selectOptions(field('Agent'), 'Claude Code');
        expect(customModel().value).toBe('opus');
        expect(json().value).toBe(edited);

        // A failed save keeps every field and allows a retry.
        await user.click(button(ADD_LABEL));
        expect((await inDialog().findByRole('alert')).textContent).toContain('The board is unavailable');
        expect(field('Name').value).toBe('advanced');
        expect(json().value).toBe(edited);
        await user.click(button(ADD_LABEL));
        await dialogGone();
        const puts = calls.filter((call) => call.method === 'PUT' && call.url === '/api/workspace/executors');
        expect(puts).toHaveLength(2);
        const sent = puts[1]!.body as { executors: { name: string; config: object }[] };
        expect(sent.executors.find((row) => row.name === 'advanced')).toMatchObject({
            config: { custom: 1, hooks: {}, model: 'opus' },
        });

        // Reopened, the unknown key round-tripped through the stored row.
        await user.click(await editButton('advanced'));
        await screen.findByRole('dialog', { name: 'Edit executor' });
        await user.click(inDialog().getByText(ADVANCED_LABEL));
        expect(JSON.parse(json().value)).toEqual({ custom: 1, hooks: {}, model: 'opus' });
        expect(button(SAVE_LABEL).disabled).toBe(true);
        await user.keyboard('{Escape}');
        await dialogGone();
    });
});
