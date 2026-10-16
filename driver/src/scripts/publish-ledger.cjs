// The publication ledger: the persisted operation identity of a publish (issue #771). One JSON file
// in the task worktree's `.factory/` namespace — on the task volume, so it outlives the pod and the
// driver that wrote it — maps an operation (`<branch>@<commit sha>`) to how far it got:
// `pushing` (the push is about to run), `pushed` (the remote has the commit), `opened` (the PR
// exists, with its URL). A retried or adopted attempt reads it before it pushes or opens anything,
// so a publication whose response was lost is reconciled instead of repeated.
//
// Environment (literals only, never a credential):
//   LEDGER  — the ledger file's absolute path.
//   ACTION  — `read` answers the operation's record; `write` merges one into it.
//   OP      — the operation identity.
//   STATE   — write: `pushing` | `pushed` | `opened`.
//   PR_URL  — write: the PR's URL, once there is one.
// Prints one JSON line: the operation's record (`{}` when it has none).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const STATES = ['pushing', 'pushed', 'opened'];
const KEEP_OPERATIONS = 20;

const read = (file) => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && parsed.operations ? parsed : { operations: {} };
    } catch {
        return { operations: {} };
    }
};

function main(env) {
    const { LEDGER: file, ACTION: action, OP: op, STATE: state, PR_URL: prUrl } = env;
    if (!file || !op) throw new Error('the ledger needs LEDGER and OP');
    const ledger = read(file);
    if (action === 'read') return ledger.operations[op] ?? {};
    if (action !== 'write' || !STATES.includes(state)) throw new Error(`not a ledger write: ${action} ${state}`);
    const previous = ledger.operations[op] ?? {};
    // A state never moves backwards: a retried `pushing` after `pushed` keeps `pushed`.
    const keep = STATES.indexOf(previous.state) > STATES.indexOf(state);
    const record = {
        ...previous,
        ...(keep ? {} : { state }),
        ...(prUrl ? { prUrl } : {}),
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
