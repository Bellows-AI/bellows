import { OBJECTIVE_MODE, WORKFLOW_MODE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { job, renderDetail } from './tasks-fixtures.js';
import { expectNoPlaceholder } from './fixtures.js';

/** The right column's own markup — the main column below may repeat a word in its own voice. */
const railOf = (html: string): string => html.slice(html.indexOf('task-rail'), html.indexOf('task-main'));

/** A run whose output carries the driver's publish line, so the Outcome tile renders. */
const PUBLISHED = '[driver] published fix/44 — https://github.com/o/r/pull/9';

describe('TaskOutcome', () => {
    it('renders above the conversation in DOM order, as an expanded native disclosure', () => {
        const html = renderDetail({ jobs: [job({ output: PUBLISHED })] });
        expect(html.indexOf('task-outcome')).toBeGreaterThan(-1);
        expect(html.indexOf('task-outcome')).toBeLessThan(html.indexOf('task-conversation'));
        expect(html).toMatch(/<details class="panel task-section task-outcome" open/);
        expect(html).toContain('<h2>Outcome</h2>');
        // The conversation names itself too: heading-by-heading navigation has to reach the
        // page's dominant panel, not just the summary beside it.
        expect(html).toMatch(/task-conversation[^>]*"[^>]*>[\s\S]{0,80}?<h2>Conversation<\/h2>/);
    });

    it('shows the current status, the closure attribution and the newest terminal exit', () => {
        const html = renderDetail({
            jobs: [
                job({ status: 'failed', exitCode: 1 }),
                job({
                    id: '22222222-2222-4222-8222-222222222222',
                    status: 'stopped',
                    exitCode: 0,
                    doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null },
                    stoppedBy: { id: 'u', login: 'lee', name: null, avatarUrl: null },
                }),
            ],
        });
        // The rail carries the state and the newest exit; the closure attribution is each run's own note.
        const rail = railOf(html);
        expect(rail).toContain('Stopped');
        expect(rail).toMatch(/<dt>Exit<\/dt><dd>0<\/dd>/);
        expect(rail).not.toContain('done by kim');
        expect(html).toContain('done by kim');
        expect(html).toContain('stopped by lee');
    });

    it('explains an open PR-review wait: what Bellows is waiting for, since when, and that no executor is occupied', () => {
        const html = renderDetail({
            jobs: [
                job({
                    status: 'queued',
                    waitReason: 'review',
                    waitingSince: '2026-09-01T11:00:00.000Z',
                    exitCode: null,
                    finishedAt: null,
                }),
            ],
        });
        expect(html).toContain('Waiting for review');
        // The controls tile's pill: the shared label in its tone.
        expect(railOf(html)).toMatch(
            /<span class="pill pill-done task-pill-wait" aria-live="polite">.*Waiting for review/
        );
        // That pill is the page's one live region; a second would announce every change twice.
        expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
        expect(html).toMatch(/no executor|not occupied/i);
        expect(html).toContain('Bellows is waiting for review');
        expect(html).not.toContain('Factory');
    });

    it('shows no wait explanation once the task is done, even while its review wait is still open', () => {
        const html = renderDetail({
            jobs: [
                job({
                    status: 'succeeded',
                    waitReason: 'review',
                    waitingSince: '2026-09-01T11:00:00.000Z',
                    doneAt: '2026-09-01T13:00:00.000Z',
                    doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null },
                }),
            ],
        });
        const rail = railOf(html);
        expect(rail).not.toContain('Waiting for review');
        expect(rail).not.toContain('no executor is occupied');
        expect(rail).toMatch(/<span class="pill pill-done task-pill-done" aria-live="polite">.*Done<\/span>/);
        expect(html).toContain('done by kim');
        // No follow-up is offered on the closed task.
        expect(html).not.toContain('<textarea');
    });

    it('shows the terminal wait reason once the review wait has ended, beside the ordinary result', () => {
        const html = renderDetail({
            jobs: [
                job({
                    status: 'succeeded',
                    waitReason: 'review',
                    waitTerminalReason: 'exhausted',
                }),
            ],
        });
        expect(html).toContain('exhausted');
        // A terminal wait does not relabel the pill as waiting — its reason rides the label.
        expect(railOf(html)).toContain('Succeeded · Needs review · exhausted');
    });

    it('renders no waiting copy at all for a thread that never entered a wait', () => {
        const html = renderDetail({ jobs: [job()] });
        expect(html).not.toContain('Waiting for review');
        expect(html).not.toContain('no executor is occupied');
    });

    it('names the root author as Started by, unknown when nobody is recorded', () => {
        const author = { id: 'u', login: 'kim', name: 'Kim Doe', avatarUrl: 'https://x/a.png' };
        const started = renderDetail({ jobs: [job({ author })] });
        expect(started).toContain('Started by');
        expect(started).toContain('Kim Doe');
        expect(started).toContain('https://x/a.png');
        const unknown = renderDetail({ jobs: [job()] });
        expect(unknown).toContain('Started by');
        expect(unknown).toContain('unknown');
    });

    it('carries the task wall clock under the em-dash convention', () => {
        const banked = renderDetail({ jobs: [job({ taskWallClockMs: 3_600_000 })] });
        expect(banked).toContain('1h');
        const unbanked = renderDetail({ jobs: [job()] });
        expect(unbanked).toContain('Wall clock');
    });

    // Issue #733: environment.setup time is its own row beside the wall clock, absent when none ran.
    it('shows the setup time apart from the wall clock, and no row when no setup ran', () => {
        const setUp = renderDetail({ jobs: [job({ taskWallClockMs: 7_200_000, setupMs: 1_800_000 })] });
        expect(setUp).toContain('Environment setup');
        expect(setUp).toContain('30m');
        expect(renderDetail({ jobs: [job({ taskWallClockMs: 7_200_000 })] })).not.toContain('Environment setup');
    });

    // Issue #796: an interrupted attempt is refunded, and the rail says so apart from the result.
    it('lists each interruption with its time, reason and claim', () => {
        const rail = railOf(
            renderDetail({
                jobs: [
                    job({
                        interruptions: [
                            { at: '2026-09-01T12:05:00.000Z', reason: 'the driver was drained', claimSeq: 1 },
                        ],
                    }),
                ],
            })
        );
        expect(rail).toContain('Interruptions');
        expect(rail).toContain('not counted as failed attempts');
        expect(rail).toContain('Claim 1: the driver was drained');
        expect(rail).toContain('dateTime="2026-09-01T12:05:00.000Z"');
    });

    it('renders no Interruptions section when nothing was interrupted', () => {
        expect(railOf(renderDetail({ jobs: [job()] }))).not.toContain('Interruptions');
    });

    it('renders repository, executor — omitting the absent rows, and never a Worktree row', () => {
        const html = renderDetail({
            jobs: [
                job({
                    repo: 'acme/web',
                    workspacePath: 'repos/web',
                    executor: 'main',
                    workflowName: 'fix-issue',
                    workflowNode: 'implement',
                }),
            ],
        });
        expect(html).toContain('Repository');
        expect(html).toContain('acme/web');
        // The payload still carries the path; the page no longer prints it (#777).
        expect(html).not.toContain('Worktree');
        expect(html).not.toContain('repos/web');
        expect(html).toContain('Executor');
        expect(html).toContain('main');
        expect(html).toContain('Workflow');
        expect(html).toContain('fix-issue');
        expect(html).toContain('Workflow node');
        expect(html).toContain('implement');

        const bare = renderDetail({ jobs: [job()] });
        expect(bare).not.toContain('Repository');
        expect(bare).not.toContain('Worktree');
        expect(bare).not.toContain('Workflow node');
        expect(bare).not.toContain('fix-issue');
    });

    it('shows the base branch the task started from, and Default when it started from none', () => {
        expect(renderDetail({ jobs: [job({ baseBranch: 'release/1.2' })] })).toContain('release/1.2');
        const none = renderDetail({ jobs: [job({ baseBranch: null })] });
        expect(none).toContain('Base branch');
        expect(none).toContain('Default');
    });

    it('names an absent executor selection explicitly', () => {
        expect(renderDetail({ jobs: [job()] })).toContain('No executor selected');
    });

    it('renders the frozen workflow name and the node as different concepts', () => {
        const html = renderDetail({ jobs: [job({ workflowName: 'fix-issue', workflowNode: 'implement' })] });
        const name = html.indexOf('fix-issue');
        const node = html.indexOf('implement');
        expect(name).toBeGreaterThan(-1);
        expect(node).toBeGreaterThan(-1);
        expect(name).not.toBe(node);
    });

    it("shows the thread's mode in the Execution section, and no gate-repair row", () => {
        const objective = renderDetail({ jobs: [job({ mode: OBJECTIVE_MODE })] });
        expect(objective).toContain('Mode');
        expect(objective).toContain('objective');
        expect(objective).not.toContain('Gate repair');

        const workflow = renderDetail({ jobs: [job({ mode: WORKFLOW_MODE, workflowName: 'fix-issue' })] });
        expect(workflow).toContain('Mode');
        expect(workflow).toContain('workflow');
        expect(workflow).not.toContain('Gate repair');
    });

    it('shows thread context and cost, and fabricates neither', () => {
        const measured = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: 3000,
                        costUsd: 0.01,
                    },
                }),
            ],
        });
        expect(measured).toContain('3,000 tok');
        expect(measured).toContain('$0.0100');

        const bare = renderDetail({ jobs: [job()] });
        expect(bare).not.toContain('Context');
        expect(bare).not.toContain('Cost');
        expect(bare).not.toContain('0 tok');
        expect(bare).not.toContain('$0.00');
    });
});

