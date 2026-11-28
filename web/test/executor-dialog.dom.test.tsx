import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL } from '../src/panels/WorkspaceExecutorsPanel.js';
import {
    ADD_LABEL,
    ADVANCED_LABEL,
    AGENT_HELP,
    CLOUD_OAUTH_NOTE,
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
    RUNNER_CLASS_DEFAULT_LABEL,
    RUNNER_CLASS_HELP,
    RUNNER_CLASS_LABEL,
    RUNNER_MANAGED_NOTE,
    runnerClassOptionLabel,
    SAVE_HINTS,
    SAVE_LABEL,
} from '../src/workspace/executors.js';
import { GUIDED_COPY } from '../src/workspace/executor-guided.js';
import { chooseConnection, renderApp, stubFetch } from './dom.js';
import { VERIFY_URL } from './model-setup-reads.js';
import { boardHandler, listedModels, personalExecutor, providerConnection, settingsBoard } from './settings-board.js';

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

const CONN = providerConnection('Team key', { scope: 'org', provider: 'anthropic' });
/** A board holding the one connection every executor in these flows runs on. */
const connectedBoard = (overrides: Parameters<typeof settingsBoard>[0] = {}) =>
    settingsBoard({ providerConnections: [CONN], ...overrides });

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: ADD_LABEL }));
    await screen.findByRole('dialog', { name: /^(Add|Edit) executor$/ });
}

