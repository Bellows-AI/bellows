#!/usr/bin/env node
// Which test:jobs phases a change set needs — the ONE path-to-phase map behind
// `scripts/test-jobs.sh --changed <base>`. Pinned by server/test/test-jobs.changed.test.ts: every
// phase is reachable, and every tracked file under driver/src, docker/ and scripts/ matches a rule
// here (an unmatched path is a test failure, not a silent full lane).
//
//   node scripts/test-jobs-changed.mjs <base>         paths from `git diff --name-only $(git merge-base <base> HEAD)`
//                                                     plus untracked files
//   node scripts/test-jobs-changed.mjs --files        paths on stdin, one per line
//   add --json for the whole verdict on stdout
//
// stdout: a comma list of phases, `full`, or nothing. stderr: one line per decision.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// In the order scripts/test-jobs.sh runs them.
export const PHASES = [
    'board',
    'driver',
    'github-credential',
    'services',
    'orphan-reaper',
    'node-disruption',
    'driver-kill',
    'run-deadline',
    'capacity',
    'review',
    'workflows',
    'compose-driver',
    'auth',
    'cooperative-stop',
    'tool-isolation',
    'ask-user-question',
    'question-round-trip',
];

export const FULL = 'full';
// No lane executes the path: a unit test, the kubernetes lane, a doc.
export const NONE = 'none';

// The phases that boot a real agent CLI image (make runners) against the scripted model endpoint.
const REAL = ['cooperative-stop', 'tool-isolation', 'ask-user-question', 'question-round-trip'];
const RECOVERY = ['node-disruption', 'driver-kill'];

