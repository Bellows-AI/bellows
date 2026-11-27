import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker/docker-runner.js';
import { lookupHelper, type HelperPlan } from '../src/helpers.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review/review-helpers.js';
import { syncFailureHalt } from '../src/loop/loop-fence.js';
import { CREDENTIAL_HELPER, credentialHelperOf, FORGE_STEP_CREDENTIAL_HELPER } from '../src/publish/publish-base.js';
import { gitProbeScript, publishCheckout, type SyncResult } from '../src/publish/publish.js';
import { cloneHostRefusal, usesForgeMailbox } from '../src/repo-ref.js';
import { forgeHostsOf } from '../src/claim.js';
import { gitlabForgeHost, serveGateToken } from '../src/gate-token-control.js';
import { createStepBroker, stepLost, type StepSink } from '../src/step-control.js';
import { runHelperStep, runSyncStep, supervisedStepRunner } from '../src/supervised-steps.js';
import { type StepRequest, type StepResult, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { restoreTaskTree } from '../src/task-restore.js';
import { fakePullRequests } from './fixtures/fake-pull-requests.js';
import { githubRef } from './fixtures/repo-ref.js';
import { withTaskVolume } from './fixtures/task-volume-daemon.js';
import { k8sSyncRun } from './k8s-sync-step.js';

/**
 * A GitLab repository's git steps over the supervisor's forge mailbox (docs/connections.md): the member's token
 * is fetched on demand by the step's own git, through the helper the supervisor serves, so no step env and no
 * claim env ever carries one. Each step that reaches the remote names the host (`forgeHost`) and its git runs the
 * forge credential helper CODE; an ask the board leaves unanswered or waiting is a wait, never a fault.
 */

const USER = '44444444-4444-4444-8444-444444444444';
/** A token that must reach no step: given where a GitHub job would take one, and on the claim. */
const SENTINEL = 'glpat-SENTINEL-never-in-a-step';
const TOKEN_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN'];
const HOST = 'gitlab.example.com';
const config = loadDriverConfig({});

const gitlabJob = (over: Partial<BoardJob> = {}): BoardJob =>
    ({
        id: '11111111-1111-4111-8111-111111111111',
        rootJobId: '11111111-1111-4111-8111-111111111111',
        command: 'fix the failing build',
        rootCommand: 'fix the failing build',
        attempts: 1,
        maxAttempts: 3,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        ingestToken: '33333333-3333-4333-8333-333333333333',
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt: 'Factory execution contract (factory-master-prompt/v1)',
        resumeSessionId: null,
        followUp: false,
        ownSession: false,
        continuesInterrupted: false,
        userId: USER,
        workspacePath: `bellows/${USER}`,
        repo: { forge: 'gitlab', host: 'GitLab.Example.com', path: 'group/sub/widgets' },
        env: { GITLAB_TOKEN: SENTINEL, GITHUB_TOKEN: SENTINEL, MEMBER_VAR: 'member' },
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
        ...over,
    }) as BoardJob;
const githubJob = (over: Partial<BoardJob> = {}): BoardJob => gitlabJob({ repo: githubRef('acme/widgets'), ...over });

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const unanswered: StepResult = {
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: auth',
    timedOut: false,
    tokenAskUnanswered: true,
};

/** A sink recording each step; `answer` is the supervisor's result for it. */
function sink(answer: (step: StepRequest) => StepResult = () => ok('{"ok":true,"reason":null}')) {
    const steps: StepRequest[] = [];
    const impl: StepSink = {
        submit: async (_token, step) => {
            steps.push(step);
            return answer(step);
        },
        awaitReport: () => new Promise(() => undefined),
        agentEnded: () => undefined,
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { steps, sink: impl, host: { config, sink: impl } };
}

/** No step carries a token: no value holds the sentinel, and no token-bearing name is set at all. */
function expectTokenless(steps: StepRequest[]): void {
    for (const step of steps) {
        for (const value of Object.values(step.env)) expect(value).not.toContain(SENTINEL);
        for (const name of TOKEN_NAMES) expect(step.env).not.toHaveProperty(name);
        expect(JSON.stringify(step)).not.toContain(SENTINEL);
    }
}

describe('which jobs use the forge mailbox', () => {
    it('is a GitLab job, never a GitHub one or a repo-less one', () => {
        expect(usesForgeMailbox(gitlabJob())).toBe(true);
        expect(usesForgeMailbox(githubJob())).toBe(false);
        expect(usesForgeMailbox({ repo: null })).toBe(false);
    });

    it('gives a GitLab job the forge helper code and a GitHub job the token helper', () => {
        expect(credentialHelperOf(gitlabJob())).toBe(FORGE_STEP_CREDENTIAL_HELPER);
        expect(credentialHelperOf(githubJob())).toBe(CREDENTIAL_HELPER);
        expect(FORGE_STEP_CREDENTIAL_HELPER).not.toContain('GITHUB_TOKEN');
    });

    it('refuses no GitLab host — the board decided which are connected — and GitHub only off github.com', () => {
        expect(cloneHostRefusal({ forge: 'gitlab', host: HOST, path: 'group/sub/widgets' })).toBeNull();
        expect(cloneHostRefusal({ forge: 'github', host: 'github.com', path: 'o/n' })).toBeNull();
        expect(cloneHostRefusal({ forge: 'github', host: 'ghe.example', path: 'o/n' })).toContain('ghe.example');
    });
});

describe('the startup sync of a GitLab job', () => {
    it('names the lowercased host, runs the forge helper and carries no token, a passed one included', async () => {
        const s = sink();
        expect(await runSyncStep(s.host, gitlabJob(), SENTINEL)).toEqual({ ok: true, reason: null });
        const [sync] = s.steps;
        expect(sync).toMatchObject({ kind: 'sync', forgeHost: HOST });
        expect(sync!.env).toMatchObject({
            CRED_HELPER: FORGE_STEP_CREDENTIAL_HELPER,
            REMOTE: `https://GitLab.Example.com/group/sub/widgets.git`,
            MEMBER_VAR: 'member',
        });
        expectTokenless(s.steps);
    });

    it('restores a continuing claim as before: no remote, no host, no helper', async () => {
        const s = sink();
        await runSyncStep(
            s.host,
            gitlabJob({ followUp: true, resumeSessionId: '55555555-5555-4555-8555-555555555555' })
        );
        const [sync] = s.steps;
        expect(sync!.env.RESTORE).toBe('1');
        expect(sync).not.toHaveProperty('forgeHost');
        expect(sync!.env).not.toHaveProperty('CRED_HELPER');
    });

    it('answers a credential ask left unanswered or waiting as a forge wait, never a sync failure', async () => {
        const s = sink(() => ({
            ...unanswered,
            stdout: '{"ok":false,"reason":"clone failed","kind":"missing_base_branch"}',
        }));
        const result = await runSyncStep(s.host, gitlabJob());
        expect(result).toMatchObject({ ok: false, kind: 'forge_wait' });
    });

    it('keeps a GitHub job on its token: GITHUB_TOKEN and the token helper, no forge host', async () => {
        const s = sink();
        await runSyncStep(s.host, githubJob(), 'ghs_minted');
        const [sync] = s.steps;
        expect(sync).not.toHaveProperty('forgeHost');
        expect(sync!.env).toMatchObject({ GITHUB_TOKEN: 'ghs_minted', CRED_HELPER: CREDENTIAL_HELPER });
    });
});

describe('a forge wait ends the attempt as an interruption', () => {
    it('hands the attempt back outside the budget: never a fault, never a verdict', () => {
        const halt = syncFailureHalt(
            { ok: false, reason: 'the credential ask waits', kind: 'forge_wait' },
            gitlabJob()
        );
        expect(halt).toMatchObject({
            halt: 'interrupt',
            blocked: true,
            reason: expect.stringContaining('the GitLab credential could not be confirmed; the task waits and resumes'),
        });
        expect(halt).not.toHaveProperty('verdict');
    });
});

describe('the checkpoint restore of a GitLab job', () => {
    const owed = () => {
        const job = gitlabJob({ followUp: true });
        job.taskRestore = { checkpoint: { id: 'cp', chunks: [] } as never, older: [], restored: false };
        return job;
    };

    it('fetches through the mailbox: the host, the forge helper, no token', async () => {
        const s = sink();
        expect(
            await restoreTaskTree(s.host, owed(), { githubToken: SENTINEL, removeOlder: async () => undefined })
        ).toEqual({
            ok: true,
            reason: null,
        });
        expect(s.steps[0]).toMatchObject({ kind: 'sync', forgeHost: HOST });
        expect(s.steps[0]!.env.CRED_HELPER).toBe(FORGE_STEP_CREDENTIAL_HELPER);
        expectTokenless(s.steps);
    });

    it('answers an unanswered ask as a forge wait, never checkpoint_unrestorable, and owes the restore still', async () => {
        const job = owed();
        const s = sink(() => ({
            ...unanswered,
            stdout: '{"ok":false,"reason":"the clone failed","kind":"checkpoint_unrestorable"}',
        }));
        const result = await restoreTaskTree(s.host, job, { removeOlder: async () => undefined });
        expect(result).toMatchObject({ ok: false, kind: 'forge_wait' });
        expect(job.taskRestore?.restored).toBe(false);
    });
});

/** A supervisor's answers to a dirty-tree publish, by what each step is; `push` answers each push in turn. */
function publishSupervisor(push: StepResult[] = [ok()], lsRemote = ok('')) {
    const sha = 'a'.repeat(40);
    const pushes = [...push];
    return sink((step) => {
        const argv = step.argv;
        const has = (word: string) => argv.includes(word);
        if (argv[2] === gitProbeScript) {
            return ok(
                JSON.stringify({
                    cloned: true,
                    branch: 'main',
                    defaultBranch: 'main',
                    dirty: true,
                    unpushed: 0,
                    hasIdentity: false,
                })
            );
        }
        if (has('push')) return pushes.shift() ?? ok();
        if (has('ls-remote')) return lsRemote;
        if (has('rev-list')) return ok('0\n');
        if (has('rev-parse')) return ok(`${sha}\n`);
        if (step.env.ACTION) return ok(step.env.ACTION === 'read' ? '{}' : '');
        if (has('switch')) return has('-c') ? ok() : { exitCode: 1, stdout: '', stderr: '', timedOut: false };
        if (argv[2]?.includes('shortstat')) return ok(JSON.stringify({ title: 'Fix it', body: '## Commits' }));
        return ok();
    });
}

const networkSteps = (steps: StepRequest[]) =>
    steps.filter((step) => step.argv.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg)));

