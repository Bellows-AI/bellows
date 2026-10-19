import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MAILBOX_DIR, GO_MARKER, MAILBOX_FILES, MAILBOXES } from '../src/supervisor-contract.js';
import { agentLaunchArgs, containerHardeningArgs } from '../src/docker.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/*
 * The scripted model endpoint behind the `test:jobs` cooperative-Stop lane (issue #442). The lane
 * itself needs docker and the real CLIs; what is pinned here is the endpoint's protocol, so a lane
 * failure is never the stub's fault, and the lane's wiring.
 */
const ENDPOINT = join(ROOT, 'scripts/fake-model-endpoint.mjs');
/** The step ids the supervisor accepts (`STEP_ID` of supervisor.cjs). */
const STEP_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise: (env: Record<string, string>, log: (line: string) => void) => Promise<number>;
};

interface Endpoint {
    agentRequests: number;
    listen: (port?: number, host?: string) => Promise<number>;
    close: () => Promise<void>;
}
const open: Endpoint[] = [];
afterEach(async () => {
    for (const endpoint of open.splice(0)) await endpoint.close();
});

async function start(
    options: { firstDelayMs?: number; toolSteps?: number; ask?: boolean; askProse?: boolean; killTools?: boolean } = {}
) {
    const { createFakeModelEndpoint } = (await import(pathToFileURL(ENDPOINT).href)) as {
        createFakeModelEndpoint: (options: object) => Endpoint;
    };
    const endpoint = createFakeModelEndpoint(options);
    open.push(endpoint);
    const port = await endpoint.listen(0, '127.0.0.1');
    return { endpoint, url: `http://127.0.0.1:${port}` };
}

const agentRequest = (url: string, stream: boolean) =>
    fetch(`${url}/v1/messages?beta=true`, {
        method: 'POST',
        body: JSON.stringify({ stream, tools: [{ name: 'Bash' }, { name: 'Read' }], messages: [] }),
    });

describe('the scripted model endpoint', () => {
    it('answers tool calls for the scripted steps, then ends the turn in text', async () => {
        const { endpoint, url } = await start({ toolSteps: 2 });

        const first = (await (await agentRequest(url, false)).json()) as {
            stop_reason: string;
            content: { name?: string; input?: { command: string } }[];
        };
        const second = (await (await agentRequest(url, false)).json()) as typeof first;
        const third = (await (await agentRequest(url, false)).json()) as typeof first;

        expect(first.stop_reason).toBe('tool_use');
        expect(first.content[0]).toMatchObject({ name: 'Bash', input: { command: 'touch step-1' } });
        expect(second.content[0]!.input?.command).toBe('touch step-2');
        expect(third.stop_reason).toBe('end_turn');
        expect(endpoint.agentRequests).toBe(3);
    });

    it('streams the same answer as server-sent events', async () => {
        const { url } = await start();

        const body = await (await agentRequest(url, true)).text();

        expect(body).toContain('event: message_start');
        expect(body).toContain('"type":"tool_use"');
        expect(body).toContain('"partial_json":"{\\"command\\":\\"touch step-1\\"');
        expect(body.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    });

    it('counts only requests that carry tools, and raises the stop inside the first step', async () => {
        const { endpoint, url } = await start({ firstDelayMs: 150 });
        const control = async () => ((await (await fetch(`${url}/control`)).json()) as { stop: boolean }).stop;

        expect(await control()).toBe(false);
        await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ stream: false, messages: [] }) });
        expect(endpoint.agentRequests).toBe(0);
        expect(await control()).toBe(false);

        const pending = agentRequest(url, false);
        await new Promise((resolve) => setTimeout(resolve, 40));
        // The first agent request is still being held: the Stop is already up, mid-step.
        expect(await control()).toBe(true);
        expect(endpoint.agentRequests).toBe(0);
        await pending;
        expect(endpoint.agentRequests).toBe(1);
        await expect((await fetch(`${url}/requests`)).json()).resolves.toEqual({ agentRequests: 1 });
    });
});

