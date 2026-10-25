// The uid seam of the tool-isolation lane (epic #1025): what the scripted steps do, and how their
// results are judged. The lane (scripts/test-jobs.sh) runs the steps through the real CLI against
// scripts/fake-model-endpoint.mjs `--steps`; this file is the part with no docker in it, so
// driver/test/tool-seam-lane.test.ts can pin the verdicts — and that every control can fail.
//
//   node scripts/tool-seam-lane.mjs steps <claude|opencode>     the --steps JSON
//   node scripts/tool-seam-lane.mjs skill-steps <claude|opencode>   the one Skill step, for the plain run
//   node scripts/tool-seam-lane.mjs node-repos <cli>   the shell that makes the CLI uid's repositories first
//   node scripts/tool-seam-lane.mjs node-git <cli>     the shell that runs the CLI uid's git afterwards
//   node scripts/tool-seam-lane.mjs verdict <claude|opencode> <file>
//       <file> is {results, skillBases, plainSkillBases, nodeGit}: the endpoint's /steps answer of the
//       full run, the skill base directories of a run without the runner's config dir, and the
//       `KEY=value` lines of git run as the CLI's uid afterwards. One `ok|bad<TAB>name<TAB>detail` line
//       per case.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The tool's TMPDIR (docker/claude-executor/factory-tool.cjs SHARED_TMP). */
const SHARED_TMP = '/tmp/factory-tmp';
const TOOL_HOME = '/home/factory-tool';
const CLI_CACHE = '/tmp/node-compile-cache';
/** Where the task checkout lives, and a second mount of the same volume that is nobody's checkout. */
const TRUSTED = '/workspace';
const UNTRUSTED = '/elsewhere';
const SKILL = 'jira';
/** Where each CLI finds the baked skills, and a private directory of its own the tool must not open. */
const SKILL_BASE = {
    claude: `/etc/claude-code/.claude/skills/${SKILL}`,
    opencode: `/home/node/.config/opencode/skills/${SKILL}`,
};
export const PRIVATE_DIR = { claude: '/workspace/.factory/t', opencode: '/workspace/.factory/opencode/probe' };

const TOOLS = {
    claude: { bash: 'Bash', read: 'Read', write: 'Write', skill: 'Skill' },
    opencode: { bash: 'bash', read: 'read', write: 'write', skill: 'skill' },
};

const SETUP = [
    'umask 077',
    `f=$(mktemp) && mv "$f" "$TMPDIR/seam-mktemp" && echo SEAM_FILE > "$TMPDIR/seam-mktemp"`,
    `mkdir -m 0700 "$TMPDIR/seam-dir" && echo SEAM_INNER > "$TMPDIR/seam-dir/inner"`,
    `echo SEAM_HOME > "$HOME/seam-private"`,
    'echo SEAM_OUTSIDE > /tmp/seam-outside',
    'echo "SETUP tmpdir=$TMPDIR"',
].join('\n');

const DELETE = (path) => `rm ${path} 2>/dev/null && echo DELETED=yes || echo DELETED=no`;

const CACHE = [
    'echo "CACHE_ENV=$NODE_COMPILE_CACHE"',
    `echo 'module.exports = 1;' > "$TMPDIR/cc.js"`,
    `node -e 'console.log("CACHE_DIR=" + (require("module").getCompileCacheDir() || "none")); require(process.env.TMPDIR + "/cc.js")'`,
    `node -e 'require(process.env.TMPDIR + "/cc.js")'`,
    'echo "CACHE_FILES=$(find "$NODE_COMPILE_CACHE" -type f 2>/dev/null | wc -l)"',
    `echo "CACHE_OWNER=$(stat -c %u "$NODE_COMPILE_CACHE" 2>/dev/null)"`,
    `NODE_COMPILE_CACHE=${CLI_CACHE} node -e 'console.log("CTRL_DIR=" + (require("module").getCompileCacheDir() || "none"))'`,
    `if [ -w ${CLI_CACHE} ]; then echo CLI_CACHE=writable; else echo CLI_CACHE=readonly; fi`,
].join('\n');

const GIT = [
    `git -C ${TRUSTED}/cli-repo log --oneline >/dev/null 2>&1 && echo TOOL_ON_CLI_REPO=ok || echo TOOL_ON_CLI_REPO=refused`,
    `git clone -q ${TRUSTED}/cli-repo ${TRUSTED}/clone >/dev/null 2>&1; echo CLONE=$?`,
    `git init -q ${TRUSTED}/tool-repo; echo INIT=$?`,
    `git -C ${UNTRUSTED}/cli-ctl log --oneline >/dev/null 2>&1 && echo TOOL_ON_CTL=ok || echo TOOL_ON_CTL=refused`,
    `git init -q ${UNTRUSTED}/tool-ctl; echo INIT_CTL=$?`,
].join('\n');