describe('the executor dialog', () => {
    it('adds an executor through guided setup, with no JSON typed', async () => {
        const board = connectedBoard();
        stubFetch(boardHandler(board));
        // No inter-action timer: each step below waits on the element or request it needs, not on wall time.
        // The flow is split across three tests so no one test renders ~60 steps under a loaded runner.
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');

        // The page's scope sentence and the panel's guidance, asserted against the constants they render.
        await screen.findByRole('button', { name: ADD_LABEL });
        expect(document.querySelector('.page-header-description')?.textContent).toBe(EXECUTOR_SCOPE);
        const guidance = screen.getByText('About executors').closest('details') as HTMLDetailsElement;
        expect(guidance.textContent).toContain(EXECUTOR_GUIDANCE);

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
        // A name alone is not enough: every executor runs on a provider connection.
        expect(button(ADD_LABEL).disabled).toBe(true);
        expect(describedBy(button(ADD_LABEL))).toBe(SAVE_HINTS.connection);
        await chooseConnection(user, CONN.id);
        expect(button(ADD_LABEL).disabled).toBe(false);
        await user.click(button(ADD_LABEL));
        await dialogGone();

        // Focus went back to the trigger, and the save was announced in the page's status region.
        await waitFor(() => expect(document.activeElement).toBe(add));
        expect(status()).toContain(executorSavedMessage('main', false));
        await editButton('main');
        const row = (await editButton('main')).closest('tr') as HTMLElement;
        expect(row.querySelector('[data-label="Type"] .pill')?.textContent).toBe('Claude Code');
        expect(within(row).getAllByText(DEFAULT_LABEL)).toHaveLength(1);
        expect(board.executors.map((executor) => executor.name)).toEqual(['main']);
    });

    it('refuses a duplicate name, and asks before discarding a dirty dialog', async () => {
        stubFetch(boardHandler(settingsBoard({ executors: [personalExecutor('main')] })));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await editButton('main');
        const add = screen.getByRole('button', { name: ADD_LABEL });

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
    });

    it('edits the model through the guided control, and reopens with the same settings', async () => {
        stubFetch(
            boardHandler(
                connectedBoard({ executors: [{ ...personalExecutor('main'), providerConnectionId: CONN.id }] })
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');

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
        const board = connectedBoard();
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
        await chooseConnection(user, CONN.id);
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

    it('in a cloud org not allowed a subscription, says an OAuth token cannot be configured and an API key can', async () => {
        stubFetch(boardHandler(settingsBoard({ deploymentMode: 'cloud', subscriptionToken: false })));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        expect(executorDialog().textContent).toContain(CLOUD_OAUTH_NOTE);
        expect(CLOUD_OAUTH_NOTE).toContain('ANTHROPIC_API_KEY');
    });

    it('in a cloud org the operator allows a subscription, the cloud note is absent', async () => {
        stubFetch(boardHandler(settingsBoard({ deploymentMode: 'cloud', subscriptionToken: true })));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        expect(executorDialog().textContent).not.toContain(CLOUD_OAUTH_NOTE);
    });

    it('self-hosted, the cloud note is absent', async () => {
        stubFetch(boardHandler(settingsBoard()));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        expect(executorDialog().textContent).not.toContain(CLOUD_OAUTH_NOTE);
    });
});

describe('the runner class (organization profiles only)', () => {
    const classes = [
        { name: 'standard', docker: false },
        { name: 'builds', docker: true },
    ];
    const orgDialog = () => screen.getByRole('dialog', { name: /^(Add|Edit) executor$/ });
    const classSelect = () =>
        within(orgDialog()).getByLabelText<HTMLSelectElement>(RUNNER_CLASS_LABEL, { exact: true });
    const orgRow = async (name: string) =>
        within(await screen.findByRole('region', { name: 'Organization executors' })).findByRole('row', {
            name: new RegExp(name),
        });

    it('the dialog offers the declared classes and submits the chosen one', async () => {
        const board = connectedBoard({ runnerClasses: classes });
        const calls = stubFetch(boardHandler(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');

        await user.click(await screen.findByRole('button', { name: 'Add organization executor' }));
        await screen.findByRole('dialog', { name: ADD_LABEL });
        // The deployment's default first, then every declared class, each saying whether it has docker.
        expect([...classSelect().options].map((option) => [option.value, option.textContent])).toEqual([
            ['', RUNNER_CLASS_DEFAULT_LABEL],
            ['standard', runnerClassOptionLabel(classes[0]!)],
            ['builds', runnerClassOptionLabel(classes[1]!)],
        ]);
        expect(runnerClassOptionLabel(classes[1]!)).toMatch(/docker/i);
        expect(describedBy(classSelect())).toContain(RUNNER_CLASS_HELP);

        await user.type(within(orgDialog()).getByLabelText('Name', { exact: true }), 'Builder');
        await chooseConnection(user, CONN.id);
        await user.selectOptions(classSelect(), 'builds');
        await user.click(within(orgDialog()).getByRole('button', { name: ADD_LABEL }));
        await dialogGone();
        const posts = calls.filter((call) => call.method === 'POST' && call.url === '/api/org/executors');
        expect(posts.map((call) => (call.body as { runnerClass: unknown }).runnerClass)).toEqual(['builds']);

        // The list shows the class, and an edit opens on it and sends it back unchanged: the PUT is
        // whole-entry, so an edit that left it out would put the profile back in the default class.
        expect((await orgRow('Builder')).textContent).toContain('builds');
        await user.click(within(await orgRow('Builder')).getByRole('button', { name: 'Edit' }));
        await screen.findByRole('dialog', { name: 'Edit executor' });
        expect(classSelect().value).toBe('builds');
        await user.type(within(orgDialog()).getByLabelText('Name', { exact: true }), ' 2');
        await user.click(within(orgDialog()).getByRole('button', { name: SAVE_LABEL }));
        await dialogGone();
        const puts = calls.filter((call) => call.method === 'PUT' && call.url.startsWith('/api/org/executors/'));
        expect(puts.map((call) => call.body)).toMatchObject([{ name: 'Builder 2', runnerClass: 'builds' }]);

        // A class-only change is a change: Save turns on, and back to the default sends null.
        await user.click(within(await orgRow('Builder 2')).getByRole('button', { name: 'Edit' }));
        await screen.findByRole('dialog', { name: 'Edit executor' });
        expect(within(orgDialog()).getByRole<HTMLButtonElement>('button', { name: SAVE_LABEL }).disabled).toBe(true);
        await user.selectOptions(classSelect(), '');
        await user.click(within(orgDialog()).getByRole('button', { name: SAVE_LABEL }));
        await dialogGone();
        expect(board.orgExecutors.find((row) => row.name === 'Builder 2')?.runnerClass).toBeNull();
    });

    it('offers no class on a personal profile, nor when the board declares none', async () => {
        const board = settingsBoard({ runnerClasses: classes });
        stubFetch(boardHandler(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');

        await openAdd(user);
        expect(within(orgDialog()).queryByLabelText(RUNNER_CLASS_LABEL)).toBeNull();
        await user.keyboard('{Escape}');
        await dialogGone();

        board.runnerClasses = [];
        await user.click(await screen.findByRole('button', { name: 'Add organization executor' }));
        await screen.findByRole('dialog', { name: ADD_LABEL });
        expect(within(orgDialog()).queryByLabelText(RUNNER_CLASS_LABEL)).toBeNull();
    });
});

describe('the executor dialog: the guided provider step', () => {
    const PROVIDER_GROUP = 'Provider';

    /** A card's accessible name is its label with its second line: match on the label's head. */
    const providerRadio = (label: string) =>
        within(inDialog().getByRole('radiogroup', { name: PROVIDER_GROUP })).getByRole<HTMLInputElement>('radio', {
            name: new RegExp(`^${label}`),
        });

    it('adds an OpenAI-compatible executor through the guided step, with no JSON typed', async () => {
        const board = connectedBoard();
        stubFetch(boardHandler(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);

        // The provider step waits collapsed: no JSON in front of the member, and the raw Model control
        // still the one shown.
        const pick = inDialog().getByText(GUIDED_COPY.PROVIDER_STEP_LABEL);
        expect(pick.closest('details')?.open).toBe(false);
        expect(modelRadio(MODEL_DEFAULT_LABEL).checked).toBe(true);

        await user.click(pick);
        const cards = inDialog().getByRole('radiogroup', { name: PROVIDER_GROUP });
        expect(within(cards).getAllByRole('radio')).toHaveLength(3); // Claude Code: Anthropic, OpenRouter, LiteLLM

        // The OpenAI-compatible card only exists for OpenCode: switch the agent first.
        await user.selectOptions(field('Agent'), 'OpenCode');
        expect(within(inDialog().getByRole('radiogroup', { name: PROVIDER_GROUP })).getAllByRole('radio')).toHaveLength(
            5
        );
        await user.click(providerRadio('OpenAI-compatible'));

        // The generated configuration appears under Advanced with no typing in it, and the raw
        // Model control is replaced by the guided one.
        expect(inDialog().queryByRole('group', { name: 'Model' })).toBeNull();
        await user.type(field('Base URL'), 'http://127.0.0.1:9/v1');
        await user.click(inDialog().getByText(GUIDED_COPY.KEY_REFERENCE_LABEL));
        await user.type(field('API key'), 'GATEWAY_KEY');
        await user.type(field('Model'), 'llama-3');
        await user.click(inDialog().getByText(ADVANCED_LABEL));
        const generated = JSON.parse(json().value) as {
            model: string;
            provider: Record<string, { npm: string; options: Record<string, string> }>;
        };
        expect(generated.model).toBe('127-0-0-1/llama-3');
        expect(generated.provider['127-0-0-1']).toMatchObject({
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{env:GATEWAY_KEY}' },
        });

        await user.type(field('Name'), 'gateway');
        await chooseConnection(user, CONN.id);
        await user.click(button(ADD_LABEL));
        await dialogGone();
        const saved = board.executors.find((executor) => executor.name === 'gateway');
        // The chosen connection's provider prefixes the model the way the server accepts it; the rest is as generated.
        expect(saved?.config).toEqual({ ...generated, model: expect.stringContaining(generated.model) });
        expect(JSON.stringify(saved?.config)).not.toContain('GATEWAY_KEY_VALUE');
    });

    it('does not check an OpenAI-compatible endpoint key: no verify request fires for it', async () => {
        const checks: string[] = [];
        stubFetch(
            boardHandler(settingsBoard(), ({ method, url }) => {
                if (method === 'POST' && url === VERIFY_URL) checks.push(url);
            })
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);

        await user.click(inDialog().getByText(GUIDED_COPY.PROVIDER_STEP_LABEL));
        await user.selectOptions(field('Agent'), 'OpenCode');
        await user.click(providerRadio('OpenAI-compatible'));
        await user.type(field('Base URL'), 'http://127.0.0.1:9/v1');
        await user.type(field('API key'), 'sk-endpoint-key');
        // The endpoint is reached when a task runs, not from the dialog: no check fired.
        expect(checks).toEqual([]);
        expect(executorDialog().textContent).toContain('The endpoint is not checked here');
    });

    it('removing the provider settings puts back the configuration the pick started from', async () => {
        stubFetch(boardHandler(settingsBoard({ executors: [personalExecutor('main', { model: 'opus' })] })));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await user.click(await editButton('main'));
        await screen.findByRole('dialog', { name: 'Edit executor' });

        await user.click(inDialog().getByText(GUIDED_COPY.PROVIDER_STEP_LABEL));
        await user.click(providerRadio('Anthropic'));
        await user.type(field('Model'), 'sonnet');
        await user.click(inDialog().getByText(ADVANCED_LABEL));
        expect(json().value).not.toBe('{}');

        await user.click(inDialog().getByRole('button', { name: GUIDED_COPY.REMOVE_PROVIDER_LABEL }));
        expect(json().value).toBe('{\n  "model": "opus"\n}');
        expect(modelRadio(MODEL_CUSTOM_LABEL).checked).toBe(true);
        expect(customModel().value).toBe('opus');
        // A pristine close asks nothing.
        await user.keyboard('{Escape}');
        await dialogGone();
        expect(screen.queryByRole('dialog', { name: confirmDialog })).toBeNull();
    });
});

describe('the executor dialog: provider connections', () => {
    const TEAM = providerConnection('Team key', { scope: 'org', provider: 'anthropic' });
    const MINE = providerConnection('My key', { scope: 'personal', provider: 'anthropic' });
    const OPENAI = providerConnection('OpenAI key', { scope: 'org', provider: 'openai' });
    const SUBSCRIPTION = providerConnection('Max plan', { scope: 'personal', provider: 'subscription' });
    /** With suggestions the input names a datalist, which makes it a combobox. */
    const typedModel = () => within(modelGroup()).getByRole<HTMLInputElement>('combobox', { name: MODEL_CUSTOM_LABEL });
    const connectionSelect = () => inDialog().getByLabelText<HTMLSelectElement>('Provider connection', { exact: true });
    const CHOOSE = 'Choose a connection';
    const optionNames = () => [...connectionSelect().options].map((option) => option.textContent);
    const putBody = (calls: { method: string; url: string; body: unknown }[]) =>
        calls.filter((call) => call.method === 'PUT' && call.url === '/api/workspace/executors').at(-1)?.body as {
            executors: { name: string; providerConnectionId?: string | null; config: Record<string, unknown> }[];
        };
    const connectionWrites = (calls: { method: string; url: string }[]) =>
        calls.filter((call) => call.method !== 'GET' && call.url.startsWith('/api/provider-connections'));
    const board = (overrides: Parameters<typeof settingsBoard>[0] = {}) =>
        settingsBoard({ providerConnections: [TEAM, MINE, OPENAI, SUBSCRIPTION], ...overrides });

    it('filters connections by scope and runtime', async () => {
        stubFetch(boardHandler(board()));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);

        // Claude Code runs Anthropic and a subscription; an OpenAI key is explained, not offered.
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        expect(optionNames()).toEqual([
            CHOOSE,
            'Team key — Anthropic · Organization',
            'My key — Anthropic · Personal',
            'Max plan — Claude subscription · Personal',
        ]);
        expect(
            within(inDialog().getByRole('list', { name: 'Connections not offered' })).getByText(
                /OpenAI key is not offered/
            )
        ).toBeTruthy();

        // OpenCode runs OpenAI, not a subscription.
        await user.selectOptions(field('Agent'), OPENCODE);
        expect(optionNames()).toEqual([
            CHOOSE,
            'Team key — Anthropic · Organization',
            'My key — Anthropic · Personal',
            'OpenAI key — OpenAI · Organization',
        ]);
        expect(inDialog().getByRole('list', { name: 'Connections not offered' }).textContent).toContain('Max plan');
    });

    it('offers an organization executor the organization connections only, saying why not the personal ones', async () => {
        stubFetch(boardHandler(board()));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await user.click(await screen.findByRole('button', { name: 'Add organization executor' }));
        await screen.findByRole('dialog', { name: ADD_LABEL });
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        expect(optionNames()).toEqual([CHOOSE, 'Team key — Anthropic · Organization']);
        expect(inDialog().getByRole('list', { name: 'Connections not offered' }).textContent).toContain(
            'An organization executor can only use an organization provider connection.'
        );
    });

    it('switches provider without mutating a shared connection', async () => {
        const shared = board({
            executors: [
                { ...personalExecutor('first'), providerConnectionId: TEAM.id },
                { ...personalExecutor('second'), providerConnectionId: TEAM.id },
            ],
        });
        const calls = stubFetch(boardHandler(shared));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await user.click(await editButton('first'));
        await screen.findByRole('dialog', { name: /^Edit executor$/ });
        await waitFor(() => expect(connectionSelect().value).toBe(TEAM.id));

        await user.selectOptions(connectionSelect(), MINE.id);
        await user.click(button(SAVE_LABEL));
        await dialogGone();

        // Only the edited row's reference moved; its sibling still shares the original, and no connection was written.
        expect(putBody(calls).executors.map((row) => [row.name, row.providerConnectionId])).toEqual([
            ['first', MINE.id],
            ['second', TEAM.id],
        ]);
        expect(connectionWrites(calls)).toEqual([]);
        expect(shared.providerConnections.map((row) => row.name)).toEqual([
            'Team key',
            'My key',
            'OpenAI key',
            'Max plan',
        ]);
    });

    it('discards the previous connection model response', async () => {
        let releaseTeam: (answer: unknown) => void = () => undefined;
        const held = new Promise((resolve) => {
            releaseTeam = resolve;
        });
        stubFetch(
            boardHandler(
                board({ connectionModels: { [TEAM.id]: held as never, [MINE.id]: listedModels('claude-mine-1') } })
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        await user.click(modelRadio(MODEL_CUSTOM_LABEL));

        await user.selectOptions(connectionSelect(), TEAM.id);
        await within(modelGroup()).findByText(/Loading the models Team key offers/);
        await user.selectOptions(connectionSelect(), MINE.id);
        await within(modelGroup()).findByText(/1 model from My key/);

        // The slow answer for the connection the member left arrives last and changes nothing.
        releaseTeam(listedModels('claude-team-1', 'claude-team-2'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(modelGroup().textContent).toContain('1 model from My key');
        expect(modelGroup().textContent).not.toContain('Team key');
        expect(
            [...modelGroup().querySelectorAll('datalist option')].map((option) => option.getAttribute('value'))
        ).toEqual(['claude-mine-1']);
    });

    it('requires reselection for a known incompatible model', async () => {
        const stale = board({
            executors: [
                {
                    ...personalExecutor('router', { model: 'anthropic/claude-sonnet-5-5' }),
                    type: OPENCODE,
                    providerConnectionId: TEAM.id,
                },
            ],
        });
        const calls = stubFetch(boardHandler(stale));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await user.click(await editButton('router'));
        await screen.findByRole('dialog', { name: /^Edit executor$/ });
        await waitFor(() => expect(connectionSelect().value).toBe(TEAM.id));
        expect(customModel().value).toBe('anthropic/claude-sonnet-5-5');

        await user.selectOptions(connectionSelect(), OPENAI.id);

        // The Anthropic-prefixed model is cleared, said, and Save waits for a new choice.
        expect(customModel().value).toBe('');
        expect(modelGroup().textContent).toContain('“anthropic/claude-sonnet-5-5” belongs to another provider');
        expect(button(SAVE_LABEL).disabled).toBe(true);
        expect(describedBy(button(SAVE_LABEL))).toBe(SAVE_HINTS.model);

        await user.type(customModel(), 'openai/gpt-5.1');
        expect(button(SAVE_LABEL).disabled).toBe(false);
        await user.click(button(SAVE_LABEL));
        await dialogGone();
        expect(putBody(calls).executors[0]).toMatchObject({
            providerConnectionId: OPENAI.id,
            config: { model: 'openai/gpt-5.1' },
        });
    });

    it('shows config override notice without credential values', async () => {
        const SECRET = 'sk-ant-pasted-secret-value';
        const pasted = board({
            executors: [
                {
                    ...personalExecutor('pasted', { env: { ANTHROPIC_API_KEY: SECRET } }),
                    providerConnectionId: TEAM.id,
                },
                { ...personalExecutor('clean'), providerConnectionId: TEAM.id },
            ],
        });
        stubFetch(boardHandler(pasted));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');

        await user.click(await editButton('clean'));
        await screen.findByRole('dialog', { name: /^Edit executor$/ });
        await waitFor(() => expect(connectionSelect().value).toBe(TEAM.id));
        expect(inDialog().queryByRole('note')).toBeNull();
        await user.click(button('Cancel'));
        await dialogGone();

        await user.click(await editButton('pasted'));
        await screen.findByRole('dialog', { name: /^Edit executor$/ });
        const notice = await inDialog().findByRole('note');
        expect(notice.textContent).toContain('takes precedence over');
        expect(notice.textContent).toContain('Team key');
        expect(notice.textContent).not.toContain(SECRET);
        // The pasted configuration is never erased on the member's behalf.
        expect(json().value).toContain(SECRET);

        // Another connection the configuration would override names that one instead.
        await user.selectOptions(connectionSelect(), MINE.id);
        expect(inDialog().getByRole('note').textContent).toContain('My key');
    });

    it('has no environment-keys choice: a row with no connection must choose one before it can save', async () => {
        const legacy = board({ executors: [personalExecutor('legacy')] });
        const calls = stubFetch(boardHandler(legacy));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await user.click(await editButton('legacy'));
        await screen.findByRole('dialog', { name: /^Edit executor$/ });
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        expect(optionNames().join('|')).not.toMatch(/environment keys/);
        expect(connectionSelect().value).toBe('');

        await user.click(await inDialog().findByText(ADVANCED_LABEL));
        await user.clear(field('Gate repair rounds'));
        await user.type(field('Gate repair rounds'), '5');
        expect(button(SAVE_LABEL).disabled).toBe(true);
        expect(describedBy(button(SAVE_LABEL))).toBe(SAVE_HINTS.connection);

        await user.selectOptions(connectionSelect(), TEAM.id);
        await user.click(button(SAVE_LABEL));
        await dialogGone();
        expect(putBody(calls).executors[0]).toMatchObject({ providerConnectionId: TEAM.id });
    });

    it('keeps manual model entry when the listing fails, and says so apart from an empty list', async () => {
        const failing = board({
            connectionModels: {
                [TEAM.id]: { state: 'failed', code: 'UPSTREAM', message: 'The provider is unreachable.' },
                [MINE.id]: listedModels(),
            },
        });
        const calls = stubFetch(boardHandler(failing));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        await user.type(field('Name'), 'manual');
        await user.click(modelRadio(MODEL_CUSTOM_LABEL));

        await user.selectOptions(connectionSelect(), TEAM.id);
        await within(modelGroup()).findByText(
            /Could not list the models Team key offers: The provider is unreachable\./
        );
        within(modelGroup()).getByRole('button', { name: 'Retry listing models' });
        // The curated suggestions stand in while the read fails.
        expect(modelGroup().querySelectorAll('datalist option').length).toBeGreaterThan(0);
        await user.type(typedModel(), 'claude-typed-by-hand');

        await user.selectOptions(connectionSelect(), MINE.id);
        await within(modelGroup()).findByText(/My key lists no models\. Type the name of the model to use\./);
        expect(modelGroup().textContent).not.toContain('Could not list');

        await user.selectOptions(connectionSelect(), TEAM.id);
        await within(modelGroup()).findByText(/Could not list the models/);
        await user.click(button(ADD_LABEL));
        await dialogGone();
        expect(putBody(calls).executors[0]).toMatchObject({
            providerConnectionId: TEAM.id,
            config: { model: 'claude-typed-by-hand' },
        });
    });

    it('offers and saves OpenCode model ids the way the server accepts them', async () => {
        const live = board({ connectionModels: { [OPENAI.id]: listedModels('gpt-5.1') } });
        const calls = stubFetch(boardHandler(live));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
        await user.type(field('Name'), 'prefixed');
        await user.selectOptions(field('Agent'), OPENCODE);
        await user.click(modelRadio(MODEL_CUSTOM_LABEL));
        await user.selectOptions(connectionSelect(), OPENAI.id);
        await within(modelGroup()).findByText(/1 model from OpenAI key/);
        expect([...modelGroup().querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual([
            'openai/gpt-5.1',
        ]);
        // A bare name typed by hand is saved prefixed too.
        await user.type(typedModel(), 'gpt-5-mini');
        await user.click(button(ADD_LABEL));
        await dialogGone();
        expect(putBody(calls).executors[0]).toMatchObject({
            providerConnectionId: OPENAI.id,
            config: { model: 'openai/gpt-5-mini' },
        });
    });

    it('shows a failed connection list as an error with a retry, never as no connections', async () => {
        const unavailable = board();
        let answer = false;
        stubFetch(
            boardHandler(unavailable, (call) =>
                call.url === '/api/provider-connections' && !answer
                    ? { status: 503, body: { error: 'No provider connection store for this organization' } }
                    : undefined
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/executors');
        await openAdd(user);
        await inDialog().findByText('No provider connection store for this organization');
        expect(optionNames()).toEqual([CHOOSE]);
        answer = true;
        await user.click(button('Retry loading connections'));
        await waitFor(() => expect(optionNames()).toContain('Team key — Anthropic · Organization'));
    });
});