describe('the scripted model endpoint in kill-tools mode (issue #814)', () => {
    const KILLING_STEP =
        /^kill -TERM 1 2>\/dev\/null; kill -KILL -1 2>\/dev\/null; echo FACTORY_TOOL_OK; touch step-1$/;
    const toolResult = (id: string, text: string) => ({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    });
    const killRequest = (url: string, messages: unknown[]) =>
        fetch(`${url}/v1/messages`, {
            method: 'POST',
            body: JSON.stringify({ stream: false, tools: [{ name: 'Bash' }], messages }),
        }).then((response) => response.json() as Promise<{ content: { input?: { command: string } }[] }>);

    it('has each scripted tool call kill everything its uid may signal, then report and mark the step', async () => {
        const { url } = await start({ killTools: true, toolSteps: 2 });
        const first = await killRequest(url, []);
        expect(first.content[0]!.input?.command).toMatch(KILLING_STEP);
    });

    it('counts each tool result that came back with the marker once, however often the history resends it', async () => {
        const { url } = await start({ killTools: true, toolSteps: 3 });
        const results = async () =>
            ((await (await fetch(`${url}/tool-results`)).json()) as { toolResults: number }).toolResults;
        await killRequest(url, []);
        await killRequest(url, [toolResult('toolu_1', 'FACTORY_TOOL_OK')]);
        await killRequest(url, [toolResult('toolu_1', 'FACTORY_TOOL_OK'), toolResult('toolu_2', 'Killed')]);
        await killRequest(url, [
            toolResult('toolu_1', 'FACTORY_TOOL_OK'),
            toolResult('toolu_2', 'Killed'),
            { role: 'assistant', content: [{ type: 'text', text: 'next' }] },
            toolResult('toolu_3', 'FACTORY_TOOL_OK'),
            { role: 'user', content: 'a reminder after the result' },
        ]);
        expect(await results()).toBe(2);
    });

    it('never raises a Stop: the run must end on its own', async () => {
        const { url } = await start({ killTools: true });
        await killRequest(url, []);
        expect(((await (await fetch(`${url}/control`)).json()) as { stop: boolean }).stop).toBe(false);
    });
});

describe('the scripted model endpoint in ask mode (issue #226)', () => {
    const askRequest = (url: string, messages: unknown[]) =>
        fetch(`${url}/v1/messages`, {
            method: 'POST',
            body: JSON.stringify({ stream: false, tools: [{ name: 'AskUserQuestion' }, { name: 'Bash' }], messages }),
        }).then((response) => response.json() as Promise<{ stop_reason: string; content: Record<string, any>[] }>);

    it('asks one Red-or-Blue question first, then reports the answer the tool_result carries', async () => {
        const { url } = await start({ ask: true });

        const first = await askRequest(url, []);
        expect(first.stop_reason).toBe('tool_use');
        expect(first.content[0]).toMatchObject({ type: 'tool_use', name: 'AskUserQuestion' });
        const [question] = first.content[0]!.input.questions;
        expect(question.options.map((option: { label: string }) => option.label)).toEqual(['Red', 'Blue']);

        const answered = await askRequest(url, [
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'User answered: "Blue"' }],
            },
        ]);
        expect(answered.content[0]!.text).toBe('ANSWER=Blue');

        const unanswered = await askRequest(url, [
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'denied', is_error: true }],
            },
        ]);
        expect(unanswered.content[0]!.text).toBe('ANSWER=missing');
    });

    it('plays the board: pending on the first poll, then answered, with the POSTs counted', async () => {
        const { url } = await start({ ask: true });
        const poll = async () =>
            (await fetch(`${url}/question/toolu_ask`)).json() as Promise<{ state: string; answers?: object }>;
        const posts = async () =>
            ((await (await fetch(`${url}/questions`)).json()) as { questionPosts: number }).questionPosts;

        expect(await posts()).toBe(0);
        await fetch(`${url}/question`, { method: 'POST', body: '{}' });
        expect(await posts()).toBe(1);
        expect(await poll()).toEqual({ state: 'pending' });
        expect(await poll()).toEqual({
            state: 'answered',
            answers: { 'Which colour should the report use?': 'Blue' },
        });
    });

    // The executor entrypoint's stop poller reads /control too: a Stop raised here would make the
    // bridge deny the question as stopped, and the ask lane would never see its answer.
    it('never raises a Stop while it plays the question', async () => {
        for (const mode of [{ ask: true }, { askProse: true }]) {
            const { url } = await start(mode);
            await askRequest(url, []);
            expect(((await (await fetch(`${url}/control`)).json()) as { stop: boolean }).stop).toBe(false);
        }
    });
});