describe('the publish of a GitLab job', () => {
    const publish = (s: ReturnType<typeof sink>, job: BoardJob, token?: string) =>
        publishCheckout(
            job,
            { pullRequests: fakePullRequests().port },
            supervisedStepRunner(s.host, job, { kind: 'publish', githubToken: token })
        );

    it('asks a taken-over attempt’s push as the lost driver’s own step, through the same mailbox', async () => {
        // The lost driver's push and the takeover's are one step (#829): the supervisor answers a landed one from its
        // ledger instead of pushing again, and either asks for its credential through the step's own mailbox.
        const lost = publishSupervisor();
        const taken = publishSupervisor();
        const lostJob = gitlabJob();
        await publish(lost, lostJob);
        await publish(taken, {
            ...lostJob,
            leaseToken: '66666666-6666-4666-8666-666666666666',
            groupLease: lostJob.leaseToken,
        });
        const [lostPush] = networkSteps(lost.steps);
        const [takenPush] = networkSteps(taken.steps);
        expect(takenPush!.id).toBe(lostPush!.id);
        expect(takenPush!.forgeHost).toBe(HOST);
        expectTokenless([...lost.steps, ...taken.steps]);
    });

    it('pushes through the mailbox: the forge helper in the argv, the host on the step, no token', async () => {
        const s = publishSupervisor();
        expect(await publish(s, gitlabJob(), SENTINEL)).toMatchObject({ ok: true, published: true });
        const [push] = networkSteps(s.steps);
        expect(push!.argv).toContain(`credential.helper=${FORGE_STEP_CREDENTIAL_HELPER}`);
        expect(push).toMatchObject({ kind: 'publish', forgeHost: HOST });
        // Only the steps that reach the remote ask; the local ones name no host.
        for (const step of s.steps.filter((one) => !networkSteps(s.steps).includes(one))) {
            expect(step).not.toHaveProperty('forgeHost');
        }
        expectTokenless(s.steps);
    });

    it('refreshes a stale lease and asks the remote head through the mailbox too', async () => {
        const stale: StepResult = { exitCode: 1, stdout: '', stderr: 'rejected (stale info)', timedOut: false };
        const refused: StepResult = { exitCode: 1, stdout: '', stderr: 'remote: refused', timedOut: false };
        const s = publishSupervisor([stale, refused]);
        await publish(s, gitlabJob());
        const sent = networkSteps(s.steps);
        const verbs = sent.map((step) => step.argv.find((arg) => ['push', 'fetch', 'ls-remote'].includes(arg)));
        expect(verbs).toEqual(['push', 'fetch', 'push', 'ls-remote']);
        for (const step of sent) {
            expect(step.argv).toContain(`credential.helper=${FORGE_STEP_CREDENTIAL_HELPER}`);
            expect(step.forgeHost).toBe(HOST);
        }
        expectTokenless(s.steps);
    });

    it('surfaces an unanswered credential ask at the push as a lost step, never a failed publish', async () => {
        const s = publishSupervisor([unanswered]);
        const thrown = await publish(s, gitlabJob()).then(
            () => null,
            (e: unknown) => e
        );
        expect(stepLost(thrown)).toBe(true);
    });

    it('keeps a GitHub publish on its token and the token helper', async () => {
        const s = publishSupervisor();
        await publish(s, githubJob(), 'ghs_minted');
        const [push] = networkSteps(s.steps);
        expect(push!.argv).toContain(`credential.helper=${CREDENTIAL_HELPER}`);
        expect(push!.env.GITHUB_TOKEN).toBe('ghs_minted');
        expect(push).not.toHaveProperty('forgeHost');
    });
});

