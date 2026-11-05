import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followUpThread, runningThread, type ThreadJob } from '../../e2e/fixtures/threads.js';
import { type ComposerDraftStore, EMPTY_FILES } from '../src/composer-draft.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';
import type { FollowUpViewer } from '../src/task-outcome.js';
import { inertDraftStore } from './tasks-fixtures.js';

beforeEach(() => {
    stubResizeObserver();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** A ResizeObserver the test can fire: jsdom never lays out, so it never reports a resize. */
function stubResizeObserver() {
    const watched: Array<{ el: Element; fire: () => void }> = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            private readonly callback: () => void;
            constructor(callback: () => void) {
                this.callback = callback;
            }
            observe(el: Element) {
                watched.push({ el, fire: this.callback });
            }
            unobserve() {}
            disconnect() {}
        }
    );
    return (el: Element) => {
        for (const entry of watched.filter((w) => w.el === el)) entry.fire();
    };
}

const ADMIN: FollowUpViewer = { loading: false, id: 'someone', admin: true };

/** A draft store that actually holds the follow-up draft, so typing survives a re-render. */
function HeldDraft({ jobs }: { jobs: readonly ThreadJob[] }) {
    const [followUps, setFollowUps] = useState<ComposerDraftStore['followUps']>({});
    const store = inertDraftStore({
        followUps,
        saveFollowUp: (scope, draft) => setFollowUps((held) => ({ ...held, [scope]: draft })),
        updateFollowUp: (scope, update) =>
            setFollowUps((held) => ({ ...held, [scope]: update(held[scope] ?? { text: '', ...EMPTY_FILES }) })),
    });
    return <TaskDetailUnder jobs={jobs} store={store} />;
}

function detail(jobs: readonly ThreadJob[]) {
    return <HeldDraft jobs={jobs} />;
}

function TaskDetailUnder({ jobs, store }: { jobs: readonly ThreadJob[]; store: ComposerDraftStore }) {
    return (
        <MemoryRouter>
            <TaskDetail
                header={null}
                controls={null}
                jobs={[...jobs] as never}
                viewer={ADMIN}
                error={null}
                actionError={null}
                followUpError={null}
                sending={false}
                onFollowUp={async () => null}
                draftStore={store}
                onAnswer={async () => ({ state: 'failed', error: 'not wired' })}
                onConnectionChange={() => {}}
            />
        </MemoryRouter>
    );
}

/** jsdom lays nothing out: gives `el` a scroll box the test drives, like a browser would. */
function scrollBox(el: HTMLElement, box: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
    const state = { ...box };
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.clientHeight });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight });
    Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => state.scrollTop,
        set: (value: number) => {
            state.scrollTop = value;
        },
    });
    return state;
}

const withOutput = (jobs: readonly ThreadJob[], output: string): ThreadJob[] =>
    jobs.map((job, i) => (i === jobs.length - 1 ? { ...job, output } : job));