describe('the scripted model endpoint in ask-prose mode (issue #226)', () => {
    const request = (url: string, body: object) =>
        fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ stream: false, ...body }) }).then(
            (response) => response.json() as Promise<{ stop_reason: string; content: Record<string, any>[] }>
        );
    const agent = (url: string) =>
        request(url, { tools: [{ name: 'AskUserQuestion' }, { name: 'Bash' }], messages: [] });
    const hook = (url: string) =>
        request(url, {
            messages: [{ role: 'user', content: 'You decide whether an autonomous coding agent may stop.' }],
        });
    const hooks = async (url: string) =>
        ((await (await fetch(`${url}/hooks`)).json()) as { hookRequests: number }).hookRequests;

    it('ends the first turn on the prose question, then asks AskUserQuestion after the hook blocks', async () => {
        const { endpoint, url } = await start({ askProse: true });

        const first = await agent(url);
        expect(first.stop_reason).toBe('end_turn');
        expect(first.content[0]!.text).toBe('Which one should I use: Red or Blue?');

        const verdict = await hook(url);
        expect(JSON.parse(verdict.content[0]!.text)).toMatchObject({ ok: false });
        expect(await hooks(url)).toBe(1);

        // The CLI's continuation quotes the hook prompt back as "Stop hook feedback", tools attached:
        // an agent step, not a second evaluation.
        const second = await request(url, {
            tools: [{ name: 'AskUserQuestion' }, { name: 'Bash' }],
            messages: [
                {
                    role: 'user',
                    content: 'Stop hook feedback:\n[You decide whether an autonomous coding agent may stop.]',
                },
            ],
        });
        expect(second.content[0]).toMatchObject({ type: 'tool_use', name: 'AskUserQuestion' });
        expect(await hooks(url)).toBe(1);

        // The evaluation after the answer is stop_hook_active territory: allowed, not an agent request.
        expect(JSON.parse((await hook(url)).content[0]!.text)).toEqual({ ok: true });
        expect(endpoint.agentRequests).toBe(2);
    });
});