describe('a github-writing helper of a GitLab job', () => {
    const plan = (): HelperPlan => {
        const descriptor = lookupHelper('merge-conflict-probe');
        if (!descriptor) throw new Error('no merge-conflict-probe helper');
        return { helperId: 'merge-conflict-probe', phase: 'pre', input: { publication: null }, githubWriting: true };
    };

    it('runs with the host on its step and no token', async () => {
        const s = sink(() => ok('{"ok":true,"output":{}}'));
        await runHelperStep(s.host, gitlabJob(), plan(), { token: SENTINEL });
        expect(s.steps[0]).toMatchObject({ kind: 'helper', forgeHost: HOST });
        expectTokenless(s.steps);
    });

    // The autofix block reads no forge state: its probe is git-only and runs on a GitLab task as it
    // is, its one body, with no board route and no `gh` or `glab` in it.
    it('runs the git-only merge-conflict-probe body, with nothing of the forge in it', async () => {
        const s = sink(() => ok('{"ok":true,"output":{}}'));
        await runHelperStep(s.host, gitlabJob(), plan(), { token: SENTINEL });
        const [, , body] = s.steps[0]!.argv;
        expect(body).toBe(lookupHelper('merge-conflict-probe')!.scriptBody);
        expect(body).not.toMatch(/agent-review|detailed_merge_status|\bgh\b|\bglab\b/);
    });

    it('throws an unanswered ask as a lost step', async () => {
        const s = sink(() => unanswered);
        const thrown = await runHelperStep(s.host, gitlabJob(), plan()).then(
            () => null,
            (e: unknown) => e
        );
        expect(stepLost(thrown)).toBe(true);
    });
});

