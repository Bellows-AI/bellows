#!/usr/bin/env node
'use strict';
// The claim's per-node turn context (issue #509): the baked UserPromptSubmit hook. The driver puts
// it in FACTORY_TURN_CONTEXT; answered as additional context it lands beside this run's prompt, so
// the system prompt stays the same across a thread's node transitions and `-p` stays the command —
// a `/skill` command must come first to expand. Says nothing when the claim carried none.
// A checkout rebuilt from the pushed branch also leaves its note in `.factory/rebuilt-from-remote` (the restore
// step, scripts/checkpoint-restore.cjs): the container's env is fixed before that step runs, the tree is not.
const fs = require('node:fs');
const path = require('node:path');

const readNote = () => {
    try {
        return fs.readFileSync(path.join(process.cwd(), '.factory', 'rebuilt-from-remote'), 'utf8').trim();
    } catch {
        return '';
    }
};

const context = [process.env.FACTORY_TURN_CONTEXT, readNote()].filter(Boolean).join('\n\n');

if (context) {
    process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`
    );
}