describe('Task detail: the conversation scrolls on its own, the follow-up composer stays put', () => {
    it('names the conversation as its own region, separate from the follow-up form', () => {
        render(detail(followUpThread));
        const conversation = screen.getByRole('region', { name: 'Conversation' });
        const composer = screen.getByRole('textbox', { name: /follow-up/i });
        expect(conversation.contains(composer)).toBe(false);
        expect(composer.closest('.task-follow-up')?.contains(conversation)).toBe(false);
        // One drop zone covers both.
        const zone = conversation.closest('.task-main')!;
        expect(zone.contains(composer)).toBe(true);
    });

    it('names the follow-up input by a hidden label, with no helper copy', () => {
        render(detail(followUpThread));
        const label = screen.getByText('Ask for a follow-up');
        expect(label.tagName).toBe('LABEL');
        expect(label.className).toBe('composer-visually-hidden');
        expect(screen.queryByText(/The agent continues the same task/)).toBeNull();
    });

    it('keeps the reading position when output arrives to a reader scrolled up, and offers Jump to latest', async () => {
        const user = userEvent.setup();
        const view = render(detail(followUpThread));
        const conversation = screen.getByRole('region', { name: 'Conversation' });
        const box = scrollBox(conversation, { clientHeight: 400, scrollHeight: 2000, scrollTop: 300 });
        fireEvent.scroll(conversation);
        const draft = screen.getByRole('textbox', { name: /follow-up/i });
        await user.type(draft, 'keep me');

        box.scrollHeight = 2400;
        view.rerender(detail([...followUpThread, { ...followUpThread[followUpThread.length - 1]!, id: 'next-run' }]));

        expect(box.scrollTop).toBe(300);
        expect((screen.getByRole('textbox', { name: /follow-up/i }) as HTMLTextAreaElement).value).toBe('keep me');
        const jump = screen.getByRole('button', { name: 'Jump to latest' });
        await user.click(jump);
        expect(box.scrollTop).toBe(2400);
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    });

    it('follows new output while the reader sits at the bottom', () => {
        const view = render(detail(followUpThread));
        const conversation = screen.getByRole('region', { name: 'Conversation' });
        const box = scrollBox(conversation, { clientHeight: 400, scrollHeight: 2000, scrollTop: 1600 });
        fireEvent.scroll(conversation);

        box.scrollHeight = 2400;
        view.rerender(detail([...followUpThread, { ...followUpThread[followUpThread.length - 1]!, id: 'next-run' }]));

        expect(box.scrollTop).toBe(2400);
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    });

    it('the live raw-output well keeps its position when a reader scrolled up and follows when at its tail', () => {
        const view = render(detail(runningThread));
        const well = document.querySelector<HTMLElement>('.run-output pre.chat-output')!;
        const box = scrollBox(well, { clientHeight: 320, scrollHeight: 4000, scrollTop: 500 });
        fireEvent.scroll(well);

        box.scrollHeight = 4200;
        view.rerender(detail(withOutput(runningThread, `${runningThread[0]!.output}\nstep 82 running`)));
        expect(box.scrollTop).toBe(500);

        // Back at the tail: the next line is followed.
        box.scrollTop = 3880;
        fireEvent.scroll(well);
        box.scrollHeight = 4400;
        view.rerender(detail(withOutput(runningThread, `${runningThread[0]!.output}\nstep 82 running\nstep 83`)));
        expect(box.scrollTop).toBe(4400);
    });

    it('stops listening when it unmounts', () => {
        const view = render(detail(followUpThread));
        const conversation = screen.getByRole('region', { name: 'Conversation' });
        const removed: string[] = [];
        const original = conversation.removeEventListener.bind(conversation);
        conversation.removeEventListener = ((type: string, ...rest: [never, never]) => {
            removed.push(type);
            return original(type, ...rest);
        }) as typeof conversation.removeEventListener;
        view.unmount();
        expect(removed).toContain('scroll');
    });

    describe('the reader scroll state, not the post-change geometry, decides', () => {
        const running = (output: string): ThreadJob[] => [
            ...followUpThread,
            { ...runningThread[0]!, id: 'live-run', output } as ThreadJob,
        ];

        it('a reader at the bottom stays there when the run ends and the composer shrinks the viewport', () => {
            const fire = stubResizeObserver();
            const view = render(detail(running('a')));
            const conversation = screen.getByRole('region', { name: 'Conversation' });
            const box = scrollBox(conversation, { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 });
            fireEvent.scroll(conversation);

            // The run ends: its response lands, the composer appears, the viewport is shorter.
            box.clientHeight = 450;
            box.scrollHeight = 2100;
            view.rerender(detail([...followUpThread, { ...followUpThread[0]!, id: 'live-run' }]));
            fire(conversation);

            expect(box.scrollTop).toBe(2100);
            expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
        });

        it('offers Jump to latest when output grows only inside the capped live well', () => {
            const view = render(detail(running('a')));
            const conversation = screen.getByRole('region', { name: 'Conversation' });
            const box = scrollBox(conversation, { clientHeight: 400, scrollHeight: 2000, scrollTop: 300 });
            fireEvent.scroll(conversation);

            // The well is at its cap: the outer scroll height does not move.
            view.rerender(detail(running('a\nb\nc')));

            expect(box.scrollTop).toBe(300);
            expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
        });

        it('follows a resize while the reader follows, and leaves a reader who scrolled up alone', () => {
            const fire = stubResizeObserver();
            render(detail(followUpThread));
            const conversation = screen.getByRole('region', { name: 'Conversation' });
            const box = scrollBox(conversation, { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 });
            fireEvent.scroll(conversation);
            box.clientHeight = 450;
            fire(conversation);
            expect(box.scrollTop).toBe(2000);

            box.scrollTop = 200;
            fireEvent.scroll(conversation);
            box.clientHeight = 400;
            fire(conversation);
            expect(box.scrollTop).toBe(200);
        });
    });
});
