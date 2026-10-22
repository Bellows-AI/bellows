import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseRepos } from '../src/api/useRepos.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { type ComposerDraftInput, ComposerDraftProvider } from '../src/composer-draft.js';
import { WorkflowParameterFields } from '../src/components/WorkflowParameterFields.js';
import { TaskComposerPage } from '../src/pages/TaskComposerPage.js';
import { TaskDetailPage } from '../src/pages/TaskDetailPage.js';
import type { WorkflowParamChoice } from '../src/task-composer.js';
import { renderComposer } from './tasks-fixtures.js';
import { expectNoPlaceholder, idleTasks } from './fixtures.js';

describe('the tasks pages', () => {
    /**
     * Page-level renders through a real route tree: the pages read the tasks poll and the
     * workspace poll from the area's outlet context, both stubbed idle — effects never fire
     * under renderToStaticMarkup, so the loading posture is what a static render can see. The
     * point here is the page headings: one h1 per page, no competing inner title.
     */
    const fakeTasks = idleTasks();
    const idleWorkspace = {
        data: null,
        loading: true,
        error: null,
        saving: false,
        saveExecutors: async () => null,
        listExecutorConfigs: async () => null,
    } as unknown as UseWorkspace;
    const idleRepos = { data: null, loading: true, error: null, refresh: () => {} } as unknown as UseRepos;

    const renderPage = (path: string, sessionLoading = false) =>
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[path]}>
                {/* The shell's draft store, as AppShell mounts it around the routed page. */}
                <ComposerDraftProvider session={null}>
                    <Routes>
                        <Route
                            element={
                                <Outlet
                                    context={{
                                        tasks: fakeTasks,
                                        workspace: idleWorkspace,
                                        repos: idleRepos,
                                        sessionLoading,
                                    }}
                                />
                            }
                        >
                            <Route path="tasks">
                                <Route index element={<TaskComposerPage />} />
                                <Route path=":id" element={<TaskDetailPage />} />
                            </Route>
                        </Route>
                    </Routes>
                </ComposerDraftProvider>
            </MemoryRouter>
        );

    it('holds the composer behind a skeleton until the session is known, so nothing restores early', () => {
        const html = renderPage('/tasks', true);
        expect(html).toContain('<h1>New task</h1>');
        expect(html).toContain('composer-skeleton');
        expect(html).toContain('aria-busy="true"');
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('Loading your workspace');
    });

    it('the composer page names itself "New task" under the Tasks eyebrow, once', () => {
        const html = renderPage('/tasks');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>New task</h1>');
        expect(html).toContain('page-header-eyebrow');
        expect(html).not.toContain('<h2>Tasks</h2>');
        // No routine description repeating what the composer itself shows (#571).
        expect(html).not.toContain('page-header-description');
    });

    it('the detail page keeps the plain Tasks heading until the thread lands', () => {
        const html = renderPage('/tasks/22222222-2222-4222-8222-222222222222');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>Tasks</h1>');
    });
});

