// A scripted, Anthropic-compatible model endpoint for the real agent CLIs (issue #442).
//
//   node scripts/fake-model-endpoint.mjs [--port N] [--first-delay-ms N] [--tool-steps N] [--ask] [--ask-prose]
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
// `--ask` is the AskUserQuestion mode (issue #226): the first agent reply is an AskUserQuestion
// tool call (one question, options Red and Blue), `POST /question` records the question, and
// `GET /question/<id>` plays the board — pending on the first poll, then answered "Blue". The
// request after the tool call must carry a tool_result containing "Blue"; the model then says
// `ANSWER=Blue`, otherwise `ANSWER=missing`. `GET /questions` is the number of POSTs received.
//
// `--ask-prose` is the plain-text variant: the first agent reply is prose ending "Which one should
// I use: Red or Blue?" with `end_turn`, so the baked Stop hook runs. The endpoint plays the hook's
// evaluator too: a tool-less request carrying the hook's prompt text is answered `{"ok": false, …}` the
// first time and `{"ok": true}` after, and is not an agent request. The next agent request then
// calls AskUserQuestion, and the run goes on as in `--ask`. `GET /hooks` counts the evaluations.
//
// In every mode it plays the driver's step channel too (driver/src/step-control.ts), as much as a
// lane group needs: `GET /step` hands out `go` on the first poll and `finish` once `POST /report`
// arrives, and holds any other poll up to its `wait`; `POST /step/<id>` is acknowledged.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const REQUESTS_PATH = '/requests';
const CONTROL_PATH = '/control';
const QUESTION_PATH = '/question';
const QUESTIONS_PATH = '/questions';
const HOOKS_PATH = '/hooks';
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

export function createFakeModelEndpoint({ firstDelayMs = 0, toolSteps = 3, ask = false, askProse = false } = {}) {
    let agentRequests = 0;
    let hookRequests = 0;
    let questionPosts = 0;
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
        const result = JSON.stringify(messages.at(-1) ?? {});
        return message(`msg_${step}`, [{ type: 'text', text: `ANSWER=${result.includes(ASK_ANSWER) ? ASK_ANSWER : 'missing'}` }], 'end_turn');
    };
    const agentReply = (tools, messages) => {
        const step = ++agentRequests;
        if (ask || askProse) return askReply(step, tools, messages);
        const bash = tools.find((tool) => BASH_TOOL.test(tool.name));
        if (step <= toolSteps && bash) {
            return message(
                `msg_${step}`,
                [{ type: 'tool_use', id: `toolu_${step}`, name: bash.name, input: { command: `touch step-${step}`, description: 'touch a marker' } }],
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
                const stop = !ask && !askProse && (agentRequests > 0 || firstInFlight);
                return reply.end(JSON.stringify({ stop }));
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
            const isHookRequest = askProse && tools.length === 0 && JSON.stringify(body).includes(STOP_HOOK_PROMPT);
            const isAgentStep = tools.length > 0 && !isHookRequest;
            // The delay is the "stop during a model step" window: the answer to the FIRST agent
            // request is held, so a Stop raised meanwhile lands inside the step.
            if (isAgentStep && !firstInFlight) {
                firstInFlight = true;
                if (firstDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, firstDelayMs));
            }
            const hookAnswer = () => {
                hookRequests += 1;
                const verdict = hookRequests === 1 ? STOP_HOOK_BLOCK : { ok: true };
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
    const endpoint = createFakeModelEndpoint({
        firstDelayMs: flag('--first-delay-ms', 0),
        toolSteps: flag('--tool-steps', 3),
        ask: process.argv.includes('--ask'),
        askProse: process.argv.includes('--ask-prose'),
    });
    const port = await endpoint.listen(flag('--port', 0));
    process.stdout.write(`${port}\n`);
}
