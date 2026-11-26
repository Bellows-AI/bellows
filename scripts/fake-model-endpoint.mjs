// A scripted, Anthropic-compatible model endpoint for the real agent CLIs.
//
//   node scripts/fake-model-endpoint.mjs [--port N] [--first-delay-ms N] [--tool-steps N] [--ask] [--ask-prose] [--kill-tools] [--probe-files a,b,…] [--steps '<json>'] [--skill-sentinel TEXT[,TEXT…]] [--finish-gate]
//
// Offline and deterministic, no credential: `claude` and `opencode` point their Anthropic base URL
// at it and run a real agent loop against canned answers. The first `--tool-steps` model requests
// that carry tools answer with one Bash tool call (`touch step-N` in the agent's working
// directory); the request after those answers plain text and ends the turn. Requests without
// tools (title generation, quota probes) get a short text answer and are not counted, so
// `GET /requests` is exactly the number of agent model requests — what a cooperative Stop must
// keep from growing. `GET /control` plays the driver's run-control endpoint: it answers
// `{"stop":true}` from the moment the first agent request arrives — never in the question modes.
//
// `--ask` is the AskUserQuestion mode: the first agent reply is an AskUserQuestion
// tool call (one question, options Red and Blue), `POST /question` records the question, and
// `GET /question/<id>` plays the board — pending on the first poll, then answered "Blue". The
// request after the tool call must carry, in any of its messages, a tool_result for the tool call
// containing "Blue"; the model then says `ANSWER=Blue`, otherwise `ANSWER=missing`. `GET /questions` is
// the number of POSTs received. `GET /asks` lists each ask-mode agent request's last three messages (role
// and block types), whether the answer was found, and the tool_result text, for a lane to keep as evidence.
//
// `--ask-prose` is the plain-text variant: the first agent reply is prose ending "Which one should
// I use: Red or Blue?" with `end_turn`, so the baked Stop hook runs. The endpoint plays the hook's
// evaluator too: a tool-less request carrying the hook's prompt text is answered `{"ok": false, …}` the
// first time and `{"ok": true}` after, and is not an agent request. The next agent request then
// calls AskUserQuestion, and the run goes on as in `--ask`. `GET /hooks` counts the evaluations.
//
// `--kill-tools` is the tool-isolation mode: each scripted Bash call is
// `kill -TERM 1 2>/dev/null; kill -KILL -1 2>/dev/null; echo FACTORY_TOOL_OK; touch step-N` — it signals
// everything its uid may, then reports — and `GET /control` never raises a Stop, so the run must end
// on its own. `GET /tool-results` counts the tool calls whose result came back carrying
// FACTORY_TOOL_OK: a tool killed with the CLI, or a CLI killed by its tool, never reports one.
//
// `--probe-files a,b,…` is the skill-helper mode: the one scripted Bash call opens each path
// in turn as the tool uid and prints one `PROBE <n> <outcome>` line each (1-based, in the order given;
// outcome `open`, `denied` for "Permission denied", or `other: <error>`), then FACTORY_TOOL_OK; like --kill-tools it never raises a Stop. The
// tool's cwd is not writable by the tool uid, so the outcome travels in the result: `GET /tool-results`
// returns it as `text`.
//
// `--steps '[{"tool":"Bash","input":{"command":"…"}},…]'` is the scripted-tools mode: model request N
// calls the N-th step's tool (matched by name, case-insensitively, among the tools the CLI offers) with that input,
// and the request after the last step answers `done`. Unlike the modes above it can call any tool — the CLI's own
// Read, Write, Skill — so a lane can drive the seam between the CLI's file tools and its Bash tool. `GET /steps`
// returns every result that came back, `{results: [{id, isError, text}], skillBases: [dir, …]}` in step order, the second the
// "Base directory for this skill" line of each skill the Skill tool loaded; like --kill-tools it
// never raises a Stop.
//
// `--skill-sentinel TEXT[,TEXT…]` is the skill mode: whatever else the run does, `GET /skills-seen`
// returns `{seen, seenSentinels, agentRequests}` — `seenSentinels` lists each TEXT that any agent request's body (system
// prompt, tool descriptions, messages) carried, i.e. each one the CLI told the model about in a skill description;
// `seen` is true once any did; `sentinelCounts` maps each TEXT to its occurrences in the one agent request that carried
// the most of it, so a skill listed twice reads 2.
//
// `--finish-gate` is the in-run finish mode, for a task whose declared gate passes only once `.lane-finish` exists:
// the first three agent requests answer one Bash call each — `factory-gate --list`, `factory-gate lane-adhoc` (the
// lane's `on_demand` gate, red: the file is not there yet) and `factory-exec 'echo lane-exec-ok'` — the next one
// Bash call that changes the tree without that file, the next ends the turn in
// text, so the finish pass sees a change and a red gate. A user turn carrying the driver's gate-failure message (the
// claude Stop hook's block reason, or the prompt of opencode's relaunched run) is answered with one Bash call
// `touch .lane-finish`, then the turn ends again. State is read from the history the CLI sends, never from a
// counter, so a resent history changes nothing. The Stop hook's own evaluation is answered `{"ok": true}`, and
// `GET /control` never raises a Stop. `GET /finish-gate` returns `{agentRequests, fixCalls, failures, toolResults}`:
// each failure message seen as `{gate, round, limit, sameSession}`, the last true when that request's history also
// holds the work turn's tool call — the same session continued, not a fresh one; `toolResults` `{list, gate, exec}`
// holds the text each of the three tool calls came back with, null until it did.
//
// In every mode it plays the driver's step channel too (driver/src/step-control.ts), as much as a
// lane group needs: `GET /step` hands out `go` on the first poll and `finish` once `POST /report`
// arrives, and holds any other poll up to its `wait`; `POST /step/<id>` is acknowledged.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const MESSAGES_PATH = '/v1/messages';
/** The OpenAI-wire paths the `--openai` mode serves beside the Anthropic one . */
const OPENAI_CHAT_PATH = '/v1/chat/completions';
const OPENAI_MODELS_PATH = '/v1/models';
const LANE_OPENAI_MODEL = 'fake-model';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const REQUESTS_PATH = '/requests';
const CONTROL_PATH = '/control';
const QUESTION_PATH = '/question';
const QUESTIONS_PATH = '/questions';
const HOOKS_PATH = '/hooks';
const ASKS_PATH = '/asks';
const ASK_TOOL_USE_ID = 'toolu_ask';
const TOOL_RESULTS_PATH = '/tool-results';
const STEPS_PATH = '/steps';
const SKILLS_SEEN_PATH = '/skills-seen';
const TOOL_OK = 'FACTORY_TOOL_OK';
const STEP_PATH = '/step';
const REPORT_PATH = '/report';
/** The longest a step poll is held, whatever `wait` it asks for. */
const STEP_HOLD_MAX_MS = 30_000;
const orderOf = (kind) => ({ step: { id: `lane-${kind}`, invocation: 'lane-1', kind, argv: [], env: {}, timeoutMs: 10_000 } });
const BASH_TOOL = /^bash$/i;
const ASK_TOOL = 'AskUserQuestion';
const ASK_QUESTION = 'Which colour should the report use?';
const ASK_ANSWER = 'Blue';
const PROSE_QUESTION = 'Which one should I use: Red or Blue?';
/** The opening of the baked Stop hook's prompt (docker/claude-executor/claude-home/settings.json). */
const STOP_HOOK_PROMPT = 'You decide whether an autonomous coding agent may stop.';
const STOP_HOOK_BLOCK = {
    ok: false,
    reason: 'The person cannot reply to plain text and this run ends when you stop. Call the AskUserQuestion tool now with the question and its options.',
};