describe('TaskComposer', () => {
    it('waits for the workspace before offering any choice', () => {
        const html = renderComposer({ workspaceLoaded: false });
        expect(html).toMatch(/Loading your workspace/);
        expect(html).not.toContain('<textarea');
    });

    it('says so, with a way back in, when the workspace could not be loaded', () => {
        const html = renderComposer({ workspaceLoaded: false, workspaceError: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
        expect(html).toContain('Retry');
    });

    // "Not known" and "confirmed empty" are different sentences: a repository read that is still
    // out, failed, or answered with a named error must never read as "no repositories are tracked".
    it('waits for the repositories read, without claiming none are tracked', () => {
        const html = renderComposer({ repos: null });
        expect(html).toMatch(/Loading repositories/);
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('No repositories tracked');
    });

    it('names a failed or errored repositories read, with a retry, and never calls it empty', () => {
        const html = renderComposer({ repos: null, reposError: 'GitHub is unreachable' });
        expect(html).toContain('GitHub is unreachable');
        expect(html).toContain('Retry');
        expect(html).not.toContain('No repositories tracked');
        expect(html).not.toContain('<textarea');
    });

    it('says no repositories are tracked only for a confirmed empty list', () => {
        const html = renderComposer({ repos: [], restored: restoredDraft({ draft: 'fix it' }) });
        expect(html).toContain('No repositories tracked');
        expect(html).not.toContain('Loading repositories');
    });

    it('offers one repository option per selection, first repository selected by default', () => {
        // The composer stamps the task with a repo. The default is the FIRST selected repository —
        // a member who picked repositories means their tasks to be stamped with one, not with
        // nothing; with none selected the trigger asks for a selection (issue 263), as the
        // executor select does for its own empty list.
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
        });
        // The Listbox server-renders the trigger only — the options are client-side — so the
        // trigger's text is the selected repository, and the visible label names the control.
        const repoTrigger = html.slice(html.indexOf('Repository'), html.indexOf('Executor'));
        expect(repoTrigger).toContain('>acme/web</span></button>');
        expect(repoTrigger).not.toContain('acme/api');
        const none = renderComposer({ repos: [] });
        const noneTrigger = none.slice(none.indexOf('Repository'), none.indexOf('Executor'));
        expect(noneTrigger).toContain('>Select a repository</span></button>');
    });

    // A task always runs through a configured profile. The first is selected initially; with no
    // profiles the composer names the missing requirement and cannot start.
    it('preselects the first configured executor and blocks when there is none', () => {
        const trigger = (html: string) => html.slice(html.indexOf('Executor'), html.indexOf('>Start task<'));

        const one = renderComposer({ repos: [], executors: [{ name: 'main', type: 'claude', scope: 'user' }] });
        expect(trigger(one)).toContain('>main</span></button>');

        const two = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude', scope: 'user' },
                { name: 'heavy', type: 'claude', scope: 'user' },
            ],
        });
        expect(trigger(two)).toContain('>main</span></button>');

        const empty = renderComposer({ repos: [], executors: [] });
        expect(trigger(empty)).toContain('>No executor configured</span></button>');
    });

    it('preselects the poll-resolved default over the first row (issue 215, the preference by 391)', () => {
        const trigger = (html: string) => html.slice(html.indexOf('Executor'), html.indexOf('>Start task<'));

        const html = renderComposer({
            repos: [],
            executors: [
                { name: 'main', type: 'claude', scope: 'user' },
                { name: 'heavy', type: 'claude', scope: 'user' },
            ],
            defaultExecutor: { name: 'heavy', scope: 'user' },
        });
        expect(trigger(html)).toContain('>heavy</span></button>');
    });

    it('keeps the composer reachable when no repository is tracked, and says where to fix that', () => {
        // The launch itself is blocked by the no-repos verdict, tested below; the banner under the
        // prompt points at Settings.
        const html = renderComposer({ repos: [], restored: restoredDraft({ draft: 'fix it' }) });
        expect(html).toContain('<textarea');
        expect(html).toContain('>Start task<');
        expect(html).toContain('href="/settings/repos?return=/tasks/new"');
        // aria-label, not aria-labelledby: the ListboxButton's label context overrides a
        // labelledby that points outside it, so each select carries its name directly (issue 190).
        // The workflow select renders only once a workflows list exists, so this render carries one.
        // The chip shows only its value, so the name carries the field AND the visible value
        // (label in name, #571): a speech-input member can say what they see.
        const withWorkflows = renderComposer({
            repos: [],
            executors: [{ name: 'main', type: 'claude', scope: 'user' }],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        expect(withWorkflows).toContain('aria-label="Repository: Select a repository"');
        expect(withWorkflows).toContain('aria-label="Executor: main"');
        expect(withWorkflows).toContain('aria-label="Reusable workflow: No workflow"');
    });
});

