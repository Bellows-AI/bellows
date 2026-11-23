import type { PullRequestAnswer, PullRequestAsk } from '../../src/board/board-pull-request.js';
import type { PullRequestPort } from '../../src/publish/publish-pr.js';

/** One PR as the fake board holds it. */
export interface FakePr {
    number: number;
    url: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
}

/**
 * The board's PR write as the driver's tests see it (`POST /api/jobs/:id/pull-request`): it views by head before it
 * creates, retargets and edits an existing PR, and records every ask. Three faults, each on the NEXT call:
 * `lostAnswer` (the effect lands and the call throws, as a dropped connection does), `down` (throws with no effect)
 * and `answer` (a fixed answer in place of the board's work: a wait, a refusal, an App-less board).
 */
export function fakePullRequests(options: { existing?: Partial<FakePr>[] } = {}) {
    const state = {
        prs: [] as FakePr[],
        asks: [] as PullRequestAsk[],
        creates: 0,
        lostAnswer: false,
        down: false,
        answer: null as PullRequestAnswer | null,
    };
    const open = (pr: Partial<FakePr>): FakePr => {
        const number = pr.number ?? state.prs.length + 1;
        const made = {
            number,
            url: `https://github.com/Bellows-AI/bellows/pull/${number}`,
            branch: 'fix/10',
            base: 'main',
            title: 'opened by someone',
            body: '',
            draft: false,
            ...pr,
        };
        state.prs.push(made);
        return made;
    };
    for (const pr of options.existing ?? []) open(pr);

    const port: PullRequestPort = async (ask) => {
        state.asks.push(ask);
        if (state.down) throw new Error('the board is unreachable');
        const fixed = state.answer;
        if (fixed) return fixed;
        let pr = state.prs.find((p) => p.branch === ask.branch);
        let operation: 'created' | 'reused' = 'reused';
        if (!pr && ask.create) {
            state.creates += 1;
            pr = open({ branch: ask.branch, ...ask.create });
            operation = 'created';
        } else if (pr) {
            if (ask.base !== null) pr.base = ask.base;
            Object.assign(pr, ask.edit ?? {});
        }
        if (state.lostAnswer) {
            state.lostAnswer = false;
            throw new Error('the answer was lost');
        }
        return pr ? { kind: 'pr', url: pr.url, number: pr.number, operation } : { kind: 'none' };
    };
    return { state, port };
}