const FINISH_PATH = '/finish-gate';
const FINISH_WORK_ID = 'toolu_finish_work';
const FINISH_FIX_ID = 'toolu_finish_fix_';
/** The factory tool calls the finish-gate mode opens with, once each: `[toolResults key, tool call id, command]`. */
const FINISH_TOOL_CALLS = [
    ['list', 'toolu_finish_list', 'factory-gate --list'],
    ['gate', 'toolu_finish_gate', 'factory-gate lane-adhoc'],
    ['exec', 'toolu_finish_exec', "factory-exec 'echo lane-exec-ok'"],
];
/**
 * The driver's finish-pass failure message (driver/src/loop/loop-finish.ts) inside a JSON body: its quotes come
 * escaped once, or twice when the CLI quoted the prompt itself (opencode run sends its argument JSON-encoded).
 */
const FINISH_FAILURE = /The \\*"([^"\\]+)\\*" gate failed \(round (\d+) of (\d+)\)/;

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const message = (id, content, stopReason) => ({
    id,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
});

/** The streaming form of one assistant message, block by block. */
function streamOf(reply) {
    const blocks = reply.content;
    let out = sse('message_start', { type: 'message_start', message: { ...reply, content: [] } });
    blocks.forEach((block, index) => {
        if (block.type === 'tool_use') {
            out += sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            });
            out += sse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            });
        } else {
            out += sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
            });
            out += sse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: block.text },
            });
        }
        out += sse('content_block_stop', { type: 'content_block_stop', index });
    });
    out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reply.stop_reason, stop_sequence: null },
        usage: { output_tokens: 1 },
    });
    return out + sse('message_stop', { type: 'message_stop' });
}

