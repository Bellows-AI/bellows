// The one long-lived helper behind `api` and `field` in scripts/lane-lib.sh: it replaces a `node -e` spawn per call.
// argv: <request fifo>. A request is a line on that fifo naming a file of NUL-separated arguments
// (api: base, method, path, body, auth; field: json, key); the answer is written to "<file>.out", then
// "done" goes to the fifo "<file>.resp" the caller waits on. Concurrent callers never share a byte:
// each has its own request file and response fifo. It exits when the last writer of the request fifo closes.
import { createReadStream, openSync, closeSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';

const [fifo] = process.argv.slice(2);

const api = async ([base, method, path, body, auth]) => {
    try {
        const r = await fetch(base + path, {
            method,
            // A board that never answers is a refusal like any other, not a lane that hangs.
            signal: AbortSignal.timeout(10000),
            headers: {
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...(auth ? { authorization: auth } : {}),
            },
            body: body || undefined,
        });
        return `${r.status}\t${(await r.text()).replace(/\s+/g, ' ')}`;
    } catch (e) {
        return `000\t${e.message}`;
    }
};

const field = ([json, key]) => {
    try {
        const o = JSON.parse(json || '{}');
        return String(o[key] ?? '');
    } catch {
        return '';
    }
};

const ops = { api, field };

// The caller opens its fifo read-write before asking, so a write-only open normally succeeds at once;
// ENXIO (nobody reading yet) is retried until the caller's own read deadline has passed.
const signal = async (resp) => {
    for (let i = 0; i < 300; i += 1) {
        try {
            const fd = openSync(resp, constants.O_WRONLY | constants.O_NONBLOCK);
            writeSync(fd, 'done\n');
            closeSync(fd);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
};

const serve = async (file) => {
    let out = '';
    try {
        const [op, ...args] = readFileSync(file, 'utf8').split('\0');
        out = String(await (ops[op] ?? (() => `000\tunknown op ${op}`))(args));
    } catch (e) {
        out = `000\t${e.message}`;
    }
    writeFileSync(`${file}.out`, out);
    await signal(`${file}.resp`);
};

for await (const line of createInterface({ input: createReadStream(fifo) })) {
    if (line) void serve(line);
}