describe('the attempt pair in a GitLab review helper step', () => {
    const PAIR_NAMES = ['FACTORY_STATS_URL', 'RUNNER_JOB_ID', 'RUNNER_LEASE_TOKEN'];
    const plan = (helperId: string, githubWriting = true): HelperPlan => ({
        helperId,
        phase: 'pre',
        input: { publication: null },
        githubWriting,
    });
    const run = async (job: BoardJob, helperId: string, githubWriting = true) => {
        const s = sink(() => ok('{"ok":true,"output":{}}'));
        await runHelperStep(s.host, job, plan(helperId, githubWriting), { token: SENTINEL });
        return s;
    };

    it.each([REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID])(
        'gives %s the pair, and still no forge token',
        async (id) => {
            const job = gitlabJob();
            const s = await run(job, id);
            expect(s.steps[0]!.env).toMatchObject({
                FACTORY_STATS_URL: config.statsUrl,
                RUNNER_JOB_ID: job.id,
                RUNNER_LEASE_TOKEN: job.leaseToken,
            });
            expectTokenless(s.steps);
        }
    );

    it('never gives the pair to merge-conflict-probe, a read-only helper or a GitHub job', async () => {
        for (const s of [
            await run(gitlabJob(), 'merge-conflict-probe'),
            await run(gitlabJob(), REVIEW_COLLECT_PROBE_ID, false),
            await run(githubJob(), REVIEW_COLLECT_PROBE_ID),
        ]) {
            for (const name of PAIR_NAMES) expect(s.steps[0]!.env).not.toHaveProperty(name);
        }
    });
});