/** One shell line that probes each path with `cat` and prints its outcome. */
export function probeCommand(paths) {
    const quoted = paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ');
    return (
        `n=0; for f in ${quoted}; do n=$((n+1)); if err=$(cat "$f" 2>&1 >/dev/null); then echo "PROBE $n open"; ` +
        `else case "$err" in *"Permission denied"*) echo "PROBE $n denied";; *) echo "PROBE $n other: $err";; esac; fi; done; echo ${TOOL_OK}`
    );
}

/** A tool result's text: a string as sent, text blocks joined by newlines, anything else as JSON. */
const textOf = (content) =>
    typeof content === 'string'
        ? content
        : Array.isArray(content) && content.every((block) => typeof block?.text === 'string')
          ? content.map((block) => block.text).join('\n')
          : JSON.stringify(content ?? '');

export function createFakeModelEndpoint({ firstDelayMs = 0, toolSteps = 3, ask = false, askProse = false, killTools = false, probeFiles = [], steps = [], skillSentinels = [], finishGate = false, openai = false } = {}) {
    let agentRequests = 0;
    /** Each gate-failure message answered with a fix, in order. */
    const finishFailures = [];
    /** The text each finish-gate tool call came back with, by its toolResults key. */
    const finishToolResults = { list: null, gate: null, exec: null };
    const sentinelsSeen = new Set();
    /** Each sentinel's occurrences in the agent request that carried the most of it. */
    const sentinelCounts = {};
    /** The tool calls whose result carried TOOL_OK, by id: a resent history counts each once. */
    const reportedOk = new Set();
    /** The text of every tool result that carried TOOL_OK, by id. */
    const reportedText = new Map();
    /** Every tool result of the scripted steps, by tool call id: a resent history counts each once. */
    const stepResults = new Map();
    /** The base directory every loaded skill named, as the CLI printed it. */
    const skillBases = new Set();
    let hookRequests = 0;
    let questionPosts = 0;
    const askRequests = [];
    let questionPolls = 0;
    /** True from the moment the first agent request arrives — what `GET /control` raises a Stop on. */
    let firstInFlight = false;
    let goServed = false;
    let reported = false;
    let finishServed = false;
    /** Step polls held open until the report arrives or their wait runs out. */
    const heldPolls = new Set();
    const nextOrder = () => {
        if (!goServed) {
            goServed = true;
            return orderOf('go');
        }
        if (reported && !finishServed) {
            finishServed = true;
            return orderOf('finish');
        }
        return null;
    };
    const servePoll = (reply, waitMs) => {
        reply.setHeader('content-type', 'application/json');
        const order = nextOrder();
        if (order || finishServed || waitMs <= 0) return reply.end(JSON.stringify(order ?? {}));
        const held = {
            answer: (body) => {
                clearTimeout(held.timer);
                heldPolls.delete(held);
                reply.end(JSON.stringify(body));
            },
        };
        held.timer = setTimeout(() => held.answer({}), Math.min(waitMs, STEP_HOLD_MAX_MS));
        heldPolls.add(held);
        reply.once('close', () => {
            clearTimeout(held.timer);
            heldPolls.delete(held);
        });
    };
    const askReply = (step, tools, messages) => {
        // The answer is the toolu_ask tool_result wherever it sits in the request: a CLI that appends a message
        // after it (suspected, unconfirmed) must not read as a missing answer. A malformed request is `missing`.
        const blocks = (Array.isArray(messages) ? messages : []).flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : []));
        const found = blocks.find((block) => block?.type === 'tool_result' && block.tool_use_id === ASK_TOOL_USE_ID);
        const result = found ? (typeof found.content === 'string' ? found.content : JSON.stringify(found.content ?? '')) : null;
        const answerFound = result?.includes(ASK_ANSWER) === true;
        const list = Array.isArray(messages) ? messages : [];
        askRequests.push({
            step,
            tail: list.slice(-3).map((entry) => ({
                role: typeof entry?.role === 'string' ? entry.role : null,
                types: Array.isArray(entry?.content) ? entry.content.map((block) => String(block?.type)) : [typeof entry?.content],
            })),
            answerFound,
            result,
        });
        if (askProse && step === 1) {
            return message('msg_prose', [{ type: 'text', text: PROSE_QUESTION }], 'end_turn');
        }
        if (step === (askProse ? 2 : 1) && tools.some((tool) => tool.name === ASK_TOOL)) {
            const questions = [
                {
                    question: ASK_QUESTION,
                    header: 'Colour',
                    multiSelect: false,
                    options: [
                        { label: 'Red', description: 'A red report' },
                        { label: ASK_ANSWER, description: 'A blue report' },
                    ],
                },
            ];
            return message('msg_ask', [{ type: 'tool_use', id: 'toolu_ask', name: ASK_TOOL, input: { questions } }], 'tool_use');
        }
        return message(`msg_${step}`, [{ type: 'text', text: `ANSWER=${answerFound ? ASK_ANSWER : 'missing'}` }], 'end_turn');
    };
    const finishReply = (step, tools, messages) => {
        const bash = tools.find((tool) => BASH_TOOL.test(tool.name));
        const called = messages
            .filter((entry) => entry?.role === 'assistant' && Array.isArray(entry.content))
            .flatMap((entry) => entry.content)
            .filter((block) => block?.type === 'tool_use' && typeof block.id === 'string')
            .map((block) => block.id);
        const fixes = called.filter((id) => id.startsWith(FINISH_FIX_ID)).length;
        const failures = messages
            .filter((entry) => entry?.role === 'user')
            .map((entry) => FINISH_FAILURE.exec(JSON.stringify(entry.content ?? '')))
            .filter(Boolean);
        for (const block of messages.flatMap((entry) => (entry?.role === 'user' && Array.isArray(entry.content) ? entry.content : []))) {
            const tool = FINISH_TOOL_CALLS.find(([, id]) => block?.type === 'tool_result' && block.tool_use_id === id);
            if (tool && finishToolResults[tool[0]] === null) finishToolResults[tool[0]] = textOf(block.content);
        }
        const call = (id, command) =>
            message(`msg_${step}`, [{ type: 'tool_use', id, name: bash.name, input: { command, description: 'change the tree' } }], 'tool_use');
        const tool = FINISH_TOOL_CALLS.find(([, id]) => !called.includes(id));
        if (bash && tool && failures.length === 0 && !called.includes(FINISH_WORK_ID)) return call(tool[1], tool[2]);
        if (bash && failures.length > fixes) {
            const [, gate, round, limit] = failures[failures.length - 1];
            finishFailures.push({ gate, round: Number(round), limit: Number(limit), sameSession: called.includes(FINISH_WORK_ID) });
            return call(`${FINISH_FIX_ID}${failures.length}`, 'touch .lane-finish');
        }
        if (bash && !called.includes(FINISH_WORK_ID)) return call(FINISH_WORK_ID, 'echo lane work > lane-finish-work.txt');
        return message(`msg_${step}`, [{ type: 'text', text: 'done' }], 'end_turn');
    };
    const agentReply = (tools, messages) => {
        const step = ++agentRequests;
        if (ask || askProse) return askReply(step, tools, messages);
        if (finishGate) return finishReply(step, tools, messages);
        for (const block of messages.flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : []))) {
            if (block?.type === 'tool_result' && JSON.stringify(block.content ?? '').includes(TOOL_OK)) {
                reportedOk.add(block.tool_use_id);
                reportedText.set(block.tool_use_id, typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
            }
        }
        if (steps.length > 0) {
            for (const block of messages.flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : []))) {
                if (block?.type !== 'tool_result') continue;
                const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content ?? '' }];
                const text = parts.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
                stepResults.set(block.tool_use_id, { id: block.tool_use_id, isError: block.is_error === true, text });
            }
            // A loaded skill's text arrives as a user message of its own, opening with where the CLI found it.
            for (const match of JSON.stringify(messages).matchAll(/Base directory for this skill: ([^\\"]+)/g)) {
                skillBases.add(match[1]);
            }
            const wanted = steps[step - 1];
            const tool = wanted && tools.find((entry) => entry.name.toLowerCase() === wanted.tool.toLowerCase());
            if (!wanted) return message(`msg_${step}`, [{ type: 'text', text: 'done' }], 'end_turn');
            if (!tool) {
                return message(`msg_${step}`, [{ type: 'text', text: `missing tool ${wanted.tool}` }], 'end_turn');
            }
            return message(`msg_${step}`, [{ type: 'tool_use', id: `toolu_${step}`, name: tool.name, input: wanted.input }], 'tool_use');
        }
        const bash = tools.find((tool) => BASH_TOOL.test(tool.name));
        if (step <= toolSteps && bash) {
            const command = probeFiles.length > 0
                ? probeCommand(probeFiles)
                : killTools
                ? `kill -TERM 1 2>/dev/null; kill -KILL -1 2>/dev/null; echo ${TOOL_OK}; touch step-${step}`
                : `touch step-${step}`;
            return message(
                `msg_${step}`,
                [{ type: 'tool_use', id: `toolu_${step}`, name: bash.name, input: { command, description: 'touch a marker' } }],
                'tool_use'
            );
        }
        return message(`msg_${step}`, [{ type: 'text', text: 'done' }], 'end_turn');
    };

    const server = createServer((request, reply) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', async () => {
            const url = (request.url ?? '').split('?')[0];
            if (url === STEP_PATH && request.method === 'GET') {
                const wait = Number(new URL(request.url ?? '', 'http://lane').searchParams.get('wait') ?? '0');
                return servePoll(reply, Number.isFinite(wait) ? wait : 0);
            }
            if ((url.startsWith(`${STEP_PATH}/`) || url === REPORT_PATH) && request.method === 'POST') {
                if (url === REPORT_PATH) {
                    reported = true;
                    const [held] = heldPolls;
                    held?.answer(nextOrder() ?? {});
                }
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ ok: true }));
            }
            if (url === REQUESTS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ agentRequests }));
            }
            if (url === CONTROL_PATH) {
                // The driver's control endpoint, played here: a Stop is raised the moment the first
                // agent request arrives, so it always lands INSIDE the first model step. Never in the
                // question modes: the entrypoint's stop poller reads this too, and a Stop would make
                // the bridge deny the question as stopped.
                reply.setHeader('content-type', 'application/json');
                const stop = !ask && !askProse && !killTools && !finishGate && probeFiles.length === 0 && steps.length === 0 && (agentRequests > 0 || firstInFlight);
                return reply.end(JSON.stringify({ stop }));
            }
            if (url === FINISH_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(
                    JSON.stringify({ agentRequests, fixCalls: finishFailures.length, failures: finishFailures, toolResults: finishToolResults })
                );
            }
            if (url === TOOL_RESULTS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ toolResults: reportedOk.size, text: [...reportedText.values()].join('\n') }));
            }
            if (url === STEPS_PATH) {
                reply.setHeader('content-type', 'application/json');
                const results = [...stepResults.values()].sort((a, b) => Number(a.id.split('_')[1]) - Number(b.id.split('_')[1]));
                return reply.end(JSON.stringify({ results, agentRequests, skillBases: [...skillBases] }));
            }
            if (url === SKILLS_SEEN_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ seen: sentinelsSeen.size > 0, seenSentinels: [...sentinelsSeen], sentinelCounts, agentRequests }));
            }
            if (url === ASKS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ asks: askRequests }));
            }
            if (url === HOOKS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ hookRequests }));
            }
            if (url === QUESTIONS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ questionPosts }));
            }
            if (url === QUESTION_PATH && request.method === 'POST') {
                questionPosts += 1;
                reply.setHeader('content-type', 'application/json');
                return reply.end('{}');
            }
            if (url.startsWith(`${QUESTION_PATH}/`) && request.method === 'GET') {
                reply.setHeader('content-type', 'application/json');
                const pending = ++questionPolls === 1;
                return reply.end(
                    JSON.stringify(pending ? { state: 'pending' } : { state: 'answered', answers: { [ASK_QUESTION]: ASK_ANSWER } })
                );
            }
            if (url === COUNT_TOKENS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ input_tokens: 1 }));
            }
            // The OpenAI-wire mode (`--openai`): the same scripted answers in chat-completions form,
            // for an executor whose provider block points an OpenAI-compatible endpoint at this
            // server. Tools arrive as OpenAI function definitions and leave as tool_calls; the
            // step, control and report channels above are unchanged.
            if (openai && url === OPENAI_MODELS_PATH) {
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ object: 'list', data: [{ id: LANE_OPENAI_MODEL, object: 'model' }] }));
            }
            if (openai && request.method === 'POST' && url === OPENAI_CHAT_PATH) {
                let chat = {};
                try {
                    chat = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    // An unparseable body is answered like a tool-less request.
                }
                const functions = (Array.isArray(chat.tools) ? chat.tools : [])
                    .map((tool) => tool?.function?.name ?? tool?.name)
                    .filter((name) => typeof name === 'string');
                const messages = Array.isArray(chat.messages) ? chat.messages : [];
                // OpenAI histories carry the tool result inside a `tool` role message.
                const anthropic = messages.map((entry) =>
                    entry?.role === 'tool'
                        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: entry.tool_call_id, content: entry.content ?? '' }] }
                        : entry
                );
                const answer = agentReply(functions.map((name) => ({ name })), anthropic);
                const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
                const call = answer.content.find((block) => block.type === 'tool_use');
                const finish = call ? 'tool_calls' : 'stop';
                const choices = call
                    ? [
                          {
                              index: 0,
                              message: {
                                  role: 'assistant',
                                  content: null,
                                  tool_calls: [
                                      {
                                          id: call.id,
                                          type: 'function',
                                          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                                      },
                                  ],
                              },
                              finish_reason: finish,
                          },
                      ]
                    : [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }];
                const base = { id: `chatcmpl-${answer.id}`, created: 1, model: chat.model ?? LANE_OPENAI_MODEL };
                if (chat.stream) {
                    reply.setHeader('content-type', 'text/event-stream');
                    const part = (delta, reason) =>
                        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
                    const toolDelta = call
                        ? part({ role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } }] }, null)
                        : part({ role: 'assistant', content: text }, null);
                    return reply.end(`${part({ role: 'assistant' }, null)}${toolDelta}${part({}, finish)}data: [DONE]\n\n`);
                }
                reply.setHeader('content-type', 'application/json');
                return reply.end(JSON.stringify({ ...base, object: 'chat.completion', choices, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            }
            if (request.method !== 'POST' || url !== MESSAGES_PATH) {
                reply.statusCode = 404;
                return reply.end('not found');
            }
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                // An unparseable body is answered like a tool-less request.
            }
            const tools = Array.isArray(body.tools) ? body.tools : [];
            // The Stop hook's evaluation, whatever shape the CLI sends it in: recognised by its prompt
            // on a request with no tools. The agent's continuation after a block quotes the prompt
            // back ("Stop hook feedback") but carries the tools, and is an agent step.
            const isHookRequest = (askProse || finishGate) && tools.length === 0 && JSON.stringify(body).includes(STOP_HOOK_PROMPT);
            const isAgentStep = tools.length > 0 && !isHookRequest;
            // The delay is the "stop during a model step" window: the answer to the FIRST agent
            // request is held, so a Stop raised meanwhile lands inside the step.
            if (isAgentStep && !firstInFlight) {
                firstInFlight = true;
                if (firstDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, firstDelayMs));
            }
            if (isAgentStep && skillSentinels.length > 0) {
                const text = JSON.stringify(body);
                for (const sentinel of skillSentinels) {
                    const count = text.split(sentinel).length - 1;
                    if (count > 0) sentinelsSeen.add(sentinel);
                    sentinelCounts[sentinel] = Math.max(sentinelCounts[sentinel] ?? 0, count);
                }
            }
            const hookAnswer = () => {
                hookRequests += 1;
                const verdict = askProse && hookRequests === 1 ? STOP_HOOK_BLOCK : { ok: true };
                return message('msg_hook', [{ type: 'text', text: JSON.stringify(verdict) }], 'end_turn');
            };
            const answer = isHookRequest ? hookAnswer() : isAgentStep ? agentReply(tools, Array.isArray(body.messages) ? body.messages : []) : message('msg_aux', [{ type: 'text', text: 'ok' }], 'end_turn');
            if (body.stream) {
                reply.setHeader('content-type', 'text/event-stream');
                return reply.end(streamOf(answer));
            }
            reply.setHeader('content-type', 'application/json');
            reply.end(JSON.stringify(answer));
        });
    });

    return {
        get agentRequests() {
            return agentRequests;
        },
        listen: (port = 0, host = '0.0.0.0') =>
            new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
        close: () => {
            for (const held of heldPolls) held.answer({});
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const flag = (name, fallback) => {
        const at = process.argv.indexOf(name);
        return at === -1 ? fallback : Number(process.argv[at + 1]);
    };
    const flagList = (name) => {
        const at = process.argv.indexOf(name);
        return at === -1 ? [] : process.argv[at + 1].split(',').filter(Boolean);
    };
    const endpoint = createFakeModelEndpoint({
        firstDelayMs: flag('--first-delay-ms', 0),
        toolSteps: flag('--tool-steps', 3),
        ask: process.argv.includes('--ask'),
        askProse: process.argv.includes('--ask-prose'),
        killTools: process.argv.includes('--kill-tools'),
        probeFiles: flagList('--probe-files'),
        skillSentinels: flagList('--skill-sentinel'),
        steps: process.argv.includes('--steps') ? JSON.parse(process.argv[process.argv.indexOf('--steps') + 1]) : [],
        finishGate: process.argv.includes('--finish-gate'),
        openai: process.argv.includes('--openai'),
    });
    const port = await endpoint.listen(flag('--port', 0));
    process.stdout.write(`${port}\n`);
}
