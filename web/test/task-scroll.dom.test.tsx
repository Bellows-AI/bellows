import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { followUpThread, runningThread, type ThreadJob } from '../../e2e/fixtures/threads.js';
import { type ComposerDraftStore, EMPTY_FILES } from '../src/composer-draft.js';
import { TaskDetail } from '../src/panels/TaskDetail.js';
import type { FollowUpViewer } from '../src/task-outcome.js';
import { inertDraftStore } from './tasks-fixtures.js';

afterEach(cleanup);

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
});
