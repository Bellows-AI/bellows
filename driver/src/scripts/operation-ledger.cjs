// The operation ledger: the persisted identity of a remote effect and how far it got (issues #771,
// #826). One JSON file in the task worktree's `.factory/` namespace — on the task volume, so it
// outlives the pod and the driver that wrote it — maps an operation to its record. Each ledger
// names its own ordered states: a publication (`<branch>@<commit sha>`) moves `pushing` → `pushed`
// → `opened`, a block-helper effect `started` → `done`. A retried or adopted attempt reads it
// before it repeats anything, so an effect whose response was lost is reconciled, not repeated.
//
// Environment (literals only, never a credential):
//   LEDGER  — the ledger file's absolute path.
//   ACTION  — `read` answers the operation's record; `write` merges one into it.
//   OP      — the operation identity.
//   STATES  — write: the ledger's states, comma-separated, in order.
//   STATE   — write: one of STATES.
//   DATA    — write, optional: a JSON object merged into the record (a PR's URL, a helper's result).
// Prints one JSON line: the operation's record (`{}` when it has none).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEEP_OPERATIONS = 20;

const read = (file) => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && parsed.operations ? parsed : { operations: {} };
    } catch {
        return { operations: {} };
    }
};

const dataOf = (raw) => {
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('DATA must be a JSON object');
    return data;
};

function main(env) {
    const { LEDGER: file, ACTION: action, OP: op, STATE: state } = env;
    if (!file || !op) throw new Error('the ledger needs LEDGER and OP');
    const ledger = read(file);
    if (action === 'read') return ledger.operations[op] ?? {};
    const states = (env.STATES ?? '').split(',').filter(Boolean);
    if (action !== 'write' || !states.includes(state)) throw new Error(`not a ledger write: ${action} ${state}`);
    const previous = ledger.operations[op] ?? {};
    // A state never moves backwards: a retried `pushing` after `pushed` keeps `pushed`.
    const keep = states.indexOf(previous.state) > states.indexOf(state);
    const record = {
        ...previous,
        ...(keep ? {} : { state }),
        ...dataOf(env.DATA),
        at: new Date().toISOString(),
    };
    const operations = { ...ledger.operations, [op]: record };
    const kept = Object.entries(operations)
        .sort(([, a], [, b]) => String(a.at).localeCompare(String(b.at)))
        .slice(-KEEP_OPERATIONS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ operations: Object.fromEntries(kept) }));
    fs.renameSync(tmp, file);
    return record;
}

try {
    process.stdout.write(`${JSON.stringify(main(process.env))}\n`);
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}