/** The shell the lane runs as the CLI's uid once the CLI is done: git on the repositories the tool made. */
export const NODE_GIT = [
    'chk() { if git -C "$2" status >/dev/null 2>&1; then echo "$1=ok"; else echo "$1=refused"; fi; }',
    `chk NODE_ON_TOOL_REPO ${TRUSTED}/tool-repo`,
    `chk NODE_ON_CLONE ${TRUSTED}/clone`,
    `chk NODE_ON_TOOL_CTL ${UNTRUSTED}/tool-ctl`,
].join('\n');

/** The shell the lane runs as the CLI's uid before the CLI starts: repositories the CLI's uid made. */
export const NODE_REPOS = [
    'umask 002',
    `for r in ${TRUSTED}/cli-repo ${UNTRUSTED}/cli-ctl; do`,
    '    git init -q $r && git -C $r -c user.name=lane -c user.email=lane@example.com commit -q --allow-empty -m init',
    'done',
].join('\n');

/** Each step: its case label (for the verdict) and the tool call. */
function plan(cli) {
    const t = TOOLS[cli];
    const read = (path) => ({ tool: t.read, input: cli === 'claude' ? { file_path: path } : { filePath: path } });
    const write = (path) => ({
        tool: t.write,
        input: cli === 'claude' ? { file_path: path, content: 'CLI' } : { filePath: path, content: 'CLI' },
    });
    const bash = (command) => ({ tool: t.bash, input: { command, description: 'seam' } });
    const privateDir = PRIVATE_DIR[cli];
    const skillRead = [
        `if head -c 8 ${SKILL_BASE[cli]}/SKILL.md >/dev/null 2>&1; then echo SKILL_READ=ok; else echo SKILL_READ=denied; fi`,
        `if ls ${privateDir} >/dev/null 2>&1; then echo PRIVATE=open; else echo PRIVATE=denied; fi`,
    ].join('\n');
    return [
        ['setup', bash(SETUP)],
        ['read-mktemp', read(`${SHARED_TMP}/seam-mktemp`)],
        ['read-dir', read(`${SHARED_TMP}/seam-dir/inner`)],
        ['read-home', read(`${TOOL_HOME}/seam-private`)],
        ['read-outside', read('/tmp/seam-outside')],
        ['write-shared', write(`${SHARED_TMP}/cli-made`)],
        ['delete-shared', bash(DELETE(`${SHARED_TMP}/cli-made`))],
        ['write-sticky', write('/tmp/cli-sticky')],
        ['delete-sticky', bash(DELETE('/tmp/cli-sticky'))],
        ['cache', bash(CACHE)],
        ['git', bash(GIT)],
        ['skill', { tool: t.skill, input: cli === 'claude' ? { skill: SKILL } : { name: SKILL } }],
        ['skill-read', bash(skillRead)],
    ];
}

export const seamSteps = (cli) => plan(cli).map(([, step]) => step);
/** The one-step run without the runner's config dir, whose skill base must be the same path. */
export const skillOnlySteps = (cli) => [plan(cli).find(([name]) => name === 'skill')[1]];

