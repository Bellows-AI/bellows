import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { VERIFY_URL } from './model-setup-reads.js';
import { boardHandler, listedModels, personalExecutor, providerConnection, settingsBoard } from './settings-board.js';

/**
 * Settings → Model → Provider connections, on the real page over a stubbed board that stores what the connection
 * routes receive: who may change which row, rename versus rotation, the removal refusal, and the four discovery states.
 */

const SECRET = 'sk-ant-api03-brand-new-secret';

const withSetup = (
    board: ReturnType<typeof settingsBoard>,
    extra: Parameters<typeof boardHandler>[1] = () => undefined
) =>
    boardHandler(board, (call) => {
        if (call.method === 'POST' && call.url === VERIFY_URL) {
            return { ok: true, models: ['claude-a', 'claude-b', 'claude-c'] };
        }
        return extra(call);
    });

const panel = async () =>
    (await screen.findByRole('heading', { name: /^Provider connections/ })).closest('section') as HTMLElement;
const row = async (name: string) => within(await panel()).findByRole('row', { name: new RegExp(`^${name}(?![a-z])`) });
const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
const connectionCalls = (calls: { method: string; url: string; body: unknown }[]) =>
    calls.filter(
        (call) => call.method !== 'GET' && call.url.startsWith('/api/provider-connections') && call.url !== VERIFY_URL
    );