describe('TaskOutcome — gates, publication and services', () => {
    it('summarizes the NEWEST run gates only, with words carrying the meaning', () => {
        const gates = [
            { name: 'test', status: 'passed' as const, exitCode: 0, output: 'test gate output' },
            { name: 'lint', status: 'failed' as const, exitCode: 1, output: 'bad' },
            { name: 'build', status: 'running' as const, exitCode: null, output: null },
        ];
        const html = renderDetail({
            jobs: [job({ gates }), job({ id: '44444444-4444-4444-8444-444444444444', gates: null })],
        });
        expect(html).not.toContain('<h2>Verification</h2>');
        const counted = renderDetail({ jobs: [job({ gates })] });
        // The counts ride the Verification tile's head, so a shut tile still says them.
        expect(counted).toMatch(/<h2>Verification<\/h2><span class="task-section-aside">[\s\S]*1 failed/);
        expect(counted).toContain('1 passed');
        expect(counted).toContain('1 failed');
        expect(counted).toContain('1 running');
        // Gate output appears once, in the Verification tile.
        expect(counted.match(/test gate output/g)).toHaveLength(1);
    });

    it('renders the published branch code-styled, linking only a safe url', () => {
        const linked = renderDetail({
            jobs: [job({ output: '[driver] published fix/44 — https://github.com/o/r/pull/9' })],
        });
        expect(linked).toMatch(/<code class="task-branch">[\s\S]*?fix\/44<\/code>/);
        // The link is a reference, not a command: the labeled row carries just the number, and the
        // tile's head says which PR while it is shut — as text, never a link inside the summary.
        const outcome = linked.slice(linked.indexOf('task-outcome'), linked.indexOf('task-main'));
        expect(outcome).toContain('>#9</a>');
        expect(outcome).toContain('<span class="task-section-aside">PR #9</span>');
        expect(linked).not.toContain('Open pull request');
        expect(linked).toContain('rel="noopener noreferrer"');
        expect(linked).not.toContain('PR state');
        expect(outcome).toContain('aria-label="Copy branch name"');

        const unsafe = renderDetail({
            jobs: [job({ output: '[driver] published fix/5 — javascript:alert(1)' })],
        });
        expect(unsafe).toMatch(/<code class="task-branch">[\s\S]*?fix\/5<\/code>/);
        expect(unsafe).not.toContain('<a href="javascript:');
    });

    it('links a publish url that names no number as Pull request, never a CTA verbatim', () => {
        const html = renderDetail({
            jobs: [job({ output: '[driver] published fix/6 — https://github.com/o/r/compare/main...fix/6' })],
        });
        expect(html).toContain('<a href="https://github.com/o/r/compare/main...fix/6"');
        expect(html).toContain('>Pull request</a>');
        expect(html).not.toContain('Pull request #');
        expect(html).not.toContain('Open pull request');
    });

    it('shows a branch without a url as the branch alone', () => {
        const html = renderDetail({ jobs: [job({ output: '[driver] published task/20260910' })] });
        expect(html).toMatch(/<code class="task-branch">[\s\S]*?task\/20260910<\/code>/);
        expect(html).not.toContain('Pull request');
    });

    it('links the issue only when the repository makes the url constructible', () => {
        const linked = renderDetail({ jobs: [job({ repo: 'acme/web', command: 'fix #44 please' })] });
        expect(linked).not.toContain('Open issue');
        expect(linked).toContain('href="https://github.com/acme/web/issues/44"');
        expect(linked).toContain('>#44</a>');
        const unlinked = renderDetail({ jobs: [job({ command: 'fix #44 please' })] });
        expect(unlinked).not.toContain('Open issue');
        expect(unlinked).toContain('#44');
    });
});

