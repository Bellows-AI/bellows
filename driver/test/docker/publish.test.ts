import { describe, expect, it, vitest } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { containerName, dockerArgs } from '../../src/docker/docker.js';
import { TASK_MOUNT, taskMountArgs } from '../../src/task-volume.js';
import { createDockerRunner } from '../../src/docker/docker-runner.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import type { StepSink } from '../../src/step-control.js';
import type { StepRequest } from '../../src/supervisor-contract.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    isBranchName,
    parseGitState,
    parsePrSummary,
    publishPlan,
    SYNC_DEADLINE_MS,
    worktreeBranch,
    checkoutDir,
    checkoutKey,
    remoteUrl,
    taskCheckoutScript,
} from '../../src/publish/publish.js';
import {
    CONTROL_TOKEN,
    job,
    ok,
    FINALIZED,
    fakeSteps,
    syncSteps,
    emptyDaemon,
    SESSION,
    spawnChild,
    labelDaemon,
    dockerRunner,
} from '../fixtures/docker-suite.js';

const PR_URL = 'https://github.com/Bellows-AI/bellows/pull/42';

describe('publishing the produced work', () => {
    const ISSUE_JOB: BoardJob = {
        ...job,
        command: '/fix https://github.com/Bellows-AI/bellows/issues/10',
        repo: 'Bellows-AI/bellows',
        env: { GITHUB_TOKEN: 't0k-3n' },
    };
    const NOW = new Date('2026-09-09T12:00:00Z');

    it('plans the branch, title and issue from the command', () => {
        expect(publishPlan(ISSUE_JOB, NOW)).toEqual({
            branch: 'fix/10',
            title: '/fix https://github.com/Bellows-AI/bellows/issues/10 (#10)',
            issueNumber: 10,
        });
        // No issue named: a dated task branch, no closed issue.
        const plain = publishPlan({ ...job, command: 'tidy the docs' }, NOW);
        expect(plain.branch).toBe('task/20260909');
        expect(plain.issueNumber).toBeNull();
        expect(plain.title).toBe('tidy the docs');
    });

    it('caps the fallback title at 144 characters', () => {
        const capped = publishPlan({ ...job, command: 'y'.repeat(200) }, NOW);
        expect(capped.title).toBe('y'.repeat(144));
        expect(capped.issueNumber).toBeNull();
    });

    it('plans the same branch and closure from the bare /fix <number> form', () => {
        expect(publishPlan({ ...job, command: '/fix 100' }, NOW)).toEqual({
            branch: 'fix/100',
            title: '/fix 100 (#100)',
            issueNumber: 100,
        });
        const hashed = publishPlan({ ...job, command: '/fix #44' }, NOW);
        expect(hashed.branch).toBe('fix/44');
        expect(hashed.issueNumber).toBe(44);
        expect(publishPlan({ ...job, command: '/fix https://github.com/o/r/issues/44' }, NOW).issueNumber).toBe(44);
    });

    it('does not name an issue from a command that merely looks like /fix', () => {
        expect(publishPlan({ ...job, command: '/fix-a 100' }, NOW)).toEqual({
            branch: 'task/20260909',
            title: '/fix-a 100',
            issueNumber: null,
        });
    });

    it("closes the thread root's issue when a follow-up publishes", () => {
        // `/fix 122` failed its gates; the follow-up `both OK` is the run that publishes.
        const followUp = { ...job, command: 'both OK', rootCommand: '/fix 122' };
        expect(publishPlan(followUp, NOW).issueNumber).toBe(122);
        // A root that names no issue leaves the follow-up's own command to name one.
        expect(publishPlan({ ...job, command: 'now /fix 9', rootCommand: 'tidy' }, NOW).issueNumber).toBe(9);
        expect(publishPlan({ ...job, command: 'both OK', rootCommand: 'tidy' }, NOW).issueNumber).toBeNull();
    });

    it('prefers the /fix target over an incidental #mention', () => {
        expect(publishPlan({ ...job, command: '/fix 44 but really #9' }, NOW)).toEqual({
            branch: 'fix/44',
            title: '/fix 44 but really #9 (#44)',
            issueNumber: 44,
        });
    });

    it('rejects lookalike and impossible issue numbers', () => {
        // A trailing word character means the digits were the prefix of a longer token.
        expect(publishPlan({ ...job, command: '/fix 44oops' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: 'see #44oops' }, NOW).issueNumber).toBeNull();
        // Zero is no issue, and past the safe-integer range the number is not honest.
        expect(publishPlan({ ...job, command: '/fix 0' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: '/fix 99999999999999999999' }, NOW).issueNumber).toBeNull();
        // A sentence period after the reference is punctuation, not a longer number.
        expect(publishPlan({ ...job, command: 'fix #44.' }, NOW).issueNumber).toBe(44);
    });

    it('builds the checkout directory and clone URL from the repo label, asserting it', () => {
        expect(checkoutDir(ISSUE_JOB)).toBe(`${TASK_MOUNT}/bellows`);
        expect(remoteUrl(loadDriverConfig({}), ISSUE_JOB)).toBe('https://github.com/Bellows-AI/bellows.git');
        expect(remoteUrl(loadDriverConfig({ REPO_CLONE_BASE: 'file:///origins' }), ISSUE_JOB)).toBe(
            'file:///origins/Bellows-AI/bellows.git'
        );
        // A dot-segment is the traversal; a dot-prefixed name is the task volume's own (`.factory`, `.<name>.sync`).
        for (const repo of ['just-a-name', 'o/..', 'o/.', 'o/.factory', 'o/.hidden']) {
            expect(checkoutDir({ ...ISSUE_JOB, repo }), repo).toBeNull();
            expect(remoteUrl(loadDriverConfig({}), { ...ISSUE_JOB, repo }), repo).toBeNull();
        }
    });

    /*
     * The per-task workspace (issue #35): one `git worktree` of the job's repo, branched off the
     * remote default, per task THREAD. Keyed by the thread's ROOT job id — stable across attempts
     * of the same job, and shared by follow-ups, because a follow-up resumes the parent session
     * and a session is only coherent in the tree it ran in. The clone itself stays pristine.
     */
    const ROOT = '55555555-5555-4555-8555-555555555555';
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };

    it('computes the checkout key and branch from the thread root', () => {
        expect(checkoutKey(repoJob)).toBe(`${job.id}/bellows`);
        // A follow-up is a NEW job row resuming the parent conversation: its checkout is the
        // thread's, so it lands in the tree the session (and the parent's work) lives in.
        expect(checkoutKey({ ...repoJob, rootJobId: ROOT })).toBe(`${ROOT}/bellows`);
        expect(checkoutDir({ ...repoJob, rootJobId: ROOT })).toBe(`${TASK_MOUNT}/bellows`);
        expect(worktreeBranch({ ...repoJob, rootJobId: ROOT })).toBe(`factory/${ROOT}`);
    });

    it('refuses a checkout key it could not assert', () => {
        // The same posture the checkout directory pins above: every board-supplied half is asserted
        // before it joins a path, and here the value becomes the agent's working directory.
        const broken: BoardJob[] = [
            { ...repoJob, repo: 'just-a-name' },
            { ...repoJob, repo: 'o/..' },
            { ...repoJob, repo: 'o/.' },
            { ...repoJob, rootJobId: 'not-a-uuid' },
            { ...repoJob, rootJobId: '../../etc' },
        ];
        for (const job of broken) expect(checkoutKey(job), job.repo ?? undefined).toBeNull();
    });

    it('runs a repo job inside its checkout, and a repo-less job at the task volume root', () => {
        const withRepo = dockerArgs(
            loadDriverConfig({}),
            repoJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(withRepo).toContain(`WORKDIR=${TASK_MOUNT}/bellows`);
        // A command-only job names no repo: no checkout exists, and the task volume's root is where
        // it starts.
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toContain(`WORKDIR=${TASK_MOUNT}`);
    });

    it('refuses to run a repo job whose thread root cannot be asserted', () => {
        expect(() =>
            dockerArgs(loadDriverConfig({}), { ...repoJob, rootJobId: 'not-a-uuid' }, { id: SESSION, resume: false })
        ).toThrow(/task worktree/);
    });

    // What the sync does is executed for real in scripts-task-checkout*.test.ts;
    // these pins have no behavioural twin.
    it('runs every git call of the sync without a shell', () => {
        expect(taskCheckoutScript).toContain('execFileSync');
        expect(taskCheckoutScript).not.toContain('execSync(');
        // A rebase that fails without a conflict aborts itself: the checkout never sits mid-rebase.
        expect(taskCheckoutScript).toContain("inw('rebase', '--abort')");
    });

    it('creates no task volume for an attempt that was aborted before its group', async () => {
        const calls: string[][] = [];
        const exec = async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'volume' && args[1] === 'inspect') throw new Error('Error: No such volume: x');
            return { stdout: '' };
        };
        const aborted = new AbortController();
        aborted.abort();
        const runner = createDockerRunner(loadDriverConfig({}), spawnChild('', '', 0), exec, {
            steps: fakeSteps().sink,
        });
        await expect(runner.syncCheckout(repoJob, aborted.signal)).rejects.toThrow();
        expect(calls.some((args) => args[0] === 'volume' && args[1] === 'create')).toBe(false);
    });

    it('hands the sync the checkout, the remote and the branch, by env', async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const [sync] = supervised.ofKind('sync');
        expect(sync?.argv).toEqual(['node', '-e', taskCheckoutScript]);
        // The checkout in the task volume and the remote it is cloned from. Paths, not credentials:
        // the claim env rides the step's own env, exactly as it rode the env file.
        expect(sync?.env).toMatchObject({
            CHECKOUT: `${TASK_MOUNT}/bellows`,
            REMOTE: 'https://github.com/Bellows-AI/bellows.git',
            BRANCH: `factory/${job.id}`,
        });
        // The step goes to the attempt's supervisor, under the control token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        // The supervisor mounts the thread's own task volume — the same scoping every other container
        // this runner starts gets, nothing broader — and the sync starts no container of its own.
        const create = d.calls.find((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))!;
        expect(create).toEqual(expect.arrayContaining(taskMountArgs(job)));
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    // git reads no token from the environment, so a private-repo fetch needs the same token-backed
    // helper the push uses. It rides CONDITIONALLY: only beside the token the board minted for this
    // sync (docs/connections.md), because a public repo must keep its plain unauthenticated fetch
    // (a helper answering an empty password would break it). The VALUE passed is helper CODE,
    // never the credential — the token itself travels only in the step env, where the helper reads it.
    it("hands the sync the credential-helper code only beside the board's minted token", async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const [withToken] = supervised.ofKind('sync');
        expect(withToken?.env).toMatchObject({ CRED_HELPER: CREDENTIAL_HELPER, GITHUB_TOKEN: 't0k-3n' });
        // The token itself rides the step, never argv — the step's or the daemon's.
        expect(withToken?.argv.some((arg) => arg.includes('t0k-3n'))).toBe(false);
        expect(d.calls.flat().some((arg) => arg.includes('t0k-3n'))).toBe(false);

        // No minted token keeps the plain fetch — and a claim value under the reserved name is no
        // token: it is dropped, never forwarded.
        await runner.syncCheckout({ ...repoJob, env: { GITHUB_TOKEN: 'claim-pat', CORE_TOKEN: 'shh' } });
        const plain = supervised.ofKind('sync')[1];
        expect(plain?.env).not.toHaveProperty('CRED_HELPER');
        expect(plain?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(plain?.env).toMatchObject({ CORE_TOKEN: 'shh' });

        // An EMPTY token is no token: the helper would answer an empty password and break the
        // public-repo plain fetch it exists to preserve.
        await runner.syncCheckout(repoJob, undefined, null, '');
        expect(supervised.ofKind('sync')[2]?.env).not.toHaveProperty('CRED_HELPER');
    });

    // A claim that CONTINUES a session — a follow-up — is mid-task, and git operations that touch
    // the remote belong to the task's beginning and end (issue #58). Its sync is a RESTORE: the
    // step runs with RESTORE=1 and carries NO claim env at all (restore talks only to the local
    // clone — nothing to credential), and the fetch's helper code is absent even beside a token.
    it('restores a claim that continues a session instead of syncing it', async () => {
        const supervised = syncSteps();
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        await runner.syncCheckout({ ...repoJob, followUp: true }, undefined, null, 't0k-3n');
        const [follow] = supervised.ofKind('sync');
        expect(follow?.env).toMatchObject({ RESTORE: '1' });
        expect(follow?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(follow?.env).not.toHaveProperty('CRED_HELPER');

        // A claim carrying a resume session (resumeSessionId without the followUp flag) is the
        // same mid-task hazard: the session's tree must not move under it either.
        await runner.syncCheckout({ ...repoJob, resumeSessionId: SESSION }, undefined, null, 't0k-3n');
        const parked = supervised.ofKind('sync')[1];
        expect(parked?.env).toMatchObject({ RESTORE: '1' });
        expect(parked?.env).not.toHaveProperty('GITHUB_TOKEN');

        // A starting claim beside a token keeps the sync shape: no RESTORE, the token on.
        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const fresh = supervised.ofKind('sync')[2];
        expect(fresh?.env).not.toHaveProperty('RESTORE');
        expect(fresh?.env).toMatchObject({ GITHUB_TOKEN: 't0k-3n' });
    });

    // The terminal reclaim (issue #775): the thread's tree lives on its own task volume, which only the
    // reaper deletes, so the reclaim is an acknowledged no-op — no group, no step, no daemon call.
    it.each([
        ['a job with a repository', { ...repoJob, env: { GITHUB_TOKEN: 't0k-3n' } }],
        ['a job that names none', job],
        ['a thread root that is no uuid', { ...repoJob, rootJobId: 'not-a-uuid' }],
    ])('acknowledges the reclaim of %s without asking the daemon anything', async (_what, of) => {
        const d = labelDaemon();
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        expect(await runner.reclaimWorktree(of)).toEqual({ ok: true, removed: false, reason: null });
        expect(d.calls).toEqual([]);
        expect(supervised.submitted).toEqual([]);
    });

    /*
     * An unreadable sync/reclaim verdict names why — what the step printed — and a step that
     * exited non-zero says it in the tool's own words. (A RESOLVED unreadable verdict is by
     * construction an exit-0 step.)
     */
    it('names what the sync step printed when its answer is not a verdict', async () => {
        const supervised = syncSteps('fetching origin\nfatal: could not read from remote repository\n');
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('the worktree sync answered nothing readable');
        expect(result.reason).toContain('fatal: could not read from remote repository');
    });

    it('names a sync step that printed nothing readable', async () => {
        const result = await dockerRunner(emptyDaemon, { steps: syncSteps('').sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/^the worktree sync answered nothing readable/);
    });

    it('says why a sync step that exited non-zero failed, in the tool’s own words', async () => {
        const supervised = fakeSteps(() => ({
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: unable to access the remote',
            timedOut: false,
        }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result).toEqual({ ok: false, reason: 'the worktree sync failed: fatal: unable to access the remote' });
    });

    /*
     * Issue #559: a sync that never lands (a fetch stalled on the network) would hold its clone's
     * queue, and every sibling behind it, forever. The step carries the sync deadline, which the
     * supervisor enforces — it kills the step's process and answers `timedOut` — and the run fails
     * like a sync the kubelet ended. Nothing of the step outlives the answer, so there is nothing
     * further to wait out.
     */
    it('bounds the sync step by the sync deadline, and fails the run when the supervisor ends it there', async () => {
        const supervised = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        const [sync] = supervised.ofKind('sync');
        expect(sync?.timeoutMs).toBe(SYNC_DEADLINE_MS);
        expect(result).toMatchObject({
            ok: false,
            reason: `the worktree sync failed: the step exceeded its ${SYNC_DEADLINE_MS}ms deadline`,
        });
    });

    // The sync is never abandoned mid-write: a stand-down — or an attempt whose channel closed —
    // kills the whole group instead, which rejects the step. The loop leaves the job to its lease,
    // and the group is gone from the daemon.
    it('removes the group and throws when the channel closes under the sync', async () => {
        const d = labelDaemon();
        const sink: StepSink = {
            submit: () => Promise.reject(new Error('the task supervisor channel closed before its step was answered')),
            awaitReport: () => Promise.resolve(FINALIZED),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const runner = dockerRunner(d.exec, { steps: sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');

        expect(d.calls).toContainEqual(['rm', '-f', supervisorName(repoJob)]);
        expect(d.containers.size).toBe(0);
        // Nothing is remembered of the group: the next sync creates one afresh.
        const created = d.calls.filter((a) => a[0] === 'create').length;
        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');
        expect(d.calls.filter((a) => a[0] === 'create').length).toBe(created * 2);
    });

    it('carries the script’s failure kind through the sync step’s stdout (issue #666)', async () => {
        const verdict = {
            ok: false,
            reason: 'the branch factory/x is gone from the remote',
            kind: 'branch_unrestorable',
        };
        const runner = dockerRunner(emptyDaemon, { steps: syncSteps(`${JSON.stringify(verdict)}\n`).sink });

        expect(await runner.syncCheckout(repoJob)).toMatchObject(verdict);
    });

    // The fence before the sync (PR #46 review): the loop calls syncCheckout before the
    // runner's own fence, so the sweep has to come here — the sync is the first writer on the
    // task worktree, and starting it over a previous attempt's live runner would mix edits.
    it('sweeps the job label before the sync step is asked of a group', async () => {
        const d = labelDaemon();
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const shapes = d.calls.map((a) => a[0]);
        expect(shapes).toContain('ps');
        expect(shapes.indexOf('ps')).toBeLessThan(shapes.indexOf('create'));
        expect(shapes.indexOf('create')).toBeLessThan(shapes.indexOf('start'));
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    // The replacement-with-an-active-previous-runner shape of the review comment: the old
    // attempt's runner is still on the daemon when the replacement's sync starts, and the
    // fence's removal must land BEFORE the sync's group is created — not after it.
    it('removes a previous attempt’s still-running runner before the sync runs', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const NEW_TOKEN = 'bbbbbbbb-2222-4222-8222-222222222222';
        const d = labelDaemon();
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = dockerRunner(d.exec, { steps: syncSteps().sink });
        const next = { ...repoJob, leaseToken: NEW_TOKEN };
        const result = await runner.syncCheckout(next);

        expect(result).toEqual({ ok: true, reason: null });
        // The previous runner is off the daemon; what is there is the new attempt's own group.
        expect([...d.containers.keys()]).toEqual([supervisorName(next)]);
        const rmIndex = d.calls.findIndex((a) => a[0] === 'rm');
        const createIndex = d.calls.findIndex((a) => a[0] === 'create');
        expect(rmIndex).toBeGreaterThanOrEqual(0);
        expect(rmIndex).toBeLessThan(createIndex);
    });

    // A fence that converts a failed `docker ps` into an empty answer reads "nothing left" —
    // and the sync would start while a previous attempt's runner is still writing the worktree.
    // The fence is infrastructure, not the command's verdict: it must throw, and the loop's
    // try/catch around syncCheckout leaves the job to its lease. The same holds for every verb
    // of the fence, with the leftover the refused verb would have touched seeded.
    it.each<[string, (args: string[]) => string | null, 'container' | null]>([
        [
            'cannot list the job’s leftover containers',
            (args) => (args[0] === 'ps' ? 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' : null),
            null,
        ],
        [
            'a leftover container refuses to be removed',
            (args) => (args[0] === 'rm' ? 'Error: cannot remove container: device is busy' : null),
            'container',
        ],
    ])('fails the sync when the fence %s', async (_label, fail, leftover) => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({ fail });
        const labels = { 'factory.job': job.id, 'factory.lease': OLD_TOKEN };
        if (leftover === 'container') d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), labels);
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        // No group, and no sync step, over an unfenced checkout: the throw precedes both.
        expect(d.calls.some((a) => a[0] === 'create')).toBe(false);
        expect(supervised.steps()).toEqual([]);
    });

    // The one tolerated shape: a container exiting between the fence's ps and its rm answers
    // "No such container" — the fence SUCCEEDED, the runner is gone. Failing there would burn
    // attempts on the daemon confirming a removal already finished.
    it('proceeds when the fence’s rm answers that the container is already gone', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({
            fail: (args) =>
                args[0] === 'rm'
                    ? `Error response from daemon: No such container: ${containerName({ ...job, leaseToken: OLD_TOKEN })}`
                    : null,
        });
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        expect(await runner.syncCheckout(repoJob)).toEqual({ ok: true, reason: null });
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))).toBe(true);
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    it('runs every publish step inside the task worktree', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.publishGit(ISSUE_JOB);

        const wt = `/task/bellows`;
        expect(steps.steps().length).toBeGreaterThan(0);
        for (const step of steps.steps()) {
            if (step.argv.some((x) => x.includes('shortstat'))) {
                // The summarizer (issue #82) is anchored like every git step — the task
                // worktree as its working directory, never the image default, where git would find
                // no repo and the summary would silently degrade to the command title. Pinned
                // explicitly, because its failure mode is the quiet one.
                expect(step.cwd).toBe(wt);
            } else if ('LEDGER' in step.env) {
                // The publication ledger is a file under the worktree, named by path.
                expect(step.env.LEDGER?.startsWith(`${wt}/`)).toBe(true);
            } else if (step.argv.some((x) => x.includes('execFileSync'))) {
                // The probe runs at the mount root and reads the repo by REPO.
                expect(step.env).toMatchObject({ REPO: wt });
            } else {
                expect(step.cwd).toBe(wt);
            }
        }
        // The steps run in the supervisor, which mounts the job's own subtree — the publish never
        // sees another member's tree.
        const create = docker.find((a) => a[0] === 'create' && a.includes(supervisorName(ISSUE_JOB)))!;
        expect(create).toEqual(expect.arrayContaining(taskMountArgs(job)));
    });

    // The loop asks the board for a token right before the push (docs/connections.md); the env the
    // steps ride must carry THAT credential, and a claim value under the reserved name never.
    it("publishes with the board's minted token, never a claim value", async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit(ISSUE_JOB, 'ghs_fresh');

        expect(result.ok).toBe(true);
        const credentialed = steps.steps().filter((step) => 'GITHUB_TOKEN' in step.env);
        expect(credentialed.length).toBeGreaterThan(0);
        for (const step of credentialed) expect(step.env.GITHUB_TOKEN).toBe('ghs_fresh');
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        // Credentials ride the step and nothing else: never the daemon's argv.
        expect(docker.flat().join(' ')).not.toContain('ghs_fresh');
    });

    // Executor parity for the publish flag (docs/workflows.md): the flag is read in exactly ONE
    // place — the loop, shared by both executors — so this transport must have no opinion of its
    // own. The loop tests pin that a publish:false claim never reaches publishGit; this pins the
    // other half, that the docker transport grew no gate of its own to drift against.
    // Issue #825, executor parity: a bound publish's tree check rides the supervisor's steps here
    // exactly as under kubernetes — staged hook-free, the commit held to that tree.
    it.each([
        ['pushes when the commit holds the staged tree', {}, true],
        ['refuses stale, pushing nothing, when a commit hook moved it', { committed: 'b'.repeat(40) }, false],
    ])('a bound publish %s', async (_case, trees, published) => {
        const bound = { ...DIRTY_ON_MAIN, fingerprint: 'h:1' };
        const { steps, runner } = publishRunner(bound, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
            trees,
        });

        const result = await runner.publishGit(ISSUE_JOB, undefined, { revision: 'h:1' });

        expect(result).toMatchObject(published ? { ok: true, published } : { ok: false, stale: true });
        const argvs = steps.steps().map((step) => step.argv);
        expect(argvs.some((a) => a.includes('write-tree') && a.includes('core.hooksPath=/dev/null'))).toBe(true);
        expect(argvs.some((a) => a.includes('push'))).toBe(published);
    });

    it('leaves the publish decision to the loop: publishGit ignores a publish:false claim', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit({ ...ISSUE_JOB, publish: false });

        expect(result.ok).toBe(true);
        expect(steps.steps().length).toBeGreaterThan(0);
    });

    it('refuses branch names that could read as something else', () => {
        expect(isBranchName('fix/10')).toBe(true);
        expect(isBranchName('task/20260909')).toBe(true);
        expect(isBranchName('')).toBe(false);
        expect(isBranchName('../etc')).toBe(false);
        expect(isBranchName('-oProxyCommand')).toBe(false);
        expect(isBranchName('a b')).toBe(false);
    });

    it('probes without a shell and reads the credential from the environment, never argv', () => {
        // Every git call in the probe is execFileSync — no value can become a command.
        expect(gitProbeScript).toContain('execFileSync');
        expect(gitProbeScript).not.toContain('execSync(');
        // "Unpushed" is counted against the remote default branch, never `@{u}`: a branch that
        // was never pushed has no upstream, and the fatal rev-list would read its local-only
        // commits as fully landed — which once reported a two-commit task branch as "nothing to
        // publish".
        expect(gitProbeScript).toContain("'origin/' + out.defaultBranch + '..HEAD'");
        expect(gitProbeScript).not.toContain('@{u}');
        // The helper reads the token from the container's environment — the env file's job —
        // and the literal appears in no argv the publisher builds.
        expect(CREDENTIAL_HELPER).toContain('$GITHUB_TOKEN');
    });

    it('parses the probe’s answer, defaulting anything missing', () => {
        expect(
            parseGitState(
                '{"cloned":true,"branch":"fix/10","defaultBranch":"main","dirty":true,"unpushed":2,"hasIdentity":false}'
            )
        ).toEqual({
            cloned: true,
            branch: 'fix/10',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 2,
            hasIdentity: false,
            fingerprint: null,
            noChange: false,
            conflicts: [],
            rebasing: false,
        });
        expect(parseGitState('{"cloned":true,"fingerprint":"abc:def"}').fingerprint).toBe('abc:def');
        expect(parseGitState('')).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            noChange: false,
            conflicts: [],
            rebasing: false,
        });
    });

    it('parses the PR summary’s answer, defaulting anything missing', () => {
        expect(parsePrSummary('{"title":"Fix the fence","body":"## Commits"}')).toEqual({
            title: 'Fix the fence',
            body: '## Commits',
        });
        expect(parsePrSummary('{"title":"","body":null}')).toEqual({ title: null, body: null });
        expect(parsePrSummary('')).toEqual({ title: null, body: null });
        expect(parsePrSummary('git: fatal: not a git repository')).toEqual({ title: null, body: null });
    });

    it('defaults the probe’s and the PR summary’s answers for a null last line or a non-JSON last line', () => {
        const unread = {
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            noChange: false,
            conflicts: [],
            rebasing: false,
        };
        expect(parseGitState('null')).toEqual(unread);
        expect(parseGitState('{"cloned":true}\nnoise')).toEqual(unread);
        expect(parsePrSummary('null')).toEqual({ title: null, body: null });
        expect(parsePrSummary('{"title":"t","body":"b"}\nnoise')).toEqual({ title: null, body: null });
    });

    /**
     * The supervisor stood in: the probe answers from `state`, git steps mutate nothing, and every
     * step the runner submits is recorded, so the flow — what ran, in which order, and what was
     * skipped — is the assertion. A step is a request over the control channel, never a container:
     * the daemon only ever sees the group (the supervisor), recorded in `docker`.
     */
    const publishRunner = (
        state: Record<string, unknown>,
        opts: {
            prExists?: boolean;
            fail?: ((argv: string[]) => boolean) | undefined;
            /** The step's stderr, as the supervisor answers it beside a non-zero exit. */
            failStderr?: string;
            summary?: Record<string, unknown>;
            exec?: (args: string[]) => Promise<{ stdout: string }>;
            /** What a bound publish's staged and committed trees read (issue #825); default both one tree. */
            trees?: { staged?: string; committed?: string };
        } = {}
    ) => {
        const docker: string[][] = [];
        const steps = fakeSteps((step) => {
            const argv = step.argv;
            if (opts.fail?.(argv)) {
                return { exitCode: 1, stdout: '', stderr: opts.failStderr ?? 'step refused', timedOut: false };
            }
            // The publication ledger answers "never recorded", and HEAD is a commit.
            if ('LEDGER' in step.env) return ok('{}');
            if (argv.includes('write-tree')) return ok(`${opts.trees?.staged ?? 't'.repeat(40)}\n`);
            if (argv.includes('HEAD^{tree}')) return ok(`${opts.trees?.committed ?? 't'.repeat(40)}\n`);
            if (argv.includes('rev-parse')) return ok(`${'a'.repeat(40)}\n`);
            // The probe's marker rides INSIDE the -e script string; the git steps carry their
            // subcommand as a standalone argv element. The PR summarizer (issue #82) is the
            // second node step — told apart by the git argv its script embeds.
            if (argv.some((a) => a.includes('execFileSync'))) {
                if (argv.some((a) => a.includes('shortstat'))) return ok(JSON.stringify(opts.summary ?? SUMMARY));
                return ok(JSON.stringify(state));
            }
            if (argv.includes('pr') && argv.includes('view')) {
                if (opts.prExists) return ok(`${PR_URL}\n`);
                return { exitCode: 1, stdout: '', stderr: 'no pull requests', timedOut: false };
            }
            if (argv.includes('pr') && argv.includes('create')) return ok(`${PR_URL}\n`);
            return ok();
        });
        const exec =
            opts.exec ??
            (vitest.fn(async (args: string[]) => {
                docker.push(args);
                return { stdout: args[0] === 'wait' ? '0\n' : '' };
            }) as unknown as (args: string[]) => Promise<{ stdout: string }>);
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: steps.sink });
        return { steps, docker, runner };
    };

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };

    /** What the PR summarizer answers (issue #82): what the branch did, not what was asked. */
    const SUMMARY = { title: 'Fix the sync re-claim fence', body: '## Commits\n\n- Fix the sync re-claim fence' };

    const argvsOf = (steps: ReturnType<typeof fakeSteps>): string[][] => steps.steps().map((step) => step.argv);

    const shapesOf = (steps: ReturnType<typeof fakeSteps>): string[] =>
        steps.steps().map(({ argv: a, env }) => {
            // The publication ledger (publish-reconcile.ts) is a node step keyed by its LEDGER path.
            if ('LEDGER' in env) return 'ledger';
            if (a.includes('rev-parse')) return 'rev-parse';
            if (a.some((x) => x.includes('execFileSync'))) {
                return a.some((x) => x.includes('shortstat')) ? 'summary' : 'probe';
            }
            if (a.includes('switch')) return 'switch';
            if (a.includes('add')) return 'add';
            if (a.includes('reset')) return 'reset';
            if (a.includes('commit')) return 'commit';
            if (a.includes('push')) return 'push';
            if (a.includes('view')) return 'pr-view';
            if (a.includes('create')) return 'pr-create';
            return 'other';
        });

    // The post-gate tree read: one probe step over the worktree, with no claim env.
    it('probes the tree fingerprint with one env-less step', async () => {
        const { steps, runner } = publishRunner({ ...DIRTY_ON_MAIN, fingerprint: 'h:1' });

        expect(await runner.probeTree(ISSUE_JOB)).toBe('h:1');

        expect(shapesOf(steps)).toEqual(['probe']);
        const [probe] = steps.ofKind('probe');
        expect(probe?.env).toEqual({ REPO: checkoutDir(ISSUE_JOB) });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
    });

    // A Stop while the probe step is in flight ends the wait for its answer, never the supervisor.
    it('hands the stand-down signal to the probe step and answers null once it aborts', async () => {
        const cancel = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                cancel.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const exec = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: sink });

        expect(await runner.probeTree(ISSUE_JOB, cancel.signal)).toBeNull();

        expect(seen).toEqual([cancel.signal]);
    });

    it.each([
        ['answers no fingerprint', {}, undefined],
        ['fails', {}, () => true],
    ])('answers null when the probe %s', async (_label, extra, fail) => {
        const { runner } = publishRunner({ ...DIRTY_ON_MAIN, ...extra }, { fail });
        expect(await runner.probeTree(ISSUE_JOB)).toBeNull();
    });

    // The review snapshot of an attempt with no group yet (an adopted run): a supervisor-only group
    // is made for it, and its one `snapshot` step carries the stand-down signal.
    it('snapshots the tree as one snapshot step with the signal, making the supervisor-only group', async () => {
        const cancel = new AbortController();
        const seen: { step: StepRequest; signal: AbortSignal | undefined }[] = [];
        const sink: StepSink = {
            submit: async (_token, step, signal) => {
                seen.push({ step, signal });
                return ok('{"ok":true}');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const docker: string[][] = [];
        const exec = (async (args: string[]) => {
            docker.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: sink });

        expect(await runner.snapshotTree(ISSUE_JOB, 'review-1', cancel.signal)).toMatchObject({ ok: true });

        expect(seen.map(({ step }) => step.kind)).toEqual(['snapshot']);
        expect(seen[0]?.signal).toBe(cancel.signal);
        const created = docker.filter((a) => a[0] === 'create').map((a) => a[a.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(ISSUE_JOB)]);
    });

    it('branches, commits, pushes and opens the PR — in that order', async () => {
        // The checkout sits on main with no fix branch yet: the plain switch refuses (no such
        // branch), and `-c` creates it — both calls are part of the expected shape.
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        const result = await runner.publishGit(ISSUE_JOB, 'ghs_minted');

        expect(result).toEqual({
            ok: true,
            published: true,
            branch: 'fix/10',
            prUrl: PR_URL,
            reason: null,
            repository: 'Bellows-AI/bellows',
            baseBranch: 'main',
            prNumber: 42,
            cause: null,
        });
        const calls = argvsOf(steps);
        expect(shapesOf(steps)).toEqual([
            'probe',
            'switch',
            'switch',
            'add',
            'reset',
            'commit',
            // The operation (`branch@sha`) is named and recorded in the publication ledger around
            // each effect, so a retry after a lost answer reads what happened instead of redoing it.
            'rev-parse',
            'ledger',
            'push',
            'ledger',
            'pr-view',
            'summary',
            'pr-create',
            'ledger',
        ]);
        // The decisions are publishCheckout's (publish-checkout.test.ts); this is their supervised
        // rendering. A step that needs the claim env gets it as its own env, never on argv — and
        // nowhere in what the daemon was asked.
        const pushStep = steps.steps().find((step) => step.argv.includes('push'))!;
        expect(pushStep.argv).toContain('--force-with-lease');
        expect(pushStep.env).toMatchObject({ GITHUB_TOKEN: 'ghs_minted' });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        expect(calls.flat().join(' ')).not.toContain('ghs_minted');
        expect(docker.flat().join(' ')).not.toContain('ghs_minted');
        // A step's literal envs ride as env, and a step that needs no credential carries none.
        const summary = steps.steps().find((step) => step.argv.some((x) => x.includes('shortstat')))!;
        expect(summary.env).toEqual({
            BASE: 'origin/main',
            BACKSTOP_TITLE: '/fix https://github.com/Bellows-AI/bellows/issues/10 (#10)',
        });
        // The summarizer's stdout reaches the PR through this transport.
        const create = calls.find((a) => a.includes('pr') && a.includes('create'));
        expect(create?.[create.indexOf('--title') + 1]).toBe('Fix the sync re-claim fence (#10)');
    });

    // The acceptance of #771: a sync or a publish step is a request to the task supervisor, never a
    // `docker run`. The daemon is asked for the group's own containers and nothing else.
    it('starts no container of its own for a sync or a publish step', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.syncCheckout(ISSUE_JOB);
        await runner.publishGit(ISSUE_JOB);

        expect(steps.steps().length).toBeGreaterThan(0);
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
        const created = docker.filter((a) => a[0] === 'create').map((a) => a[a.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(ISSUE_JOB)]);
    });

    // Issue #581: the board recovers a failed publish by its cause, read from the step's own words.
    it('names a rejected non-fast-forward push a conflict', async () => {
        const { runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('push'),
            failStderr: ' ! [rejected]        HEAD -> fix/10 (non-fast-forward)\nerror: failed to push some refs',
        });
        const result = await runner.publishGit(ISSUE_JOB);

        expect(result).toMatchObject({ ok: false, published: false, cause: 'conflict' });
    });

    // The group the publish needs is infrastructure: a daemon that refuses it is thrown to the
    // loop — never a publish verdict, and no step is asked of a supervisor that does not exist.
    it('throws, submitting nothing, when the daemon refuses the group a publish needs', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN, {
            exec: async (args) => {
                if (args[0] === 'create') throw new Error('Error response from daemon: no space left on device');
                return { stdout: '' };
            },
        });

        await expect(runner.publishGit(ISSUE_JOB)).rejects.toThrow('no space left on device');
        expect(steps.steps()).toEqual([]);
    });
});