describe('Settings → Model: provider connections', () => {
    const org = providerConnection('Team key', { scope: 'org' });
    const mine = providerConnection('My key', { scope: 'personal' });

    it('member can manage own connections but cannot edit organization connections', async () => {
        const board = settingsBoard({ role: MEMBER_ROLE, providerConnections: [org, mine] });
        const calls = stubFetch(withSetup(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');

        // The organization's row can be looked at, not changed.
        const teamRow = await row('Team key');
        expect(within(teamRow).queryByRole('button', { name: 'Edit' })).toBeNull();
        await openMenu(user, 'Team key');
        expect(screen.getByRole('menuitem', { name: 'Show models' })).toBeTruthy();
        expect(screen.queryByRole('menuitem', { name: 'Replace key' })).toBeNull();
        expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
        await user.keyboard('{Escape}');

        // Their own row has the whole set.
        expect(within(await row('My key')).getByRole('button', { name: 'Edit' })).toBeTruthy();
        await openMenu(user, 'My key');
        expect(screen.getByRole('menuitem', { name: 'Replace key' })).toBeTruthy();
        expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy();
        await user.keyboard('{Escape}');

        // A member's new connection is personal: the scope control offers nothing else.
        await user.click(screen.getByRole('button', { name: 'Add connection' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add provider connection' });
        const scope = within(dialog).getByLabelText<HTMLSelectElement>('Who can use it');
        expect(scope.disabled).toBe(true);
        expect([...scope.options].map((option) => option.textContent)).toEqual(['Only me']);

        await user.type(within(dialog).getByLabelText('Name'), 'Side project');
        fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: SECRET } });
        // The existing verify runs first, its model count is shown, and only then may Save run.
        await within(dialog).findByText(/Key works · 3 models available/);
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add provider connection' })).toBeNull());
        expect(connectionCalls(calls)).toEqual([
            expect.objectContaining({
                method: 'POST',
                url: '/api/provider-connections',
                body: { scope: 'personal', name: 'Side project', provider: 'anthropic', key: SECRET },
            }),
        ]);
        await row('Side project');
        // The key never comes back: nothing on the page carries it.
        expect(document.body.textContent).not.toContain(SECRET);
    });

    it('lets an admin add an organization connection and edit one', async () => {
        const board = settingsBoard({ role: ADMIN_ROLE, providerConnections: [org] });
        const calls = stubFetch(withSetup(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        await user.click(await screen.findByRole('button', { name: 'Add connection' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add provider connection' });
        await user.selectOptions(within(dialog).getByLabelText('Who can use it'), 'org');
        await user.type(within(dialog).getByLabelText('Name'), 'Shared key');
        fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: SECRET } });
        await within(dialog).findByText(/Key works/);
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add provider connection' })).toBeNull());
        expect(connectionCalls(calls)[0]?.body).toMatchObject({ scope: 'org', name: 'Shared key' });

        await user.click(within(await row('Team key')).getByRole('button', { name: 'Edit' }));
        expect(await screen.findByRole('dialog', { name: 'Edit provider connection' })).toBeTruthy();
    });

    describe('the Claude subscription provider follows whether the org may use one', () => {
        const addDialog = async (session: { deploymentMode: 'self-hosted' | 'cloud'; subscriptionToken: boolean }) => {
            stubFetch(withSetup(settingsBoard({ role: ADMIN_ROLE, ...session })));
            const user = userEvent.setup({ delay: null });
            renderApp('/settings/model');
            await user.click(await screen.findByRole('button', { name: 'Add connection' }));
            const dialog = await screen.findByRole('dialog', { name: 'Add provider connection' });
            within(dialog).getByRole('radio', { name: /^Anthropic/ });
            return dialog;
        };
        const subscription = (dialog: HTMLElement) =>
            within(dialog).queryByRole('radio', { name: /^Claude subscription/ });

        it('is offered self-hosted', async () => {
            expect(
                subscription(await addDialog({ deploymentMode: 'self-hosted', subscriptionToken: true }))
            ).toBeTruthy();
        });

        it('is offered to a cloud org the operator allows', async () => {
            expect(subscription(await addDialog({ deploymentMode: 'cloud', subscriptionToken: true }))).toBeTruthy();
        });

        it('is hidden from any other cloud org, and a pasted token stays refused', async () => {
            const dialog = await addDialog({ deploymentMode: 'cloud', subscriptionToken: false });
            expect(subscription(dialog)).toBeNull();
            fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'sk-ant-oat01-abc' } });
            expect(subscription(dialog)).toBeNull();
            await within(dialog).findByText(/This deployment accepts API keys only/);
        });
    });

    it('rename omits key while explicit rotation verifies and replaces it', async () => {
        const board = settingsBoard({ providerConnections: [mine], connectionKeys: { [mine.id]: 'sk-ant-old-key' } });
        const calls = stubFetch(withSetup(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');

        // Rename: no key field exists, and the write carries only what changed.
        await user.click(within(await row('My key')).getByRole('button', { name: 'Edit' }));
        const edit = await screen.findByRole('dialog', { name: 'Edit provider connection' });
        expect(within(edit).queryByLabelText('API key')).toBeNull();
        await user.clear(within(edit).getByLabelText('Name'));
        await user.type(within(edit).getByLabelText('Name'), 'Renamed key');
        await user.click(within(edit).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit provider connection' })).toBeNull());
        expect(connectionCalls(calls).at(-1)).toMatchObject({
            method: 'PUT',
            url: `/api/provider-connections/${mine.id}`,
            body: { name: 'Renamed key' },
        });
        expect(connectionCalls(calls).at(-1)?.body).not.toHaveProperty('key');
        expect(board.connectionKeys[mine.id]).toBe('sk-ant-old-key');
        expect(calls.filter((call) => call.url === VERIFY_URL)).toHaveLength(0);

        // Rotation: its own action, the new key verified first, then replaced — and nothing else sent.
        await openMenu(user, 'Renamed key');
        await user.click(screen.getByRole('menuitem', { name: 'Replace key' }));
        const rotate = await screen.findByRole('dialog', { name: 'Replace key' });
        const save = within(rotate).getByRole('button', { name: 'Replace key' });
        expect((save as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(within(rotate).getByLabelText('API key'), { target: { value: SECRET } });
        await within(rotate).findByText(/Key works · 3 models available/);
        expect(calls.find((call) => call.url === VERIFY_URL)?.body).toMatchObject({
            provider: 'anthropic',
            key: SECRET,
        });
        await user.click(save);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replace key' })).toBeNull());
        expect(connectionCalls(calls).at(-1)?.body).toEqual({ key: SECRET });
        expect(board.connectionKeys[mine.id]).toBe(SECRET);
        expect(document.body.textContent).not.toContain(SECRET);
    });

    it('removal refusal names only visible executors', async () => {
        const board = settingsBoard({
            providerConnections: [org],
            executors: [{ ...personalExecutor('first'), providerConnectionId: org.id }],
        });
        const user = userEvent.setup({ delay: null });
        stubFetch(
            withSetup(board, (call) =>
                call.method === 'DELETE' && call.url === `/api/provider-connections/${org.id}`
                    ? {
                          status: 409,
                          body: {
                              error: 'in use',
                              code: 'PROVIDER_CONNECTION_IN_USE',
                              executors: [
                                  { name: 'first', scope: 'personal' },
                                  { name: 'team-runner', scope: 'org' },
                              ],
                              otherReferences: true,
                          },
                      }
                    : undefined
            )
        );
        renderApp('/settings/model');
        await row('Team key');
        await openMenu(user, 'Team key');
        await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
        const confirm = await screen.findByRole('dialog', { name: 'Remove this connection?' });
        await user.click(within(confirm).getByRole('button', { name: 'Remove connection' }));

        const refusal = await screen.findByText(/is still used by first \(personal\), team-runner \(organization\)/);
        expect(refusal.textContent).toContain('Executors you cannot see also use it');
        // The row stays: a refusal never removes it.
        await row('Team key');
    });

    it('removes an unreferenced connection after confirming', async () => {
        const board = settingsBoard({ providerConnections: [mine] });
        const calls = stubFetch(withSetup(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        await row('My key');
        await openMenu(user, 'My key');
        await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
        const confirm = await screen.findByRole('dialog', { name: 'Remove this connection?' });
        await user.click(within(confirm).getByRole('button', { name: 'Remove connection' }));
        await screen.findByText(
            'No provider connections yet. Add one to share a key between executors without pasting it into each.'
        );
        expect(connectionCalls(calls)).toEqual([expect.objectContaining({ method: 'DELETE' })]);
    });

    it('separates empty discovery unsupported discovery and failed discovery', async () => {
        const empty = providerConnection('Empty one');
        const unsupported = providerConnection('Router', { provider: 'openrouter' });
        const failed = providerConnection('Broken one');
        const listed = providerConnection('Listed one');
        const board = settingsBoard({
            providerConnections: [empty, unsupported, failed, listed],
            connectionModels: {
                [empty.id]: listedModels(),
                [unsupported.id]: { state: 'unsupported', creditUsd: 3 },
                [failed.id]: { state: 'failed', code: 'UPSTREAM', message: 'The provider is unreachable.' },
                [listed.id]: listedModels('claude-one', 'claude-two'),
            },
        });
        stubFetch(withSetup(board));
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        await row('Empty one');

        const show = async (name: string) => {
            await openMenu(user, name);
            await user.click(screen.getByRole('menuitem', { name: 'Show models' }));
            return screen.findByRole('region', { name: `Models from ${name}` });
        };

        const emptyView = await show('Empty one');
        await within(emptyView).findByText(/answered, and it lists no models/);
        expect(emptyView.textContent).not.toContain('Could not list');
        expect(emptyView.textContent).not.toContain('does not list');

        const unsupportedView = await show('Router');
        await within(unsupportedView).findByText(/OpenRouter does not list its models/);
        expect(unsupportedView.textContent).not.toContain('lists no models');

        const failedView = await show('Broken one');
        await within(failedView).findByText(
            /Could not list the models Broken one offers: The provider is unreachable\./
        );
        within(failedView).getByRole('button', { name: 'Try again' });
        expect(failedView.textContent).not.toContain('lists no models');

        const listedView = await show('Listed one');
        await within(listedView).findByText('2 models available.');
        expect(
            within(listedView)
                .getAllByRole('listitem')
                .map((item) => item.textContent)
        ).toEqual(['claude-one', 'claude-two']);
    });

    it('shows a failed connection read as an error with a retry, never as an empty list', async () => {
        const board = settingsBoard({ providerConnections: [mine] });
        let answer = false;
        stubFetch(
            withSetup(board, (call) =>
                call.url === '/api/provider-connections' && !answer
                    ? { status: 503, body: { error: 'No provider connection store for this organization' } }
                    : undefined
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        const section = await panel();
        await within(section).findByText('No provider connection store for this organization');
        expect(within(section).queryByText(/No provider connections yet/)).toBeNull();
        answer = true;
        await user.click(within(section).getByRole('button', { name: 'Retry' }));
        await row('My key');
    });

    const REFRESH_FAILURE = 'No provider connection store for this organization';

    it('never says there are no connections while the refresh after the first create failed', async () => {
        const board = settingsBoard({ providerConnections: [] });
        let failReads = false;
        stubFetch(
            withSetup(board, (call) =>
                call.method === 'GET' && call.url === '/api/provider-connections' && failReads
                    ? { status: 503, body: { error: REFRESH_FAILURE } }
                    : undefined
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        const section = await panel();
        await within(section).findByText(/No provider connections yet/);

        await user.click(within(section).getByRole('button', { name: 'Add connection' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add provider connection' });
        await user.type(within(dialog).getByLabelText('Name'), 'First one');
        fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: SECRET } });
        await within(dialog).findByText(/Key works/);
        failReads = true;
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        // The write succeeded, but the re-read failed: the failure and its Retry show, and no empty verdict does.
        await within(section).findByText(REFRESH_FAILURE);
        expect(within(section).getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(within(section).queryByText(/No provider connections yet/)).toBeNull();
        failReads = false;
        await user.click(within(section).getByRole('button', { name: 'Retry' }));
        await row('First one');
        expect(within(section).queryByText(REFRESH_FAILURE)).toBeNull();
    });

    it('keeps the cached rows and shows the failure and Retry when a refresh of a non-empty list fails', async () => {
        const board = settingsBoard({ providerConnections: [mine] });
        let failReads = false;
        stubFetch(
            withSetup(board, (call) =>
                call.method === 'GET' && call.url === '/api/provider-connections' && failReads
                    ? { status: 503, body: { error: REFRESH_FAILURE } }
                    : undefined
            )
        );
        const user = userEvent.setup({ delay: null });
        renderApp('/settings/model');
        await row('My key');
        await user.click(within(await panel()).getByRole('button', { name: 'Add connection' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add provider connection' });
        await user.type(within(dialog).getByLabelText('Name'), 'Second');
        fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: SECRET } });
        await within(dialog).findByText(/Key works/);
        failReads = true;
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        const section = await panel();
        await within(section).findByText(REFRESH_FAILURE);
        expect(within(section).getByRole('button', { name: 'Retry' })).toBeTruthy();
        // The rows already held are the last true answer and stay, but the failure is never hidden behind them.
        await row('My key');
    });
});
