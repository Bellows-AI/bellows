#!/usr/bin/env node
// Which test:jobs phases a change set needs — the ONE path-to-phase map behind
// `scripts/test-jobs.sh --changed <base>`. Pinned by server/test/test-jobs.changed.test.ts: every
// phase is reachable, and every tracked file under driver/src, docker/, scripts/, server/src,
// server/migrations and core/src matches a rule here (an unmatched path is a test failure, not a silent full lane).
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
    'acceptance',
    'compose-driver',
    'auth',
    'cooperative-stop',
    'tool-isolation',
    'image-checks',
    'repo-skills',
    'ask-user-question',
    'question-round-trip',
    'finish-gate',
    'pinned-skills',
    'mcp',
];

export const FULL = 'full';
// No lane executes the path: a unit test, the kubernetes lane, a doc.
export const NONE = 'none';

// The phases that boot a real agent CLI image (make runners) against the scripted model endpoint.
const REAL = ['cooperative-stop', 'tool-isolation', 'ask-user-question', 'question-round-trip', 'finish-gate', 'repo-skills', 'pinned-skills'];
const RECOVERY = ['node-disruption', 'driver-kill'];

// [pattern, phases | FULL | NONE, reason]. First match wins, so a specific file precedes its directory.
export const RULES = [
    // --- the shared fixture: every board phase builds on it -------------------------------------
    [/^scripts\/(test-jobs\.sh|test-jobs-changed\.mjs|stub-agent\.sh|stub-runner\.Dockerfile|lane-gh\.sh|lane-lib\.sh|lane-api\.mjs|lane-slow-jobs\.mjs)$/, FULL, 'lane harness and stub image'],
    [/^scripts\/fake-forge\/[^/]+\.mjs$/, FULL, 'the fake forge the lane serves'],
    // One file per phase (scripts/lanes/jobs): a phase file runs that phase; the fixture the services phases share runs them all.
    [/^scripts\/lanes\/jobs\/service-fixture\.sh$/, ['services', 'orphan-reaper', 'node-disruption'], 'the service fixture three phases build on'],
    ...PHASES.map((phase) => [new RegExp(`^scripts/lanes/jobs/${phase}\\.sh$`), [phase], 'its own phase file']),
    [/^scripts\/lanes\/k8s\/[a-z-]+\.sh$/, NONE, 'kubernetes lane phases, covered by test:k8s'],
    [/^scripts\/secrets-init\.mjs$/, NONE, 'writes secrets.env for a development checkout; pinned by server/test/secrets.environment.test.ts'],
    [/^scripts\/gate-pg-fast\.sh$/, NONE, "this repository's test:db gate postgres tuning; pinned by server/test/bellows.test.ts"],
    [/^scripts\/gate-diag(-pod)?\.sh$/, NONE, 'the gate diagnostic pass; pinned by server/test/gate-diag.test.ts'],
    [/^scripts\/gate-test-changed\.sh$/, NONE, "this repository's test and test:db gate wrapper; pinned by server/test/gate-test-changed.test.ts"],
    [/^scripts\/gate-ui\.sh$/, NONE, "this repository's ui gate wrapper; pinned by server/test/gate-ui.test.ts"],
    [/^scripts\/gate-base\.sh$/, NONE, "this repository's gate base resolution; pinned by server/test/gate-test-changed.test.ts"],
    [/^scripts\/test-jobs-groups\.mjs$/, NONE, '--parallel scheduling only; pinned by server/test/test-jobs.groups.test.ts'],
    [/^driver\/src\/scripts\/(supervisor\.cjs|task-init\.sh|task-checkout\.cjs|git-probe\.cjs|git-harden\.cjs)$/, FULL, 'runs inside every task'],
    [/^docker\/executor-common\/(ctl-agent\.cjs|factory-launch\.sh|factory-tool\.cjs|tool-bash\.sh)$/, FULL, 'copied into the stub runner image'],
    [/^docker\/init-databases\.sh$/, FULL, 'postgres bootstrap'],
    [/^driver\/src\/(claim|config|index|strip-secret-store-env|runner|runner-plan|executors|docker\/docker|docker\/docker-runner|docker\/docker-runner-support|docker\/docker-create-runner|loop\/loop|loop\/loop-run|loop\/loop-types|loop\/loop-helpers|helpers|http|container-scripts|exec-codes|labels|json-parse|timestamps|runner-classes|quantities)\.ts$/, FULL, 'driver core every phase runs through'],
    [/^server\/src\/(mcp\/|auth\/oauth|routes\/oauth)/, ['mcp'], 'MCP server and its OAuth authorization server'],
    [/^scripts\/mcp-phase-client\.mjs$/, ['mcp'], 'the mcp phase client'],
    // The auth plugin, its worker, session and route-class checks and the auth store judge every request, the claim's included.
    [/^server\/src\/auth\/(plugin|request-limits|route-class|session|store|worker-auth|driver-credentials|access-token|bridge-binding|membership-guard|membership-store|membership|admin-promotion|member-removal|org-key|setup-store)\.ts$/, FULL, 'authentication every request passes'],
    [/^server\/src\/auth\/github\.ts$/, ['auth', 'capacity', 'mcp', 'pinned-skills'], 'GitHub sign-in, built only by the AUTH_MODE=github boards'],
    [/^server\/src\/auth\/driver-credential-(cli|command)\.ts$/, NONE, 'the driver credential command line, not called by any jobs phase'],
    // Asked before every sync, publish and gate (driver/src/board/board.ts), and installed in every task.
    [/^driver\/src\/(github-credential-call\.ts|loop\/loop-github\.ts|scripts\/credential-helper\.sh)$/, FULL, 'the GitHub token ask every task makes'],

    // --- the board (server/src, core/src, server/migrations) ----------------------------------------
    // Derived from what the lane calls: the routes in scripts/test-jobs.sh, scripts/lanes/jobs/*.sh and the helpers they
    // run, the driver's board client, the runner images' board calls, and the MCP tools scripts/mcp-phase-client.mjs
    // calls; then route -> handler -> store, and the loops server/src/main.ts starts on every board. Adding a lane call
    // to an area marked NONE or to one phase moves its rule here in the same change. Unproven stays full.
    [/^server\/migrations\//, FULL, 'the schema every board migrates at boot'],
    [/^core\/src\//, FULL, 'shared with the board through the core index re-export; a path cannot show which board module uses it'],
    [/^server\/src\/(main|app|index|offline|orgs|shutdown|cache|interval-loop|abortable-sleep|identifiers|metrics|log|otel|otel-register|otel-scrub|otel-idle|board-span|pg-trace|timing|version|tar|config(-[a-z-]+)?)\.ts$/, FULL, 'board boot, configuration and wiring'],
    [/^server\/src\/(routes\/jobs|db\/jobs|db\/workflows)\//, FULL, 'the job, claim and workflow path every phase runs'],
    [/^server\/src\/(workspace|github|artifacts|telemetry|notifications)\//, FULL, 'plan reads, GitHub reads, artifacts, runner telemetry and the notification outbox every board runs'],
    [/^server\/src\/secrets\/rotate-(cli|args)\.ts$/, NONE, 'the rotation command line, not called by any jobs phase'],
    [/^server\/src\/secrets\//, FULL, 'the secret store every board opens'],
    [/^server\/src\/(pr-follower|batch-loops|batch-pr-observer|stats-service|skills|skill-catalog)\.ts$/, FULL, 'the PR follower and stats warm-up every board runs, and the skill catalog every create reads'],
    [/^server\/src\/db\/(pool|migrate|org-sql|org-tables|org-status|audit-log|lease-types|attempt-of-lease|restore-types|object-write-fence|operation-receipts|env-var-store|env-secrets|user-executor-store|executor-credentials|stored-repos|tracked-repos|master-prompt|review-prompt|evidence-policy|follow-up-recap|gate-report|task-summary|plan-limits|plan-allowances|outbox-backoff|pr-follow-store|pr-lifecycle-store|org-retention|org-purge|skill-store|connection-bindings|agent-default-sql|env-var-write)\.ts$/, FULL, 'stores the job path, the claim or a boot loop uses'],
    [/^server\/src\/db\/batches\/batch-store-(observation|types)\.ts$/, FULL, 'the PR follower every board runs reads its lease'],
    // What server/src/main.ts starts on every board (pinned by the test from its start* imports): a loop's first pass runs
    // at boot. Integration recovery reads every integration module and the grants; commerce delivery is called and returns
    // at its COMMERCE_ENABLED check.
    [/^server\/src\/(integrations\/|db\/connection-grants\.ts$|skills\/skill-collector\.ts$|commerce\/commerce-loop\.ts$)/, FULL, 'a loop every board starts at boot, and what it reads'],
    [/^server\/src\/(provider-keys\/|net\/pinned-request\.ts$)/, FULL, 'the provider key check server/src/main.ts builds on every board'],
    [/^server\/src\/oauth\/(rate-limit|special-use-address)\.ts$/, FULL, 'the rate limiter every request passes'],
    [/^server\/src\/attachments\/(attachment-collector|attachment-store|attachment-rows)\.ts$/, FULL, 'the attachment sweep every board runs over the shared object store'],
    [/^server\/src\/routes\/(auth|auth-onboarding|auth-shared|health|error-handler|executor-fields|helpers|route-guards|plan-limit|env|workspace|org-executors|github-credential|operation-receipts|ingest|stats|connections|agent-default|onboarding-setup)\.ts$/, FULL, 'routes the lane fixture, the driver or a runner calls in every phase'],
    // Registration runs at boot: a route file whose plugin body calls something besides declaring routes (pinned by the test).
    [/^server\/src\/routes\/(skills|skills-store|version|webhook|attachments|notification-subscriptions|operator|org-export|repos|connection-credential|batches\/batches|model-setup-verify)\.ts$/, FULL, 'registration does work at every boot'],
    // Called by named phases only.
    [/^server\/src\/db\/connection-store\.ts$/, ['github-credential', 'question-round-trip', 'pinned-skills'], 'connections: two phases seed one and bind it to a task'],
    [/^server\/src\/(routes|db)\/agent-title\.ts$/, ['tool-isolation', 'question-round-trip'], 'the task title helper'],
    [/^server\/src\/routes\/workflows\.ts$/, ['workflows'], 'workflow definitions'],
    [/^server\/src\/skills\//, ['pinned-skills'], 'stored-skill bundles, read only when a skill is published'],
    [/^server\/src\/(oauth\/|attachments\/upload-capability-store\.ts$)/, ['mcp'], 'the MCP OAuth server and the sweep only an MCP board starts'],
    [/^server\/src\/offline-mint\.ts$/, ['github-credential'], 'the board with a stand-in mint'],
    // Not called by any jobs phase.
    [/^server\/src\/(commerce\/|db\/commerce-|routes\/commerce\.ts$)/, NONE, 'commerce, off unless COMMERCE_ENABLED, which no lane sets; not called by any jobs phase'],
    [/^server\/src\/(db\/batches\/|routes\/batches\/|batch-merger\.ts$|batch-reconciler\.ts$)/, NONE, 'batches: their loops need BATCHES_ENABLED, which no lane sets, and no phase makes one; not called by any jobs phase'],
    [/^server\/src\/(routes\/(org-members|org-retention|audit|tokens|tasks|operator-driver-credentials|integrations|integration-catalog|attachment-uploads|attachment-ingest|model-setup|model-setup-save)\.ts|db\/org-export\.ts|attachments\/(name|sniff)\.ts)$/, NONE, 'settings, admin and dashboard routes; not called by any jobs phase'],
    [/^server\/src\/seed\//, NONE, 'synthetic data command line, not called by any jobs phase'],

    // --- docker executor, specific concerns ------------------------------------------------------
    [/^driver\/src\/(drain|loop\/loop-adopt|loop\/loop-reclaim|loop\/loop-fence|loop\/loop-lease|loop\/loop-race|adopt-skeleton|task-restore|reclaim-calls|kill-ledger|loop\/loop-ledger|operation-ledger)\.ts$/, RECOVERY, 'adoption and takeover'],
    [/^driver\/src\/scripts\/(checkpoint\.cjs|checkpoint-restore\.cjs|binding-write\.sh|operation-ledger\.cjs)$/, [...RECOVERY, 'driver'], 'checkpoints and the ledger'],
    [/^driver\/src\/(supervisor-contract|supervisor-plan|supervised-steps|step-control|control-channel|docker\/docker-mailbox|docker\/docker-group|docker\/docker-group-probe|group-watch|termination|startup-cause)\.ts$/, ['driver', ...RECOVERY], 'task supervisor protocol'],
    [/^driver\/src\/(run-deadline|docker\/docker-run-timers|timeout-note)\.ts$/, ['run-deadline'], 'run deadline'],
    [/^driver\/src\/(services|loop\/loop-services|service-restart)\.ts$/, ['services', 'node-disruption'], 'service containers'],
    [/^driver\/src\/scripts\/service-generation-(bump|probe)\.sh$/, ['services'], 'service generation'],
    [/^driver\/src\/(reaper|reaper-export|docker\/docker-reaper|docker\/docker-volume-export)\.ts$/, ['orphan-reaper', 'driver-kill', 'capacity'], 'container reaper'],
    [/^driver\/src\/(review\/review|review\/review-[a-z-]+|loop\/loop-review)\.ts$/, ['review'], 'reviewer'],
    [/^driver\/src\/scripts\/(review-[a-z-]+\.(cjs|sh)|git-review-snapshot\.cjs)$/, ['review'], 'reviewer'],
    [/^driver\/src\/(connection-control|loop\/loop-connection)\.ts$/, ['driver', 'cooperative-stop'], 'runtime connection requirement'],
    [/^driver\/src\/(question-control|question-validation|loop\/loop-questions)\.ts$/, ['ask-user-question', 'question-round-trip'], 'questions'],
    [/^driver\/src\/(skill-inputs\.ts|scripts\/skill-install\.cjs|board\/board-skills\.ts)$/, ['driver', 'pinned-skills'], 'pinned skill delivery'],
    [/^driver\/src\/(input-control\.ts|task-inputs\.ts|loop\/loop-inputs\.ts|scripts\/attachment-(?:fetch|extract)\.cjs)$/, ['driver', 'pinned-skills'], 'task input and pinned skill delivery'],
    [/^scripts\/lane-skills\.mjs$/, ['pinned-skills'], 'the pinned-skills phase publisher'],
    [/^driver\/src\/(publish\/publish|publish\/publish-[a-z]+|loop\/loop-publish(-retry)?|loop\/loop-pr-operation)\.ts$/, ['driver', 'driver-kill', 'compose-driver'], 'publish'],
    [/^driver\/src\/scripts\/(pr-summary|merge-conflict-probe)\.cjs$/, ['driver'], 'publish helpers'],
    [/^driver\/src\/(loop\/loop-gates|loop\/loop-gate-pass|loop\/loop-finish|loop\/loop-run-control|gate-manager|loop\/loop-no-change|gates|gate-cause|gate-token-control|docker\/docker-gate|loop\/loop-agentless|loop\/loop-phase|loop\/loop-phase-checkpoints|loop\/gate-reuse|gate-record|gate-identity|gate-admission|gate-request|board\/board-phase-checkpoints|board\/board-gate-runs|dockerd-loss)\.ts$/, ['driver', 'workflows', 'finish-gate'], 'gates and phases'],
    [/^driver\/src\/scripts\/gate-(loop|shell|github)\.sh$/, ['driver', 'workflows'], 'gates'],
    [/^driver\/src\/(docker\/docker-task-volume|task-volume)\.ts$/, ['driver', 'capacity', 'pinned-skills', ...RECOVERY], 'task volume'],
    [/^driver\/src\/(docker\/docker-close-read|close-read|docker\/docker-teardown|loop\/loop-conclusion|loop\/loop-post-run)\.ts$/, ['driver', ...RECOVERY], 'task conclusion'],
    [/^driver\/src\/(master-prompt|continuation|transcript-export|loop\/loop-export|export-control|evidence-policy|helper-receipts|verdict-budget|loop\/loop-verdict|loop\/loop-attempt|loop\/loop-handover|telemetry-config)\.ts$/, ['driver', 'cooperative-stop'], 'agent run and its readout'],
    [/^driver\/src\/scripts\/(claude-export|claude-turns|opencode-cache-probe|opencode-readout)\.cjs$/, ['cooperative-stop', 'tool-isolation'], 'agent transcript readout'],
    [/^driver\/src\/scripts\/helper-noop\.cjs$/, ['driver'], 'helper receipts'],
    [/^driver\/src\/(board\/board|board\/board-[a-z-]+|board-credential|poll|artifact-calls|artifact-upload|driver-metrics|otel|otel-register|log|timing|child-env|otel-scrub|otel-idle|lifecycle-span|shutdown)\.ts$/, ['board', 'driver'], 'board client'],
    // The kubernetes executor: scripts/test-k8s.sh covers it, the docker lane never loads it.
    [/^driver\/src\/k8s\/k8s-[a-z-]+\.ts$/, NONE, 'kubernetes executor, covered by test:k8s'],
    // A docker class's daemon sidecar: kubernetes only, the docker executor refuses a docker class at boot.
    [/^driver\/src\/scripts\/dockerd-start\.sh$/, NONE, 'the dockerd sidecar start script, kubernetes only'],

    // --- runner images ------------------------------------------------------------------------------
    [/^docker\/executor-common\/(github-credential|credential-broker)\.cjs$/, ['github-credential', 'cooperative-stop', 'tool-isolation', 'image-checks'], 'GitHub credential, built into both images'],
    [/^docker\/(claude-executor|opencode-executor)\/(stop-hook\.cjs|stop-plugin\/.*)$/, ['cooperative-stop'], 'cooperative stop'],
    [/^docker\/(claude|opencode)-executor\/test\.sh$/, ['image-checks'], 'executor image checks'],
    [/^docker\/claude-executor\/(Dockerfile|entrypoint\.sh|claude-bridge\.cjs|claude-progress\.cjs|turn-context-hook\.cjs|finish-hook\.cjs|managed-settings\.json|claude-home\/.*)$/, [...REAL, 'image-checks'], 'claude-executor image'],
    [/^docker\/opencode-executor\/(Dockerfile|entrypoint\.sh|rate-limit-watch\.cjs|otel-credential\.cjs|otel\.json|opencode-home\/.*)$/, ['cooperative-stop', 'tool-isolation', 'image-checks', 'repo-skills', 'pinned-skills', 'finish-gate'], 'opencode-executor image'],
    [/^docker\/executor-common\//, [...REAL, 'image-checks'], 'files both executor images copy in'],
    [/^docker\/tool-isolation-checks\.sh$/, ['tool-isolation'], 'tool isolation'],
    [/^docker\/skills\/factory-task-title\//, ['tool-isolation', 'question-round-trip'], 'task title helper and skill'],
    [/^docker\/skills\/factory-(jira|linear)\//, ['tool-isolation', 'question-round-trip'], 'tracker helpers the connection round trip runs'],
    [/^docker\/skills\//, ['tool-isolation'], 'skill helper scripts'],
    [/^docker\/(Dockerfile|driver\.Dockerfile)$/, ['compose-driver'], 'the deployed and compose images'],
    [/^docker\/skills\/factory-review\//, ['review'], 'reviewer prompt'],
    [/^docker\/skills\//, NONE, 'agent prompt text, pinned by unit tests; no lane runs it'],
    [/^docker\/(claude-executor|opencode-executor)\/(README\.md|test\.sh)$/, NONE, 'image documentation and self-test'],
    [/^docker\/otel-collector\.yaml$/, NONE, 'collector config, not loaded by the lane'],
    [/^docker\/dev-runner\/Dockerfile$/, NONE, 'the .bellows.yaml gate image, not loaded by the lane'],

    // --- scripts --------------------------------------------------------------------------------
    [/^scripts\/fake-model-endpoint\.mjs$/, REAL, 'scripted model endpoint'],
    [/^scripts\/tool-seam-lane\.mjs$/, ['tool-isolation'], 'tool isolation seam verdicts'],
    [/^scripts\/lane-capacity-samples\.mjs$/, ['capacity'], 'capacity verdict'],
    [/^scripts\/acceptance-[a-z-]+\.(mjs|sh)$/, ['acceptance'], 'failure-matrix acceptance helpers'],
    [/^scripts\/k8s-stub\.sh$/, ['acceptance'], 'the stub agent the docker acceptance phase builds and runs'],
    [/^scripts\/(test-k8s\.sh|kind-cluster[a-z-]*\.(sh|yaml)|k8s-[a-z-]+\.(mjs|sh)|bench-summary\.mjs|mcp-kind-client\.mjs|release\.sh|lint-changed\.sh|test-changed\.mjs|gate-jq\.sh|pin-digests\.sh)$/, NONE, 'not part of the docker lane'],

    [/^(docker-compose\.yml|package\.json|package-lock\.json|tsconfig(\.base)?\.json|VERSION|Makefile|\.dockerignore)$/, FULL, 'what the lane builds and boots'],

    // --- outside the lane's inputs ----------------------------------------------------------------
    [/^e2e\/stub-idp\.mjs$/, ['mcp'], 'the mcp phase signs its member in through it'],
    [/^(web|e2e|docs|site|charts|lint|cli|plugins|\.github|\.claude|\.claude-plugin|\.opencode|\.factory)\//, NONE, 'not executed by the docker lane'],
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
    return [...new Set([...git('diff', '--no-renames', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])];
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
