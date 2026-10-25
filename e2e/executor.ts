import { CLAUDE_CODE } from '@factory-ai/core';
import { expect, type Locator, type Page } from '@playwright/test';
import { ADD_LABEL } from '../web/src/workspace/executors.js';
import { queuedThread } from './fixtures/threads.js';

/** The one executor the composer specs start tasks with. No driver runs here, so nothing resolves it. */
export const E2E_EXECUTOR = {
    name: 'e2e-executor',
    type: CLAUDE_CODE,
    createdAt: '2026-01-01T00:00:00.000Z',
};

/** The member's resolved default the poll carries (issue 391): the one executor, by scope. */
export const E2E_DEFAULT_EXECUTOR = { scope: 'user' as const, name: E2E_EXECUTOR.name };

/** The executor as `mockExecutors` holds it: the list row with its (empty) configuration. */
export const E2E_EXECUTOR_ROW = { ...E2E_EXECUTOR, config: {} };

/**
 * The one tracked repository the composer specs launch against. The open board's repo list is
 * whatever its database holds, so `trackRepos` stands the list in and `stubLaunch` answers the launch.
 */
export const E2E_REPO = { owner: 'acme', name: 'web' };

/**
 * A composer context chip by its `Field: value` name. `getByLabel(field)` substring-matches the
 * chip's `About <field>` help trigger too.
 */
export const contextChip = (scope: Page | Locator, field: 'Repository' | 'Executor'): Locator =>
    scope.getByRole('button', { name: new RegExp(`^${field}: `) });

const E2E_LAUNCHED_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Answers `POST /api/jobs` with the board's 201. The real board revalidates the repository against
 * its own tracked list, and this open board's is empty, so a launch the spec means to succeed is
 * acknowledged here instead of reaching it. The detail page the launch lands on reads
 * that id's thread, which the board never stored: it is answered as a queued thread, not a 404.
 */
export async function stubLaunch(page: Page): Promise<void> {
    await page.route('**/api/jobs', (route) =>
        route.request().method() === 'POST'
            ? route.fulfill({ status: 201, json: { id: E2E_LAUNCHED_ID, status: 'queued' } })
            : route.fallback()
    );
    const launched = queuedThread.map((job) => ({ ...job, id: E2E_LAUNCHED_ID, rootJobId: E2E_LAUNCHED_ID }));
    await page.route(`**/api/jobs/${E2E_LAUNCHED_ID}/thread*`, (route) => route.fulfill({ json: { jobs: launched } }));
}

/** Serves `/api/repos` with exactly these repositories as the board's tracked list. */
export async function trackRepos(page: Page, repos: { owner: string; name: string }[]): Promise<void> {
    await page.route('**/api/repos', (route) =>
        route.fulfill({
            json: {
                repos: repos.map((repo) => ({ ...repo, private: false, defaultBranch: 'main', pushedAt: null })),
                installation: null,
                meta: { fetchedAt: null, error: null },
            },
        })
    );
}

/**
 * Give the page one configured executor.
 *
 * A task cannot start without one (docs/workspace.md), and the open board deliberately has no
 * executor profile, so its `/api/workspace` always answers `executors: []` and Start stays dark
 * behind "Configure an executor". Only the lists are replaced: the rest of the answer is the real
 * server's. The board refuses a task whose executor its scope does not hold (#1019), so a spec
 * whose launch reaches the real `POST /api/jobs` also saves the executor with `saveExecutor`.
 * The tracked list carries `E2E_REPO`.
 */
export async function withExecutor(page: Page): Promise<void> {
    await page.route('**/api/workspace', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
            response,
            json: {
                ...body,
                executors: [E2E_EXECUTOR],
                orgExecutors: [],
                defaultExecutor: E2E_DEFAULT_EXECUTOR,
            },
        });
    });
    await trackRepos(page, [E2E_REPO]);
}

/**
 * Save `E2E_EXECUTOR` as the member's real executor profile, so the board's own create accepts a
 * task naming it. The open board starts with none, and the other specs rely on that: pair it with
 * `clearExecutors` once the spec is done.
 */
export async function saveExecutor(page: Page): Promise<void> {
    const response = await page.request.put('/api/workspace/executors', {
        data: { executors: [{ name: E2E_EXECUTOR.name, type: E2E_EXECUTOR.type, config: {} }] },
    });
    expect(response.status(), 'the open board saves the member’s executor').toBe(200);
}

/** Put the open board back to no executor profile, the state every other spec starts from. */
export async function clearExecutors(page: Page): Promise<void> {
    const response = await page.request.put('/api/workspace/executors', { data: { executors: [] } });
    expect(response.status(), 'the open board clears the member’s executors').toBe(200);
}

/** One executor profile as the mocked workspace holds it — the config-bearing list row. */
export interface MockExecutor {
    name: string;
    type: string;
    createdAt: string;
    /** The gate-repair budget the dialog's config read requires on every row it opens with. */
    gateFixRounds?: number;
    config: object;
}

/**
 * A workspace whose executor list the test owns: a mutable list, served to the poll, the dialog's
 * config read and its whole-list PUT alike; everything else is the real server's answer. `repos`,
 * when given, is the tracked list `/api/repos` answers with.
 */
export async function mockExecutors(
    page: Page,
    initial: MockExecutor[],
    repos: { owner: string; name: string }[] = []
): Promise<{ executors: MockExecutor[] }> {
    const held = { executors: initial };
    if (repos.length > 0) await trackRepos(page, repos);
    await page.route('**/api/workspace', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        const executors = held.executors.map(({ config: _config, ...row }) => row);
        await route.fulfill({
            response,
            json: {
                ...body,
                executors,
                orgExecutors: [],
                // The server's own fallback chain (issue 391) resolves the default to the first
                // personal row, so the mock names the row it actually holds — a fixed name would
                // answer a default the list no longer carries.
                defaultExecutor:
                    held.executors.length > 0 ? { scope: 'user' as const, name: held.executors[0]!.name } : null,
            },
        });
    });
    await page.route('**/api/workspace/executors', async (route) => {
        if (route.request().method() === 'PUT') {
            const { executors } = route.request().postDataJSON() as { executors: Omit<MockExecutor, 'createdAt'>[] };
            held.executors = executors.map((row) => ({ ...row, createdAt: E2E_EXECUTOR.createdAt }));
        }
        await route.fulfill({ json: { executors: held.executors } });
    });
    return held;
}

/** Every `POST /api/jobs` the page sends — the round trip must launch exactly once. */
export function countLaunches(page: Page): { bodies: unknown[] } {
    const seen = { bodies: [] as unknown[] };
    page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
            seen.bodies.push(request.postDataJSON());
        }
    });
    return seen;
}

/**
 * Add an executor the way a member does with no JSON at all (issue 261): open the dialog from the
 * page header, type a name, keep the default agent and the runner's default model, and save —
 * which saves the inherited configuration, `{}`.
 */
export async function addExecutorViaDialog(page: Page, name: string): Promise<void> {
    await page.getByRole('button', { name: ADD_LABEL }).click();
    const dialog = page.getByRole('dialog', { name: ADD_LABEL });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: ADD_LABEL }).click();
    await expect(dialog).toHaveCount(0);
}