describe('TaskOutcome — services and the placeholder sweep', () => {
    it('shows why a dead service died: its exit, reason, hint and log tail (issue #487)', () => {
        const html = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services: [
                            {
                                name: 'test-mongo',
                                image: 'mongo:8.0.11',
                                state: 'failed',
                                exitCode: 1,
                                reason: 'Error',
                                logTail: 'error: failed switching to "mongodb"\n',
                                hint: 'declare unhardened: true',
                            },
                            { name: 'test-redis', image: 'redis:6.2.6', state: 'running' },
                        ],
                    },
                }),
            ],
        });
        expect(html).toContain('test-mongo failed — exit 1 (Error)');
        expect(html).toContain('failed switching to &quot;mongodb&quot;');
        expect(html).toContain('declare unhardened: true');
        expect(html).not.toContain('test-redis running —');
    });

    it('renders the newest attempt services as last-reported states, collapsing past three', () => {
        const services = [
            { name: 'postgres', image: 'postgres', state: 'running' },
            { name: 'api', image: 'api', state: 'exited' },
            { name: 'web', image: 'web', state: 'running' },
        ];
        const html = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services,
                    },
                }),
            ],
        });
        expect(html).toContain('postgres');
        expect(html).toContain('exited');
        const more = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services: [...services, { name: 'db2', image: 'db2', state: 'running' }],
                    },
                }),
            ],
        });
        expect(more).toContain('and 1 more');
        // An older attempt's fleet is long gone — the outcome reads the newest attempt only.
        const stale = renderDetail({
            jobs: [
                job({
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
                    },
                }),
                job({ id: '22222222-2222-4222-8222-222222222222' }),
            ],
        });
        expect(stale).not.toContain('Services');
        expect(stale).not.toContain('<dt>db</dt>');
        expect(renderDetail({ jobs: [job()] })).not.toContain('Services');
    });

    it('never emits placeholder values anywhere in the outcome', () => {
        const html = renderDetail({
            jobs: [
                job({
                    author: { id: 'u', login: 'kim', name: null, avatarUrl: null },
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: null }],
                    output: '[driver] published fix/44 — https://github.com/o/r/pull/9',
                    runtime: {
                        cpuPercent: null,
                        memUsedMb: null,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: 100,
                        costUsd: 0.5,
                    },
                    workflowName: 'fix-issue',
                    workflowNode: 'implement',
                    repo: 'acme/web',
                    workspacePath: 'repos/web',
                }),
            ],
        });
        expectNoPlaceholder(html);
    });
});

/**
 * A failure's next step is the controls tile's primary action — the rail carries it once, and no
 * Outcome "Next action" repeats it.
 */
describe('TaskOutcome — next action on a failure', () => {
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'octo-reviewer', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id, admin: false };
    const failedGate = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'nope' }];

    it('asks for another pass once, in the controls tile, when the viewer may send one', () => {
        for (const latest of [job({ status: 'failed', author: me }), job({ author: me, gates: failedGate })]) {
            const html = renderDetail({ jobs: [latest], viewer });
            expect(railOf(html), latest.status).not.toContain('Next action');
            expect(html.match(/>Ask for another pass<\/button>/g), latest.status).toHaveLength(1);
        }
    });

    it("explains another member's failure once, in the follow-up slot", () => {
        const html = renderDetail({ jobs: [job({ status: 'failed', author: other })], viewer });
        const sentence = 'Only octo-reviewer can continue this session. You can still mark it done.';
        expect(railOf(html)).not.toContain(sentence);
        expect(railOf(html)).not.toContain('Ask for another pass');
        expect(html.match(new RegExp(sentence, 'g'))).toHaveLength(1);
    });
});