describe('a held grant in a review helper', () => {
    const FORGE_WAIT =
        '{"schema":"review-collect-probe/v1","version":1,"ok":false,"reason":"forge_wait","error":"held"}';
    const plan: HelperPlan = { helperId: REVIEW_COLLECT_PROBE_ID, phase: 'pre', input: null, githubWriting: true };

    it('throws a lost step for a GitLab job, so the attempt is interrupted, never failed', async () => {
        const s = sink(() => ok(FORGE_WAIT));
        const thrown = await runHelperStep(s.host, gitlabJob(), plan).then(
            () => null,
            (e: unknown) => e
        );
        expect(stepLost(thrown)).toBe(true);
    });

    it('is an ordinary helper failure for a GitHub job', async () => {
        const s = sink(() => ok(FORGE_WAIT));
        expect(await runHelperStep(s.host, githubJob(), plan)).toMatchObject({ ok: false, reason: 'forge_wait' });
    });
});

/** The docker runner's whole startup sync of `job`, every step answered by `answer`. */
async function dockerSyncRun(job: BoardJob, answer: (step: StepRequest) => StepResult, token?: string) {
    const s = sink(answer);
    const exec = async () => ({ stdout: '' });
    const result = await createDockerRunner(loadDriverConfig({}), undefined, withTaskVolume(exec), {
        steps: s.sink,
    }).syncCheckout(job, undefined, null, token);
    return { steps: s.steps, result };
}

describe('both executors sync a GitLab job through the mailbox', () => {
    const clean = () => ok('{"ok":true,"reason":null}');

    it('on docker: the host and the forge helper, no token', async () => {
        const { steps, result } = await dockerSyncRun(gitlabJob(), clean, SENTINEL);
        expect(result).toEqual({ ok: true, reason: null });
        const sync = steps.find((step) => step.kind === 'sync');
        expect(sync).toMatchObject({ forgeHost: HOST, env: { CRED_HELPER: FORGE_STEP_CREDENTIAL_HELPER } });
        expectTokenless(steps);
    });

    it('on kubernetes: the same', async () => {
        const run = await k8sSyncRun(gitlabJob(), { githubToken: SENTINEL });
        expect(run).toMatchObject({ value: { ok: true } });
        const sync = run.steps.find((step) => step.kind === 'sync');
        expect(sync).toMatchObject({ forgeHost: HOST, env: { CRED_HELPER: FORGE_STEP_CREDENTIAL_HELPER } });
        expectTokenless(run.steps);
    });

    it.each([
        ['docker', async (job: BoardJob) => (await dockerSyncRun(job, () => unanswered)).result],
        [
            'kubernetes',
            async (job: BoardJob) => {
                const run = await k8sSyncRun(job, { result: () => unanswered });
                if ('error' in run) throw run.error;
                return run.value;
            },
        ],
    ] as const)('on %s: an unanswered ask is a forge wait, not a failed sync', async (_executor, syncOf) => {
        const result: SyncResult = await syncOf(gitlabJob());
        expect(result).toMatchObject({ ok: false, kind: 'forge_wait' });
        expect(syncFailureHalt(result, gitlabJob())).toMatchObject({ halt: 'interrupt', blocked: true });
    });
});

/**
 * A GitLab job whose repository host carries the default port (`gitlab.example.com:443`) through the real step broker:
 * a played supervisor pulls each step and, for one that names a `forgeHost`, relays the ask its helper makes — git's
 * `host=` as the URL spelled it — through the real `/gate-token` route, which authorizes it by `holdsForgeAsk`. One
 * normalization rule on both ends (`normalizeForgeHost`): every ask resolves to a token, none is refused as foreign.
 */