describe('the scripted model endpoint as the step channel (issue #812)', () => {
    const poll = async (url: string, wait = 0) =>
        (await (await fetch(`${url}/step?wait=${wait}`)).json()) as {
            step?: { id: string; kind: string; argv: unknown[] };
        };
    const post = (url: string, path: string, body: object) =>
        fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });

    it('releases the agent on the first poll, then finishes once the supervisor reports', async () => {
        const { url } = await start();

        const go = await poll(url);
        expect(go.step).toMatchObject({ kind: 'go', argv: [] });
        expect(go.step!.id).toMatch(STEP_ID);
        expect(await poll(url)).toEqual({});

        const acked = await post(url, `/step/${go.step!.id}`, { exitCode: 0, stdout: '', stderr: '', timedOut: false });
        expect(acked.status).toBe(200);
        expect(await acked.json()).toEqual({ ok: true });

        // A poll held open when the report lands is answered with the finish at once.
        const held = poll(url, 10_000);
        const reported = await post(url, '/report', { agentEnd: 'exit', drained: true });
        expect(await reported.json()).toEqual({ ok: true });
        const finish = await held;
        expect(finish.step).toMatchObject({ kind: 'finish', argv: [] });
        expect(finish.step!.id).toMatch(STEP_ID);
        expect(await poll(url)).toEqual({});
    });

    it('drops a held poll whose client went away, so the finish reaches the live poll', async () => {
        const { url } = await start();
        await poll(url);

        const cancel = new AbortController();
        const gone = fetch(`${url}/step?wait=10000`, { signal: cancel.signal }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
        cancel.abort();
        await gone;
        await new Promise((resolve) => setTimeout(resolve, 50));

        const live = poll(url, 10_000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await post(url, '/report', { agentEnd: 'exit', drained: true });
        expect((await live).step).toMatchObject({ kind: 'finish' });
    });

    it('drives the real supervisor from go to its exit', async () => {
        const { url } = await start();
        const root = mkdtempSync(join(tmpdir(), 'lane-group-'));
        const box = (name: keyof typeof MAILBOXES) => join(root, MAILBOXES[name].path.split('/').pop()!);
        try {
            const done = supervisor.supervise(
                {
                    FACTORY_CTL_ROOT: root,
                    SUPERVISOR_CONTROL_URL: url,
                    SUPERVISOR_CONTROL_TOKEN: 'lane',
                    SUPERVISOR_TICK_MS: '10',
                    SUPERVISOR_CONTROL_MS: '10',
                    SUPERVISOR_STEP_WAIT_MS: '200',
                    // The endpoint answers every call, so only a failed run ever reaches this: it
                    // keeps a stray supervisor from outliving the test by the default 90s.
                    SUPERVISOR_ORPHAN_MS: '2000',
                },
                () => {}
            );
            await vi.waitFor(
                () => expect(existsSync(join(box('in'), AGENT_MAILBOX_DIR, MAILBOX_FILES.go))).toBe(true),
                {
                    timeout: 5000,
                }
            );
            writeFileSync(join(box('out'), AGENT_MAILBOX_DIR, MAILBOX_FILES.agentExit), '0\n');

            await expect(done).resolves.toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('the test-jobs ask lane', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

    it('runs the real claude image against the endpoint in ask mode', () => {
        expect(script).toContain('ask_lane');
        expect(script).toContain('ask_lane tool --ask');
        expect(script).toContain('fake-model-endpoint.mjs "$flag"');
        expect(script).toContain('ANSWER=Blue');
    });

    it('runs the prose mode through the Stop hook', () => {
        expect(script).toContain('ask_lane prose --ask-prose');
        expect(script).toContain('the Stop hook turned the prose question into AskUserQuestion');
    });
});

describe('the test-jobs cooperative-Stop lane', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

    it('drives both real executor images against the scripted endpoint', () => {
        expect(script).toContain('scripts/fake-model-endpoint.mjs');
        expect(script).toContain('stop_lane claude');
        expect(script).toContain('stop_lane opencode');
        expect(script).toContain('makes no model request after the stop');
    });

    // The real entrypoints wait on the go marker the endpoint's `go` order makes the supervisor write.
    it('gives the agent the go marker its entrypoint waits on', () => {
        expect(script).toContain(`-e FACTORY_CTL_GO=${GO_MARKER}`);
    });
});

describe('the tool-isolation lanes (issue #814)', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');
    const checks = readFileSync(join(ROOT, 'docker/tool-isolation-checks.sh'), 'utf8');
    /** The flag pairs the driver starts the agent container with (dockerArgs). */
    const driverPairs = (() => {
        const argv = [...containerHardeningArgs(), ...agentLaunchArgs()];
        return argv.flatMap((arg, i) => (i % 2 === 0 ? [`${arg} ${argv[i + 1]}`] : []));
    })();
    const lanePairs = (source: string) => {
        const line = source.split('\n').find((l) => l.startsWith('AGENT_FLAGS=('))!;
        const argv = line.slice('AGENT_FLAGS=('.length, -1).split(' ');
        return argv.flatMap((arg, i) => (i % 2 === 0 ? [`${arg} ${argv[i + 1]}`] : [])).sort();
    };

    it('runs both real CLIs isolated and as the honest control, in kill-tools mode', () => {
        for (const run of ['claude control', 'claude isolated', 'opencode control', 'opencode isolated']) {
            expect(script).toContain(`kill_lane ${run}`);
        }
        expect(script).toContain('fake-model-endpoint.mjs --kill-tools --tool-steps 2');
    });

    it('starts the agent with exactly the driver’s own agent flags, in the lane and in the image checks', () => {
        expect(lanePairs(script)).toEqual([...driverPairs].sort());
        expect(lanePairs(checks)).toEqual([...driverPairs].sort());
    });

    /** kill_lane's verdict for the control, run in bash with `ok`/`bad` stubbed to name which fired. */
    const controlVerdict = (status: number, counts: string, markers: string[]) => {
        const start = script.indexOf('kill_lane() {');
        const lane = script.slice(start, script.indexOf('\n}', start) + '\n}'.length);
        const verdict = lane.slice(lane.indexOf('    if [ "$mode" = isolated ]; then\n'), lane.lastIndexOf('\n}'));
        const dir = mkdtempSync(join(tmpdir(), 'kill-lane-'));
        try {
            for (const marker of markers) writeFileSync(join(dir, marker), '');
            return execFileSync('bash', ['-c', `ok() { echo ok; }\nbad() { echo bad; }\n${verdict}`], {
                env: { ...process.env, mode: 'control', cli: 'claude', status: String(status), counts, dir },
                encoding: 'utf8',
            }).trim();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };

    // A CLI that fails before its first model request kills nothing, one that reports the first
    // tool's result outlived it, and one the lane's own timeout ended (124) hung rather than died.
    // The first tool's own marker is not required: dying with PID 1 can end its shell before
    // `touch step-1`.
    it('passes the control only on a signal death after one agent request and no tool result', () => {
        expect(controlVerdict(1, '0 0', [])).toBe('bad');
        expect(controlVerdict(137, '2 1', ['step-1'])).toBe('bad');
        expect(controlVerdict(124, '1 0', [])).toBe('bad');
        expect(controlVerdict(1, '1 0', [])).toBe('bad');
        expect(controlVerdict(137, '1 0', [])).toBe('ok');
        expect(controlVerdict(143, '1 0', ['step-1'])).toBe('ok');
    });
});