// [pattern, phases | FULL | NONE, reason]. First match wins, so a specific file precedes its directory.
export const RULES = [
    // --- the shared fixture: every board phase builds on it -------------------------------------
    [/^scripts\/(test-jobs\.sh|test-jobs-changed\.mjs|stub-agent\.sh|stub-runner\.Dockerfile|lane-gh\.sh|lane-slow-jobs\.mjs)$/, FULL, 'lane harness and stub image'],
    [/^driver\/src\/scripts\/(supervisor\.cjs|task-init\.sh|task-checkout\.cjs|git-probe\.cjs)$/, FULL, 'runs inside every task'],
    [/^docker\/claude-executor\/(ctl-agent\.cjs|factory-launch\.sh|factory-tool\.cjs|tool-bash\.sh)$/, FULL, 'copied into the stub runner image'],
    [/^docker\/init-databases\.sh$/, FULL, 'postgres bootstrap'],
    [/^driver\/src\/(claim|config|index|runner|runner-plan|executors|docker|docker-runner|docker-runner-support|docker-create-runner|loop|loop-run|loop-types|loop-helpers|helpers|http|container-scripts|exec-codes|labels|json-parse|timestamps)\.ts$/, FULL, 'driver core every phase runs through'],
    [/^server\/src\/auth\//, ['auth', 'board'], 'authentication'],
    [/^(server|core)\/(src|migrations)\//, FULL, 'the board every phase boots'],

    // --- docker executor, specific concerns ------------------------------------------------------
    [/^driver\/src\/(loop-adopt|loop-reclaim|loop-fence|adopt-skeleton|task-restore|reclaim-calls|kill-ledger|loop-ledger|operation-ledger)\.ts$/, RECOVERY, 'adoption and takeover'],
    [/^driver\/src\/scripts\/(checkpoint\.cjs|checkpoint-restore\.cjs|binding-write\.sh|operation-ledger\.cjs)$/, [...RECOVERY, 'driver'], 'checkpoints and the ledger'],
    [/^driver\/src\/(supervisor-contract|supervisor-plan|supervised-steps|step-control|control-channel|docker-mailbox|docker-group|docker-group-probe|termination|startup-cause)\.ts$/, ['driver', ...RECOVERY], 'task supervisor protocol'],
    [/^driver\/src\/(run-deadline|docker-run-timers|timeout-note)\.ts$/, ['run-deadline'], 'run deadline'],
    [/^driver\/src\/(services|loop-services|service-restart)\.ts$/, ['services', 'node-disruption'], 'service containers'],
    [/^driver\/src\/scripts\/service-generation-(bump|probe)\.sh$/, ['services'], 'service generation'],
    [/^driver\/src\/(reaper|docker-reaper)\.ts$/, ['orphan-reaper', 'driver-kill', 'capacity'], 'container reaper'],
    [/^driver\/src\/(github-credential-call|loop-github)\.ts$/, ['github-credential'], 'GitHub credential'],
    [/^driver\/src\/scripts\/credential-helper\.sh$/, ['github-credential'], 'GitHub credential'],
    [/^driver\/src\/(review|review-[a-z-]+|loop-review)\.ts$/, ['review'], 'reviewer'],
    [/^driver\/src\/scripts\/(review-[a-z-]+\.(cjs|sh)|git-review-snapshot\.cjs)$/, ['review'], 'reviewer'],
    [/^driver\/src\/(question-control|question-validation|loop-questions)\.ts$/, ['ask-user-question', 'question-round-trip'], 'questions'],
    [/^driver\/src\/(publish|publish-[a-z]+|loop-publish)\.ts$/, ['driver', 'compose-driver'], 'publish'],
    [/^driver\/src\/scripts\/(pr-summary|merge-conflict-probe)\.cjs$/, ['driver'], 'publish helpers'],
    [/^driver\/src\/(loop-gates|gates|gate-cause|docker-gate|loop-agentless|loop-phase|loop-phase-checkpoints|board-phase-checkpoints)\.ts$/, ['driver', 'workflows'], 'gates and phases'],
    [/^driver\/src\/scripts\/gate-(loop|shell)\.sh$/, ['driver', 'workflows'], 'gates'],
    [/^driver\/src\/(docker-task-volume|task-volume)\.ts$/, ['driver', 'capacity', ...RECOVERY], 'task volume'],
    [/^driver\/src\/(docker-close-read|close-read|docker-teardown|loop-conclusion|loop-post-run)\.ts$/, ['driver', ...RECOVERY], 'task conclusion'],
    [/^driver\/src\/(master-prompt|continuation|transcript-export|loop-export|export-control|evidence-policy|helper-receipts|verdict-budget|loop-verdict|loop-attempt|telemetry-config)\.ts$/, ['driver', 'cooperative-stop'], 'agent run and its readout'],
    [/^driver\/src\/scripts\/(claude-export|claude-turns|opencode-cache-probe|opencode-readout)\.cjs$/, ['cooperative-stop', 'tool-isolation'], 'agent transcript readout'],
    [/^driver\/src\/scripts\/helper-noop\.cjs$/, ['driver'], 'helper receipts'],
    [/^driver\/src\/(board|board-[a-z]+|poll|artifact-calls|artifact-upload|driver-metrics|metrics-server|prometheus)\.ts$/, ['board', 'driver'], 'board client'],
    // The kubernetes executor: scripts/test-k8s.sh covers it, the docker lane never loads it.
    [/^driver\/src\/k8s-[a-z-]+\.ts$/, NONE, 'kubernetes executor, covered by test:k8s'],

    // --- runner images ------------------------------------------------------------------------------
    [/^docker\/claude-executor\/github-credential\.cjs$/, ['github-credential'], 'GitHub credential'],
    [/^docker\/(claude-executor|opencode-executor)\/(stop-hook\.cjs|stop-plugin\/.*)$/, ['cooperative-stop'], 'cooperative stop'],
    [/^docker\/claude-executor\/(Dockerfile|entrypoint\.sh|claude-bridge\.cjs|claude-progress\.cjs|turn-context-hook\.cjs|branch-reporter\.cjs|git-guard\.cjs|control-proxy\.cjs|gh-wrapper\.sh|managed-settings\.json|claude-home\/.*)$/, REAL, 'claude-executor image'],
    [/^docker\/opencode-executor\/(Dockerfile|entrypoint\.sh|branch-reporter\.cjs|control-proxy\.cjs|ctl-agent\.cjs|factory-launch\.sh|factory-tool\.cjs|gh-wrapper\.sh|github-credential\.cjs|rate-limit-watch\.cjs|tool-bash\.sh|otel\.json|opencode-home\/.*)$/, ['cooperative-stop', 'tool-isolation'], 'opencode-executor image'],
    [/^docker\/tool-isolation-checks\.sh$/, ['tool-isolation'], 'tool isolation'],
    [/^docker\/(Dockerfile|driver\.Dockerfile)$/, ['compose-driver'], 'the deployed and compose images'],
    [/^docker\/skills\/review\//, ['review'], 'reviewer prompt'],
    [/^docker\/skills\//, NONE, 'agent prompt text, pinned by unit tests; no lane runs it'],
    [/^docker\/(claude-executor|opencode-executor)\/(README\.md|test\.sh)$/, NONE, 'image documentation and self-test'],
    [/^docker\/otel-collector\.yaml$/, NONE, 'collector config, not loaded by the lane'],

    // --- scripts --------------------------------------------------------------------------------
    [/^scripts\/fake-model-endpoint\.mjs$/, REAL, 'scripted model endpoint'],
    [/^scripts\/lane-capacity-samples\.mjs$/, ['capacity'], 'capacity verdict'],
    [/^scripts\/(test-k8s\.sh|kind-cluster[a-z-]*\.(sh|yaml)|k8s-[a-z-]+\.(mjs|sh)|release\.sh|lint-changed\.sh|gate-jq\.sh)$/, NONE, 'not part of the docker lane'],

    [/^(docker-compose\.yml|package\.json|package-lock\.json|tsconfig(\.base)?\.json|VERSION|Makefile|\.dockerignore)$/, FULL, 'what the lane builds and boots'],

    // --- outside the lane's inputs ----------------------------------------------------------------
    [/^(web|e2e|docs|openspec|charts|lint|cli|plugins|\.github|\.claude|\.claude-plugin|\.opencode|\.factory)\//, NONE, 'not executed by the docker lane'],
    [/(^|\/)(test|test-db)\//, NONE, 'unit and integration tests'],
    [/^[^/]+\.(md|json|yaml|yml|ts|config\.ts)$|^(LICENSE|VERSION|Makefile|\.[a-z]+)$/, NONE, 'repo-level config and documents'],
];

export function classify(files) {
    const decisions = [];
    const phases = new Set();
    let full = false;
    for (const file of files) {
        const rule = RULES.find(([pattern]) => pattern.test(file));
        if (!rule) {
            full = true;
            decisions.push({ file, result: FULL, reason: 'unmapped path', unmapped: true });
            continue;
        }
        const [, result, reason] = rule;
        decisions.push({ file, result, reason, unmapped: false });
        if (result === FULL) full = true;
        else if (result !== NONE) for (const phase of result) phases.add(phase);
    }
    const selected = full ? FULL : PHASES.filter((phase) => phases.has(phase));
    return { selected, decisions };
}

function changedFiles(base) {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
    // From the merge base, so a branch behind <base> is not charged with <base>'s newer commits.
    const [mergeBase] = git('merge-base', base, 'HEAD');
    return [...new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])];
}

function main(argv) {
    const json = argv.includes('--json');
    const args = argv.filter((arg) => arg !== '--json');
    let files;
    if (args[0] === '--files') files = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    else if (args.length === 1) files = changedFiles(args[0]);
    else {
        console.error('usage: test-jobs-changed.mjs <base> | --files [--json]');
        return 2;
    }
    const { selected, decisions } = classify(files);
    if (json) {
        process.stdout.write(`${JSON.stringify({ selected, decisions })}\n`);
        return 0;
    }
    for (const { file, result, reason } of decisions) {
        const target = Array.isArray(result) ? result.join(',') : result;
        console.error(`[changed] ${file} -> ${target} (${reason})`);
    }
    if (files.length === 0) console.error('[changed] no changed files');
    else if (selected === FULL) console.error('[changed] full lane');
    else if (selected.length === 0) console.error('[changed] no changed file is executed by this lane');
    else console.error(`[changed] phases: ${selected.join(',')}`);
    process.stdout.write(selected === FULL ? 'full' : selected.join(','));
    return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    process.exitCode = main(process.argv.slice(2));
}