describe('a GitLab host spelled with its default port', () => {
    const PORTED = 'gitlab.example.com:443';

    function brokered(answer: (step: StepRequest) => StepResult) {
        const broker = createStepBroker();
        const token = 'tok';
        broker.open(token);
        const stop = new AbortController();
        const asks: { step: string; status: number }[] = [];
        const steps: StepRequest[] = [];
        const slot = {
            relay: {
                token: async (host: string) =>
                    host === HOST ? ({ kind: 'token', token: 'glpat-x', expiresAt: null } as const) : ('gone' as const),
            },
        };
        void (async () => {
            while (!stop.signal.aborted) {
                const step = await broker.next(token, 1000, stop.signal).catch(() => 'closed' as const);
                if (step === 'closed') return;
                if (step === null) continue;
                steps.push(step);
                let asked = true;
                if (step.forgeHost !== undefined) {
                    const reply = await serveGateToken(slot, JSON.stringify({ step: step.id, host: PORTED }), {
                        holds: (id, host) => broker.holdsForgeAsk(token, id, host),
                        open: () => true,
                        signal: stop.signal,
                    });
                    asks.push({ step: step.id, status: reply.status });
                    asked = reply.status === 200;
                }
                broker.settle(token, step.id, step.invocation, asked ? answer(step) : unanswered);
            }
        })();
        return { host: { config, sink: broker }, asks, steps, stop: () => stop.abort() };
    }

    const portedJob = (over: Partial<BoardJob> = {}) =>
        gitlabJob({ repo: { forge: 'gitlab', host: PORTED, path: 'group/sub/widgets' }, ...over });

    it('names the normalized host on every forge step, and each ask resolves: sync, restore, publish', async () => {
        const sha = 'a'.repeat(40);
        const stale: StepResult = { exitCode: 1, stdout: '', stderr: 'rejected (stale info)', timedOut: false };
        const refused: StepResult = { exitCode: 1, stdout: '', stderr: 'remote: refused', timedOut: false };
        const pushes = [stale, refused];
        const b = brokered((step) => {
            const has = (word: string) => step.argv.includes(word);
            if (step.kind === 'sync') return ok('{"ok":true,"reason":null}');
            if (step.argv[2] === gitProbeScript) {
                return ok(
                    JSON.stringify({ cloned: true, branch: 'main', defaultBranch: 'main', dirty: true, unpushed: 0 })
                );
            }
            if (has('push')) return pushes.shift() ?? ok();
            if (has('ls-remote')) return ok('');
            if (has('rev-list')) return ok('0\n');
            if (has('rev-parse')) return ok(`${sha}\n`);
            if (step.env.ACTION) return ok(step.env.ACTION === 'read' ? '{}' : '');
            if (has('switch')) return has('-c') ? ok() : { exitCode: 1, stdout: '', stderr: '', timedOut: false };
            return ok();
        });
        try {
            expect(await runSyncStep(b.host, portedJob())).toEqual({ ok: true, reason: null });

            const restoring = portedJob({ followUp: true });
            restoring.taskRestore = { checkpoint: { id: 'cp', chunks: [] } as never, older: [], restored: false };
            b.steps.length = 0;
            await restoreTaskTree(b.host, restoring, { removeOlder: async () => undefined }).catch(() => undefined);
            expect(b.steps.map((step) => step.forgeHost)).toEqual([HOST]);

            const job = portedJob();
            const published = await publishCheckout(
                job,
                { pullRequests: fakePullRequests().port },
                supervisedStepRunner(b.host, job, { kind: 'publish' })
            );
            // The push was refused for real after the stale-lease fetch, and the reconcile found nothing landed.
            expect(published).toMatchObject({ ok: false, published: false });
            const verbs = networkSteps(b.steps).map((step) =>
                step.argv.find((arg) => ['push', 'fetch', 'ls-remote'].includes(arg))
            );
            expect(verbs).toEqual(['push', 'fetch', 'push', 'ls-remote']);
        } finally {
            b.stop();
        }
        expect(b.asks.length).toBeGreaterThanOrEqual(6);
        expect(b.asks.every((ask) => ask.status === 200)).toBe(true);
        for (const step of b.steps.filter((one) => one.forgeHost !== undefined)) expect(step.forgeHost).toBe(HOST);
    });

    it('lists the normalized host for the agent and its gates', () => {
        expect(forgeHostsOf(portedJob())).toEqual([HOST]);
        expect(gitlabForgeHost(portedJob())).toBe(HOST);
    });
});