const DENIED = /EACCES|permission denied|not permitted/i;
const values = (text) => Object.fromEntries([...text.matchAll(/^([A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));

/** The verdicts, one {name, pass, detail} per case; a missing result fails its cases rather than passing them. */
export function verdict(cli, { results, skillBases = [], plainSkillBases = [], nodeGit = '' }) {
    const names = plan(cli).map(([name]) => name);
    const by = Object.fromEntries(names.map((name, i) => [name, results[i] ?? { isError: true, text: 'no result', missing: true }]));
    const out = [];
    const check = (name, pass, detail) => out.push({ name: `${cli}: ${name}`, pass: Boolean(pass), detail: pass ? '' : detail });
    const opened = (step, marker) => !by[step].isError && by[step].text.includes(marker);
    const refused = (step) => !by[step].missing && (by[step].isError || DENIED.test(by[step].text));

    // #1016 — the CLI's file tools read what the tool made private, in the shared TMPDIR and only there.
    check(
        'the CLI reads a 0600 mktemp file and a file in a 0700 directory the tool made in its TMPDIR',
        by.setup.text.includes(`tmpdir=${SHARED_TMP}`) && opened('read-mktemp', 'SEAM_FILE') && opened('read-dir', 'SEAM_INNER'),
        `setup ${by.setup.text.trim()}; mktemp file ${by['read-mktemp'].text.slice(0, 120)}; dir ${by['read-dir'].text.slice(0, 120)}`
    );
    check(
        'the control: a private file in the tool’s HOME or outside its TMPDIR stays unreadable to the CLI',
        refused('read-home') && refused('read-outside'),
        `home: ${by['read-home'].text.slice(0, 100)}; outside: ${by['read-outside'].text.slice(0, 100)}`
    );
    check(
        'the tool removes a file the CLI made in its TMPDIR',
        values(by['delete-shared'].text).DELETED === 'yes',
        by['delete-shared'].text
    );
    check(
        'the stated limit: a file the CLI makes straight in the sticky /tmp stays the tool’s to read, not to remove',
        values(by['delete-sticky'].text).DELETED === 'no',
        by['delete-sticky'].text
    );

    // #1021 — the tool's node processes use a compile cache of their own, never the CLI's.
    const cache = values(by.cache.text);
    check(
        'a node process of the tool uses a compile cache and fills it',
        cache.CACHE_DIR && cache.CACHE_DIR !== 'none' && cache.CACHE_DIR.startsWith(`${cache.CACHE_ENV}/`) && Number(cache.CACHE_FILES) > 0,
        by.cache.text
    );
    check(
        'the control: pointed at the CLI’s cache, which the tool cannot write, the same process gets none',
        cache.CTRL_DIR === 'none' && cache.CLI_CACHE === 'readonly' && cache.CACHE_ENV !== CLI_CACHE,
        by.cache.text
    );

    // #1023 — git works for the tool in what the CLI made; the CLI never trusts what the tool wrote (its config would run as the CLI).
    const git = values(by.git.text);
    const node = values(nodeGit);
    check(
        'the tool uses any repository the CLI’s uid made, clones it and makes repositories of its own',
        git.TOOL_ON_CLI_REPO === 'ok' && git.TOOL_ON_CTL === 'ok' && git.CLONE === '0' && git.INIT === '0' && git.INIT_CTL === '0',
        by.git.text
    );
    check(
        'the stated limit: the CLI’s uid refuses every repository the tool wrote, so a core.fsmonitor the tool plants never runs as the CLI',
        node.NODE_ON_TOOL_REPO === 'refused' && node.NODE_ON_CLONE === 'refused' && node.NODE_ON_TOOL_CTL === 'refused',
        nodeGit
    );

    // #1024 — one path a skill is loaded from, readable to the tool, whether or not the runner moved the config dir.
    const want = SKILL_BASE[cli];
    check(
        'a skill is loaded from the one baked path, with the runner’s private config dir and without it',
        skillBases.length > 0 && skillBases.every((base) => base === want) && plainSkillBases.length > 0 && plainSkillBases.every((base) => base === want),
        `runner shape ${JSON.stringify(skillBases)}, plain ${JSON.stringify(plainSkillBases)}, want ${want}`
    );
    const skill = values(by['skill-read'].text);
    check(
        'the tool reads the skill at that path, and the control: the CLI’s private directory stays closed to it',
        skill.SKILL_READ === 'ok' && skill.PRIVATE === 'denied',
        by['skill-read'].text
    );
    return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [mode, cli, file] = process.argv.slice(2);
    if (!(cli in TOOLS)) throw new Error('usage: tool-seam-lane.mjs steps|verdict|skill-steps <claude|opencode> [file]');
    if (mode === 'steps') process.stdout.write(`${JSON.stringify(seamSteps(cli))}\n`);
    else if (mode === 'skill-steps') process.stdout.write(`${JSON.stringify(skillOnlySteps(cli))}\n`);
    else if (mode === 'node-repos') process.stdout.write(`${NODE_REPOS}\n`);
    else if (mode === 'node-git') process.stdout.write(`${NODE_GIT}\n`);
    else if (mode === 'verdict') {
        for (const { name, pass, detail } of verdict(cli, JSON.parse(readFileSync(file, 'utf8')))) {
            process.stdout.write(`${pass ? 'ok' : 'bad'}\t${name}\t${detail.replaceAll('\n', ' ')}\n`);
        }
    } else throw new Error(`unknown mode ${mode}`);
}
