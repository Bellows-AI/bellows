import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { dockerArgs, opencodeSessionReadoutArgs } from '../../src/docker/docker.js';
import { envFileBody } from '../../src/claim.js';
import { TASK_MOUNT, taskMountArgs } from '../../src/task-volume.js';
import { reportTail, tailBytes, tailKept } from '../../src/runner.js';
import { opencodeCacheProbeArgs } from '../../src/docker/docker-close-read.js';
import {
    CACHE_WATCH_TURNS,
    cacheCollapse,
    parseOpencodeCacheProbe,
    parseOpencodeRunOutcome,
} from '../../src/close-read.js';
import { ARTIFACT_LIMIT, OPENCODE_EXPORT_LIMIT } from '../../src/runner.js';
import { opencodeReadoutScript } from '../../src/container-scripts.js';
import { job, fakeSteps, SESSION, opencodeJob, START, dockerRunner } from '../fixtures/docker-suite.js';

describe('scraping the session opencode used', () => {
    /**
     * The readout is a throwaway container over the workspaces volume, entrypoint swapped for
     * node — the job container is already gone by the time it runs, and the driver has no host
     * path into a named volume. Pure and pinned for the same reason dockerArgs is.
     */
    it('refuses to build a readout argv for a claim whose thread root cannot be asserted', () => {
        // The root names the volume the readout mounts, so it is asserted before any argv exists —
        // a malformed claim produces no container, not one mounted somewhere unintended.
        const broken = { ...opencodeJob, rootJobId: '../../etc' };
        expect(() => opencodeSessionReadoutArgs(loadDriverConfig({}), broken, START)).toThrow(/not a uuid/);
        expect(() => opencodeCacheProbeArgs(loadDriverConfig({}), broken)).toThrow(/not a uuid/);
    });

    it('reads the session database out of the member’s data directory, root sessions only', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({}), opencodeJob, START);
        expect(line.slice(0, 16)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            ...taskMountArgs(job),
            '-e',
            `OPENCODE_DB=/task/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The scope: the session database is per member, so the readout answers only the
            // session whose `directory` is the working directory the RUN container had — the
            // task volume's root here, since this job names no repo. Without it, two concurrent tasks
            // of one member share the database and the newest-root-session scrape answers
            // whichever task closed last (observed 2026-09-11: two /fix tasks recorded one
            // session id, and both their follow-ups resumed the same conversation).
            `OPENCODE_DIR=${TASK_MOUNT}`,
            '-e',
            // The per-run delta bound: a follow-up resumes the same root conversation, so the
            // turn count is bounded to the messages written at or after this run began.
            `RUN_STARTED_MS=${Date.parse(START)}`,
            '-e',
            `EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`,
        ]);
        // The static script by content (what it answers: scripts-opencode-readout.test.ts).
        expect(line.slice(16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e', opencodeReadoutScript]);
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const line = opencodeSessionReadoutArgs(
            loadDriverConfig({}),
            { ...opencodeJob, repo: 'Bellows-AI/bellows' },
            START
        );
        expect(line).toContain(`OPENCODE_DIR=${TASK_MOUNT}/bellows`);
    });

    it('pulls the session id, finish reason and context stats out of the readout’s answer', () => {
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433.4,"cost":0.31}\n'
            )
        ).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A healthy run's closing word, and a free-tier cost of zero.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":"stop","tokens":1200,"cost":0,"turns":7}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'stop',
            contextTokens: 1200,
            costUsd: 0,
            agentTurns: 7,
            summary: null,
            blocked: null,
            error: null,
        });
        // A message that never reported a finish or tokens reads as none, not as a reason.
        // A line with no turn count reads unmeasured — pre-change readouts, or a parse miss.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":null,"tokens":null,"cost":null}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // The readout's own failure line: carried through as the reason, with no stats.
        expect(parseOpencodeRunOutcome('{"error":"no such column: role"}')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'no such column: role',
        });
        expect(parseOpencodeRunOutcome('')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // Not a session id: a path, an error line, or a uuid that would read as claude's.
        expect(parseOpencodeRunOutcome('ses_f86188c3dffeZGYO4yZq4atba9\n').sessionId).toBeNull();
        expect(parseOpencodeRunOutcome('Error: Session not found').sessionId).toBeNull();
        expect(
            parseOpencodeRunOutcome('{"id":"33333333-3333-4333-8333-333333333333","finish":"stop"}').sessionId
        ).toBeNull();
        // Negative or non-numeric context stats are not stats.
        // A negative or fractional turn count is not a count — unmeasured, never negative.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","tokens":-5,"cost":"free","turns":-1}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A session line that also carries the last provider error: both ride — the session makes
        // the task follow-up-able, the error is the premature stop's cause.
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_x1","finish":"tool-calls","tokens":100016,"cost":0,"error":"Error from provider (Console): Rate limit exceeded. Please try again later."}'
            )
        ).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'tool-calls',
            contextTokens: 100016,
            costUsd: 0,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
        });
        // The final message's blocked line rides beside the summary, read before its collapse.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","summary":"a","blocked":"no access"}').blocked).toBe(
            'no access'
        );
    });
    it('answers every field unmeasured, and no export, for a null last line or a non-JSON last line', () => {
        const nothing = {
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        };
        expect(parseOpencodeRunOutcome('null')).toStrictEqual(nothing);
        expect(
            parseOpencodeRunOutcome('{"stream":"raw","row":1}\n{"id":"ses_x1","finish":"stop"}\nnoise')
        ).toStrictEqual(nothing);
    });
});

describe('the cache watch', () => {
    const DEATH =
        '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","turns":[' +
        '{"input":84000,"cacheRead":0,"ms":250000},' +
        '{"input":80000,"cacheRead":0,"ms":200000},' +
        '{"input":63000,"cacheRead":0,"ms":150000}]}';

    /**
     * The probe is a throwaway container over the workspaces volume, entrypoint swapped for node
     * — the live-run twin of the close-time readout. Pure and pinned for the same reason.
     */
    it('probes the newest root session of the member’s data directory, read-only', () => {
        const line = opencodeCacheProbeArgs(loadDriverConfig({}), opencodeJob);
        expect(line.slice(0, 12)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            ...taskMountArgs(job),
            '-e',
            `OPENCODE_DB=/task/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The turn count rides from the driver's own constant, so the probe and the verdict
            // cannot drift apart.
            `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        ]);
        expect(line.slice(12, 16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e']);
        const script = line[16] as string;
        expect(script).toContain('process.env.OPENCODE_DB');
        expect(script).toContain('process.env.CACHE_WATCH_TURNS');
        // Newest-first, so the probe can answer from the run's last handful of messages without
        // reading the session whole.
        expect(script).toContain('order by id desc');
        expect(script).toContain('parent_id is null');
        expect(script).toContain("d.role !== 'assistant'");
        expect(script).toContain('readOnly');
        expect(script).toContain('{ error:');
    });

    it('parses the probe’s answer, error lines included', () => {
        expect(parseOpencodeCacheProbe(`${DEATH}\n`)).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            turns: [
                { input: 84000, cacheRead: 0, ms: 250000 },
                { input: 80000, cacheRead: 0, ms: 200000 },
                { input: 63000, cacheRead: 0, ms: 150000 },
            ],
            error: null,
        });
        // Not yet: no session, no turns, no error.
        expect(parseOpencodeCacheProbe('')).toEqual({ sessionId: null, turns: [], error: null });
        expect(parseOpencodeCacheProbe('{"error":"database is locked"}')).toEqual({
            sessionId: null,
            turns: [],
            error: 'database is locked',
        });
        // Malformed turns are not turns.
        expect(parseOpencodeCacheProbe('{"id":"ses_x1","turns":[{"input":-1},{"input":5}]}').turns).toEqual([]);
    });

    it('answers nothing for a null last line or a non-JSON last line', () => {
        expect(parseOpencodeCacheProbe('null')).toEqual({ sessionId: null, turns: [], error: null });
        expect(parseOpencodeCacheProbe('{"cloned":true}\nnoise')).toEqual({ sessionId: null, turns: [], error: null });
    });

    it('fires only on three consecutive dead, real-context, slow turns', () => {
        const turn = (over: Partial<{ input: number; cacheRead: number; ms: number }> = {}) => ({
            input: 80000,
            cacheRead: 0,
            ms: 200000,
            ...over,
        });
        // Fewer than three: not yet, whatever the turns look like.
        expect(cacheCollapse([turn(), turn()])).toBeNull();
        // The collapse itself, with the observed shape of the first incident.
        const verdict = cacheCollapse([turn({ ms: 250000 }), turn({ ms: 200000 }), turn({ ms: 150000 })]);
        expect(verdict).toContain('3 consecutive turns with no prompt-cache reads');
        expect(verdict).toContain('80k/80k/80k');
        expect(verdict).toContain('150-250s');
        // Cache hits, fast turns, or a tiny context each break the chain — the watch fires on a
        // provider that stopped CACHING INTO A WALL, not on a model that never cached and answers
        // quickly anyway.
        expect(cacheCollapse([turn({ cacheRead: 5000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ ms: 1000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ input: 500 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn(), turn({ ms: 1000 }), turn()])).toBeNull();
    });

    // A controllable child: stays open while the probe interval ticks, closed by the test once
    // the daemon has seen what the assertions need. The runner's own `docker run` goes through
    // spawnFn; every daemon call goes through the exec seam below.
    const openChild = () => {
        const c = new EventEmitter() as ChildProcess;
        c.stdout = new EventEmitter() as Readable;
        c.stderr = new EventEmitter() as Readable;
        return {
            spawn: (() => c) as unknown as typeof spawn,
            close: (code: number | null) => {
                process.nextTick(() => c.emit('close', code));
            },
        };
    };

    it('kills the run when the probe reports a dead cache, and carries the reason', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: DEATH };
            // The kill resolves its runner through its own label pair; the lease filter marks
            // this attempt's ps, and answering it with a container id is what lets the mock see
            // the `docker kill` itself.
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease'))) {
                return { stdout: 'a0a0a0a0a001\n' };
            }
            // The hard kill takes the supervisor down with the agent: its exit is the kill's 137.
            if (args[0] === 'wait') return { stdout: '137\n' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, {
            env: {
                RUNNER_CACHE_WATCH: '1',
                RUNNER_CACHE_WATCH_POLL_MS: '250',
            },
            spawn: childSpawn,
            // The supervisor dies in the kill: no report ever comes.
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
        while (!calls.some((a) => a[0] === 'kill')) await new Promise((r) => setTimeout(r, 5));
        close(137);
        const outcome = await pending;

        expect(outcome.exitCode).toBe(137);
        expect(outcome.cacheLost).toContain('3 consecutive turns with no prompt-cache reads');
        expect(outcome.timedOut).toBe(false);
        // The driver's own kill is the run's end, never a supervisor the platform took away.
        expect(outcome).not.toHaveProperty('infraLoss');
        // The reason is recorded on the attempt before the kill, for a claim adopting the run.
        const mark = `factory.kill.cache_lost=${outcome.cacheLost as string}`;
        const recorded = calls.findIndex((a) => a[0] === 'volume' && a[1] === 'create' && a.includes(mark));
        expect(recorded).toBeGreaterThanOrEqual(0);
        expect(recorded).toBeLessThan(calls.findIndex((a) => a[0] === 'kill'));
    });

    it('leaves the daemon alone while the watch is off', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, { spawn: childSpawn });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
        // Two poll periods of a live run, had the watch been armed at the same 250ms the armed
        // test uses — then an ordinary clean exit.
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        // The close-time readout does run; the mid-run probe never does.
        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });

    it('does not probe Claude Code tasks when the mixed-task driver has the OpenCode watch enabled', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, {
            env: { RUNNER_CACHE_WATCH: '1', RUNNER_CACHE_WATCH_POLL_MS: '250' },
            spawn: childSpawn,
        });

        const pending = runner.run(job, { id: SESSION, resume: false });
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });
});

describe('the runner env for a gated job', () => {
    const gated: BoardJob = {
        ...job,
        repo: 'Bellows-AI/bellows',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        env: { CLAIM_TOKEN: 'board-secret' },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('carries the gate credentials after the claim env, so the claim cannot spoof them', () => {
        // docker's --env-file is last-duplicate-wins: the gate lines are appended after the
        // claim's, so a member-configured BELLOWS_GATE_TOKEN in any scope loses to the driver's.
        const body = envFileBody(gated).split('\n').filter(Boolean);
        expect(body).toEqual([
            'CLAIM_TOKEN=board-secret',
            'BELLOWS_GATE_URL=http://host.docker.internal:9099',
            'BELLOWS_GATE_TOKEN=tok',
        ]);
    });

    /**
     * A claim can resolve to nothing — no env configured in any scope — while the job still
     * declares gates. The loop mints BELLOWS_GATE_URL/TOKEN for exactly such a job, and a runner
     * that keyed the env file on the claim alone would spawn with neither: no ad-hoc gate call
     * possible, and the run's own verification unreadable to the agent.
     */
    const gateOnly: BoardJob = {
        ...job,
        repo: 'Bellows-AI/bellows',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('mounts the env file when the only env is the gate credentials', () => {
        expect(envFileBody(gateOnly)).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            gateOnly,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    it('refuses to run a job whose only env is gate credentials with no env file to carry them', () => {
        // The same silent drop the claim-env refusal prevents — the credentials it was spawned
        // against never reach the container.
        expect(() => dockerArgs(loadDriverConfig({}), gateOnly, { id: SESSION, resume: false })).toThrow(/no env file/);
    });

    // The default gate URL's host gateway mapping is the supervisor's, whose namespace and hosts
    // file the agent shares (issue #773): docker refuses --add-host on a container-mode network.
    it('leaves the host gateway mapping to the supervisor whose namespace it shares', () => {
        expect(
            dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).not.toContain('--add-host');
    });

    it('never puts a gate value on the command line', () => {
        const line = dockerArgs(
            loadDriverConfig({}),
            gated,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line.some((arg) => arg.includes('tok'))).toBe(false);
        expect(line.some((arg) => arg.includes('host.docker.internal:9099'))).toBe(false);
    });

    // Regression pin for the feature boundary: a claim without gates builds exactly the argv it
    // always did.
    it('builds byte-identical argv for a job without gates', () => {
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toEqual(
            dockerArgs(
                loadDriverConfig({}),
                { ...job, gates: null },
                { id: SESSION, resume: false },
                { envFile: '/tmp/env-file' }
            )
        );
    });

    // opencode's plugin reads its endpoint from otel.json, not from OTEL_EXPORTER_OTLP_ENDPOINT —
    // the driver renders that file (telemetry-config.ts). The env var still reaches the runner,
    // for this CLI no less than for claude-code.
    it('forwards the OTEL endpoint to the opencode runner too', () => {
        const line = dockerArgs(
            loadDriverConfig({ RUNNER_OTEL_ENDPOINT: 'http://collector:4318' }),
            opencodeJob,
            null,
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']));
    });
});

/*
 * The report has to fit the board's 128 KiB body limit whatever the log contained — a refused
 * report leaves the job to its lease and re-runs finished work, which is worse than a short log.
 * A character count cannot state that bound: 64 Ki of CJK text is 192 KiB of UTF-8, and a control
 * character expands six-fold under JSON escaping. Hence bytes.
 */
describe('the report tail', () => {
    it('answers nothing for a log that already fits', () => {
        expect(tailBytes('hello', 64)).toBe('hello');
        // Multibyte text, well under the limit, comes back exactly as it went in.
        expect(tailBytes('café ☕', 64)).toBe('café ☕');
    });

    it('caps by UTF-8 bytes, not by characters', () => {
        // Each ☕ is three bytes: 10_000 of them are 30_000 bytes in only 10_000 characters.
        const log = '☕'.repeat(10_000);
        const tail = tailBytes(log, 16 * 1024);

        expect(tail.length).toBeLessThan(log.length);
        expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    });

    it('keeps the tail, not the head', () => {
        expect(tailBytes('head-head-head-tail', 4)).toBe('tail');
    });

    it('cuts at a character boundary: a multibyte character split by the limit is dropped whole (#825)', () => {
        // Each ☕ is three bytes, so a 4-byte limit lands inside the second-to-last one.
        expect(tailBytes('☕'.repeat(100), 4)).toBe('☕');
        const kept = tailKept('€'.repeat(ARTIFACT_LIMIT), ARTIFACT_LIMIT);
        expect(kept.truncated).toBe(true);
        expect(Buffer.byteLength(kept.content, 'utf8')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(kept.content).not.toContain('�');
    });

    it('reportTail fits a JSON-escaped complete POST under the board body limit', () => {
        // The worst log: three-byte characters, then control characters that JSON escaping
        // expands six-fold.
        const worst = 'あ\u0001'.repeat(64 * 1024);
        const body = JSON.stringify({
            leaseToken: '22222222-2222-4222-8222-222222222222',
            status: 'succeeded',
            exitCode: 0,
            output: reportTail(worst),
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
    });
});