describe('TaskComposer — the prompt and the launch', () => {
    it('asks what the agent should do, and shows the example without prefilling it', () => {
        const html = renderComposer({});
        expect(html).toContain('What should the agent do?');
        expect(html).toContain('Include the outcome, relevant files or issue, and checks to run.');
        expect(html).toContain(
            'placeholder="Example: Fix issue #123, update the affected tests, and run the relevant checks."'
        );
        // The example is the placeholder, never the value: an empty textarea carries no text.
        expect(html).not.toContain('>Example: Fix issue #123');
    });

    it('starts against a selected, ready repository, saying nothing routine: the chips show what will run (#571)', () => {
        const html = renderComposer({ restored: restoredDraft({ draft: 'fix it' }) });
        expect(html).not.toContain('banner-bad');
        expect(html).not.toContain('banner-info');
        const start = html.match(/<button type="button" class="primary"[^>]*>Start task<\/button>/)?.[0] ?? '';
        expect(start).not.toContain('aria-describedby');
        expect(start).not.toContain('disabled');
    });

    it('labels the launch and its shortcut, and the in-flight state too', () => {
        const idle = renderComposer({});
        expect(idle).toContain('>Start task</button>');
        expect(idle).toContain('<kbd');
        const busy = renderComposer({ sending: true });
        expect(busy).toContain('>Starting…</button>');
        expect(busy).toContain('Starting the task…');
    });

    it("shows the board's refusal in place, as an alert, with the draft intact", () => {
        const html = renderComposer({ actionError: 'Could not queue the task (503)' });
        expect(html).toContain('Could not queue the task (503)');
        expect(html).toContain('role="alert"');
        expect(html).toContain('<textarea');
    });

    it('never emits a placeholder value', () => {
        const html = renderComposer({
            repos: [{ owner: 'acme', name: 'web' }],
            executors: [{ name: 'main', type: 'claude', scope: 'user' }],
            actionError: null,
        });
        expectNoPlaceholder(html);
    });

    it('hides the workflow chip when no workflow list is given', () => {
        // No list, no process to pick: the selector and anything about workflow details are absent.
        const html = renderComposer({ workflows: null });
        expect(html).not.toContain('Reusable workflow');
        expect(html.match(/class="composer-context-item"/g) ?? []).toHaveLength(2);
        expect(html).not.toContain('Workflow details');
    });

    // An unnamed task resolves NO workflow — the member's words are the whole command, so nothing
    // param-shaped may sit in the markup before the member picks a process by name. Unchosen means
    // NO process: the trigger reads the empty option's label. The offered names are client-side;
    // e2e/composer.spec.ts drives the real dropdown.
    it.each<[string, Parameters<typeof renderComposer>[0], string[], string[]]>([
        [
            'runs the raw prompt when no workflow is chosen: no params, no gate',
            {
                repos: [],
                workflows: [
                    { id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] },
                ],
            },
            ['<textarea'],
            ['composer-param'],
        ],
        [
            // The default view stays terse — no repeated-explanation sentence beside a compact
            // control that already shows its own selected value.
            'offers the workflow dropdown beside repo and executor, unchosen by default',
            {
                workflows: [
                    { id: 'w1', name: 'fix-issue', scope: 'org' },
                    { id: 'w2', name: 'mine', scope: 'user' },
                ],
            },
            ['Reusable workflow', '<span class="composer-context-value">No workflow</span></button>'],
            [],
        ],
    ])('%s', (_label, input, has, lacks) => {
        const html = renderComposer(input);
        for (const text of has) expect(html).toContain(text);
        for (const text of lacks) expect(html).not.toContain(text);
    });

    it('gathers repository, executor and workflow as one row of chips, with no section around them', () => {
        const html = renderComposer({
            repos: [{ owner: 'acme', name: 'web' }],
            executors: [{ name: 'main', type: 'claude', scope: 'user' }],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        expect(html).toContain('class="composer-context"');
        expect(html.match(/class="composer-context-item"/g) ?? []).toHaveLength(3);
        // The full value stays reachable off the truncated trigger through the title attribute,
        // beside the listbox itself.
        expect(html).toContain('title="acme/web"');
        expect(html).toContain('title="main"');
    });
});

describe('the workflow parameter fields', () => {
    // The chosen workflow's declared parameters: one labelled input each, plain-language states,
    // and the raw rule locked inside Format details. Touched state is a prop — the composer owns
    // it, the fields render it — so every state a keystroke or a blur can produce is renderable
    // here without a DOM.
    const issue: WorkflowParamChoice = {
        name: 'issue',
        pattern: '#\\d+',
        description: 'The issue to fix, as #123 or a full issues URL.',
        example: '#123',
    };
    const plain: WorkflowParamChoice = { name: 'notes' };
    const renderFields = (
        params: WorkflowParamChoice[],
        values: Record<string, string> = {},
        touched: Record<string, boolean> = {}
    ) =>
        renderToStaticMarkup(
            <WorkflowParameterFields
                params={params}
                values={values}
                touched={touched}
                onInput={() => {}}
                onBlur={() => {}}
            />
        );

    it('labels each field with the humanized name and pairs it by id', () => {
        const html = renderFields([plain]);
        expect(html).toContain('>Notes</label>');
        expect(html).toContain('for="composer-param-notes"');
        expect(html).toContain('id="composer-param-notes"');
    });

    it('renders the author description and example where a member meets them', () => {
        // The guidance Slice C 1/4 serves: the description beside the field, the example as the
        // placeholder the empty input shows — never a prefill.
        const html = renderFields([issue]);
        expect(html).toContain('id="composer-param-issue-helper"');
        expect(html).toContain('The issue to fix, as #123 or a full issues URL.');
        expect(html).toContain('placeholder="Example: #123"');
        expect(html).not.toContain('>Example: #123<');
    });

    it('says Required on an untouched empty field without painting it failed', () => {
        const html = renderFields([plain]);
        expect(html).toContain('placeholder="Required"');
        expect(html).not.toContain('aria-invalid');
        expect(html).not.toContain('-error');
    });

    it('tells a touched empty field it is required, by name, as an error', () => {
        const html = renderFields([plain], {}, { notes: true });
        expect(html).toContain('aria-invalid="true"');
        expect(html).toContain('aria-describedby="composer-param-notes-error"');
        expect(html).toContain('id="composer-param-notes-error"');
        expect(html).toContain('Notes is required.');
    });

    it('shows the raw pattern only inside Format details, never in a title or an error', () => {
        const html = renderFields([issue], { issue: 'not an issue' }, { issue: true });
        expect(html).toContain('<summary>Format details</summary>');
        expect(html).toContain('<code>#\\d+</code>');
        expect(html).not.toContain('title=');
        // Once per render, and only inside the disclosure: the count is the pin.
        expect(html.split('#\\d+').length - 1).toBe(1);
    });

    it('gives two invalid fields two distinct error descriptions', () => {
        const html = renderFields([plain, issue], {}, { notes: true, issue: true });
        // The plain field has no helper, so its description is the error alone; the guided one
        // lists its helper first and its error second — both unique per field.
        expect(html).toContain('aria-describedby="composer-param-notes-error"');
        expect(html).toContain('composer-param-issue-helper composer-param-issue-error');
        expect(html).toContain('Notes is required.');
        expect(html).toContain('Issue is required.');
    });

    it('carries no error state once every value validates', () => {
        const html = renderFields([issue], { issue: '#12' }, { issue: true });
        expect(html).not.toContain('aria-invalid');
        expect(html).not.toContain('-error"');
    });

    it('never emits a placeholder value', () => {
        const html = renderFields([issue], { issue: '#12' }, { issue: true });
        expectNoPlaceholder(html);
    });
});

describe('the redesigned composer (#280)', () => {
    const START = /<button type="button" class="primary"[^>]*>Start task<\/button>/;
    const startButton = (html: string) => html.match(START)?.[0] ?? '';

    it('makes the prompt the one surface: no numbered steps, no secondary cards (#571)', () => {
        const html = renderComposer({ workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }] });
        expect(html).not.toContain('<h2');
        for (const title of ['Workflow details', 'Readiness']) {
            expect(html).not.toContain(title);
        }
        expect(html.match(/class="panel /g) ?? []).toHaveLength(1);
        expect(html).toContain('<label for="composer-prompt">What should the agent do?</label>');
    });

    it('puts the context chips and Start inside the prompt panel, after the textarea', () => {
        const html = renderComposer({
            restored: restoredDraft({ draft: 'fix it' }),
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org' }],
        });
        const order = [
            'class="panel composer-prompt"',
            '<textarea',
            'class="composer-bar"',
            'aria-label="Repository: acme/web"',
            'aria-label="Executor: main"',
            'aria-label="Reusable workflow: No workflow"',
            '>Start task<',
        ].map((marker) => html.indexOf(marker));
        expect(order.every((at) => at >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // The chips show their value, not a visible field label beside it.
        expect(html).not.toContain('class="composer-label"');
    });

    it('expands a chosen workflow’s parameters below the prompt, not in a card of their own', () => {
        const html = renderComposer({
            restored: restoredDraft({ draft: 'fix it', workflow: 'fix-issue' }),
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] }],
        });
        expect(html.match(/class="composer-context-item"/g) ?? []).toHaveLength(3);
        expect(html.indexOf('id="composer-param-issue"')).toBeGreaterThan(html.indexOf('class="composer-bar"'));
        expect(html.match(/class="panel /g) ?? []).toHaveLength(1);
    });

    describe('the repository must be tracked and chosen', () => {
        const draft = (patch: Partial<ComposerDraftInput> = {}) => restoredDraft({ draft: 'fix it', ...patch });

        const NONE_TRACKED = [
            'No repositories tracked',
            'Track a repository in Settings to run a task.',
            'href="/settings/repos?return=/tasks/new"',
        ];

        type Row = {
            label: string;
            input: Parameters<typeof renderComposer>[0];
            /** Start is held (true) or clickable (false); absent = not asserted. */
            disabled?: boolean;
            has?: string[];
            lacks?: string[];
        };

        const rows: Row[] = [
            {
                label: 'holds Start when the tracked list is confirmed empty, and says why',
                input: { repos: [], restored: draft() },
                disabled: true,
                has: NONE_TRACKED,
            },
            {
                label: 'does not claim "no repositories tracked" while the read is out',
                input: { repos: null, restored: draft() },
                lacks: ['No repositories tracked', '>Start task<'],
            },
            {
                label: 'does not claim "no repositories tracked" when the read failed',
                input: { repos: null, reposError: 'Request failed (503)', restored: draft() },
                has: ['Request failed (503)'],
                lacks: ['No repositories tracked', '>Start task<'],
            },
            {
                label: 'requires a selection when repositories are tracked but none is chosen',
                input: {
                    repos: [{ owner: 'acme', name: 'web' }],
                    restored: draft({ repo: '', repoTouched: true }),
                },
                disabled: true,
                has: ['No repository selected'],
                lacks: ['No repositories tracked'],
            },
            {
                label: 'lets any tracked repository launch: there is no sync state to wait on',
                input: {
                    repos: [
                        { owner: 'acme', name: 'web' },
                        { owner: 'acme', name: 'api' },
                    ],
                    restored: draft({ repo: 'acme/api', workflowRepo: 'acme/api' }),
                },
                disabled: false,
                lacks: ['No repositories tracked', 'not synced', 'No repository selected'],
            },
        ];

        it.each(rows.map((row) => [row.label, row] as const))(
            '%s',
            (_label, { input, disabled, has = [], lacks = [] }) => {
                const html = renderComposer(input);
                if (disabled === true) expect(startButton(html)).toContain('disabled=""');
                if (disabled === false) expect(startButton(html)).not.toContain('disabled=""');
                for (const text of has) expect(html).toContain(text);
                for (const text of lacks) expect(html).not.toContain(text);
            }
        );
    });

    it('explains the repository and executor beside their chips, keeping the values visible', () => {
        const html = renderComposer({});
        for (const [value, help] of [
            ['aria-label="Repository: acme/web"', 'aria-label="About Repository"'],
            ['aria-label="Executor: main"', 'aria-label="About Executor"'],
        ] as const) {
            expect(html).toContain(value);
            expect(html.indexOf(help)).toBeGreaterThan(html.indexOf(value));
        }
    });

    it('counts the request against the board limit, and blocks it red past the limit', () => {
        const fresh = renderComposer({});
        expect(fresh).toContain('0 / 16,384');
        expect(fresh).not.toContain('composer-counter is-over');

        const over = renderComposer({ restored: restoredDraft({ draft: 'x'.repeat(16_385) }) });
        expect(over).toContain('16,385 / 16,384');
        expect(over).toContain('composer-counter is-over');
        expect(over).toContain('class="banner-bad"');
        expect(over).toContain('Request too long');
        expect(startButton(over)).toContain('disabled=""');
    });

    it('opens a fresh composer with Start disabled and no red banner: the empty prompt is quiet status text', () => {
        // The composer starts empty, which is exactly the state a fresh render has — and a dark
        // button with no reason on screen is a task that cannot start.
        const html = renderComposer({});
        const LOOKBEHIND_CHARS = 200;
        const start = html.slice(html.indexOf('>Start task<') - LOOKBEHIND_CHARS, html.indexOf('>Start task<'));
        expect(start).toContain('disabled');
        expect(html).not.toContain('banner-bad');
        expect(html).not.toContain('banner-info');
        expect(html).toContain('Describe the task to continue.');
        expect(startButton(html)).toContain('aria-describedby="composer-blocker"');
    });

    it('raises the missing executor as a red banner with the way to fix it, and points Start at it', () => {
        const html = renderComposer({ executors: [] });
        const banner = html.slice(html.indexOf('class="banner-bad"'));
        expect(banner).toContain('No executor configured');
        expect(banner).toContain('href="/settings/executors?return=/tasks/new"');
        expect(banner).toContain('Add an executor in Settings');
        expect(html).toContain('id="composer-readiness"');
        expect(startButton(html)).toContain('aria-describedby="composer-readiness"');
        expect(startButton(html)).toContain('disabled=""');
    });

    it('raises incomplete workflow details as a red banner', () => {
        const html = renderComposer({
            restored: restoredDraft({ draft: 'fix it', workflow: 'fix-issue' }),
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] }],
        });
        expect(html).toContain('class="banner-bad" id="composer-readiness"');
        expect(html).toContain('Complete the required workflow details to continue.');
    });

    it('holds Start while a restored workflow waits for its list — its parameters are not known yet', () => {
        // Before the list answers, the chosen name declares nothing, so the empty-params gate
        // would pass vacuously and launch `fix-issue` without the `#12` the member typed.
        const html = renderComposer({
            workflows: null,
            restored: restoredDraft({
                draft: 'fix it',
                workflow: 'fix-issue',
                storedParams: { workflowId: 'w1', values: { issue: '#12' } },
            }),
        });
        expect(startButton(html)).toContain('disabled=""');
        expect(html).toContain('class="banner-info" id="composer-readiness"');
        expect(html).toContain('Loading the fix-issue workflow…');
        expect(html).not.toContain('banner-bad');
    });

    it('restores a held draft exactly: request, workflow, params and step overrides', () => {
        const html = renderComposer({
            repos: [
                { owner: 'acme', name: 'web' },
                { owner: 'acme', name: 'api' },
            ],
            executors: [
                { name: 'main', type: 'claude-code', scope: 'user' },
                { name: 'heavy', type: 'claude-code', scope: 'user' },
            ],
            workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [{ name: 'issue', pattern: '#\\d+' }] }],
            restored: restoredDraft({
                draft: 'fix the login crash',
                executor: 'heavy',
                repo: 'acme/api',
                repoTouched: true,
                workflowRepo: 'acme/api',
                workflow: 'fix-issue',
                storedParams: { workflowId: 'w1', values: { issue: '#12' } },
            }),
        });
        expect(html).toContain('>fix the login crash</textarea>');
        expect(html).toContain('title="heavy"');
        expect(html).toContain('title="acme/api"');
        expect(html).toContain('>fix-issue</span></button>');
        expect(html).toContain('value="#12"');
        expect(startButton(html)).not.toContain('disabled=""');
    });
});

/** A held draft for the default fixture lists (acme/web, main), with any field overridden. */
function restoredDraft(overrides: Partial<ComposerDraftInput>): ComposerDraftInput {
    return {
        draft: '',
        executor: 'main',
        executorScope: 'user',
        repo: 'acme/web',
        repoTouched: false,
        workflowRepo: 'acme/web',
        workflow: '',
        storedParams: { workflowId: null, values: {} },
        paramTouched: {},
        ...overrides,
    };
}
