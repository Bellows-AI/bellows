import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The fix skill's host scripts: heavy.sh queues heavy commands behind a host-wide slot count, and
 * cleanup.sh tears down what one issue's run left running. Both run under sh against real
 * processes; docker, kind and git are fakes on PATH that log their argv.
 */

const skill = fileURLToPath(new URL('../../.claude/skills/fix/', import.meta.url));
const HEAVY = join(skill, 'heavy.sh');
const CLEANUP = join(skill, 'cleanup.sh');
const codex = () => readFileSync(join(skill, 'blocks/review-codex.md'), 'utf8');

const dirs: string[] = [];
const children: ChildProcess[] = [];
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-scripts-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const heavyEnv = (state: string, slots = 1) => ({
    ...process.env,
    FACTORY_HEAVY_DIR: state,
    FACTORY_HEAVY_SLOTS: String(slots),
    FACTORY_HEAVY_POLL: '0.1',
    // The host guard reads this machine's real load; the tests that exercise it fake the probe.
    FACTORY_HEAVY_GUARD: '0',
});
const startHeavy = (env: NodeJS.ProcessEnv, args: string[]) => {
    const child = spawn('sh', [HEAVY, ...args], { env, stdio: 'ignore' });
    children.push(child);
    const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, done };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await sleep(50);
    expect(check()).toBe(true);
};
const deadPid = () => spawnSync('true').pid!;

describe('the fix skills', () => {
    it('route heavy commands and cleanup through these scripts', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('`<root>/.claude/skills/fix/heavy.sh`');
        expect(fix).toContain('`<root>/.claude/skills/fix/cleanup.sh`');
        expect(fix).toContain('`sh CLEANUP <N>` run');
        expect(codex()).toContain('`sh HEAVY codex exec');
    });

    it('plug an issue source and a reviewer into one workflow', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        const github = readFileSync(join(skill, 'blocks/source-github.md'), 'utf8');
        for (const step of ['**Fetch**', '**Close line**', '**File a follow-up**', '**After the PR**']) {
            expect(fix).toContain(step);
            expect(github).toContain(step);
        }
        expect(github).toContain('`Fixes #<N>`');
        const local = readFileSync(join(skill, '../fix-local/SKILL.md'), 'utf8');
        expect(local).toContain('`<repo root>/.claude/skills/fix/blocks/source-github.md`');
        expect(local).toContain('`<repo root>/.claude/skills/fix/blocks/review-codex.md`');
    });

    it('iterate on the focused suite and run the full suite once, as the ship gate', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('`sh HEAVY npx vitest run --changed $BASE`');
        expect(fix).toContain('The full `npm test` runs once, as the Phase 5 gate');
        expect(codex()).toContain('re-run the focused suite');
    });

    it('iterate on test:changed or one project, in AGENTS.md and both fix skills', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('`sh HEAVY npm run test:changed -- $BASE`');
        expect(fix).toContain('`npx vitest run --project <pkg>`');
        expect(readFileSync(join(skill, '../ui-fix/SKILL.md'), 'utf8')).toContain('`npm run test:changed`');
        expect(readFileSync(join(skill, '../../../AGENTS.md'), 'utf8')).toContain('npm run test:changed ');
    });

    it('fix a review finding by its class, sweep accepted classes and defer out-of-path defects', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('**Fix the class, not the line.**');
        expect(fix).toContain('`deferred: <ref>`');
        expect(fix).toContain("The cap is the user's to raise, never the run's.");
        expect(codex()).toContain('the sweep block');
        expect(codex()).toContain('No major issue means the round passes.');
        expect(codex()).toContain('only a major defect counts as a blocker');
        expect(readFileSync(join(skill, '../../agents/fix-planner.md'), 'utf8')).toContain('- **Hazards**:');
    });

    it('bound context: narrow reads, logs on disk, one wait, one implementer per commit, no context cap', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('**Read narrowly.**');
        expect(fix).toContain('**Suite output stays on disk.**');
        expect(fix).toContain('**Wait in one call.**');
        expect(fix).toContain('never two agents on the same\n  commit or tree');
        expect(fix).toContain('**Implementers are fresh agents, never forks.**');
        // A context cap made agents stop mid-task and lose what a handoff note did not carry.
        expect(fix).not.toContain('tokens of context.**');
        expect(fix).toContain('`<scratchpad>/diff-<N>-r<round>.patch`');
        expect(fix).toContain('`gh pr checks <PR_NUMBER> --watch');
    });

    it('rerun a failed lane only after a reproducing test or an environmental verdict', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('**A failed lane is not rerun to find its cause.**');
        expect(fix).toContain('The same case failing twice is never environmental: reproduce it.');
    });

    it('brief agents with one spec, keep plans on disk, revise them, and retire agents at a boundary', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        for (const rule of [
            '**Brief contract.**',
            '**Retire an agent at a boundary, never mid-task.**',
            '**Keep this conversation resumable.**',
            '**Revise, never re-plan from scratch.**',
            '**Slices stay small.**',
            '**A class found in two rounds needs a redesign, not a third patch:**',
            '**Gate evidence names what it ran on.**',
            'Telling the user\n   after a merge is not asking.',
            'PLAN=`<scratchpad>/plan-<N>.md`',
        ])
            expect(fix).toContain(rule);
        expect(fix).toContain('Unfinished work is never cut\n  off to meet the limit.');
        const planner = readFileSync(join(skill, '../../agents/fix-planner.md'), 'utf8');
        expect(planner).toContain('tools: Read, Grep, Glob, Write');
        expect(planner).toContain('You write exactly one file: the plan path your brief names.');
        expect(codex()).toContain('The plan: read <PLAN, the plan file');
        expect(codex()).not.toContain('re-spawn the fix-planner');
    });

    it("count heavy.sh's host-kill rerun as the one environmental rerun", () => {
        expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toContain(
            'That rerun is the one an environmental verdict allows — a second failure is real.'
        );
    });

    it('schedule no model check-ins on background agents', () => {
        // A 20-minute tick woke a 250-520K-token conversation ~100 times a week to report nothing.
        expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).not.toMatch(/send_later|every 20 minutes/);
    });
});

describe('heavy.sh', () => {
    it('passes stdin through and exits with the command status', () => {
        const run = spawnSync('sh', [HEAVY, 'sh', '-c', 'cat; exit 7'], { env: heavyEnv(scratch()), input: 'hi' });
        expect(run.stdout.toString()).toBe('hi');
        expect(run.status).toBe(7);
    });

    it.each([
        ['no command', [], {}],
        ['a zero slot count', ['true'], { FACTORY_HEAVY_SLOTS: '0' }],
        ['a non-numeric slot count', ['true'], { FACTORY_HEAVY_SLOTS: 'two' }],
    ])('refuses %s', (_label, args, extra) => {
        const run = spawnSync('sh', [HEAVY, ...args], { env: { ...heavyEnv(scratch()), ...extra } });
        expect(run.status).toBe(2);
    });

    it('runs one command at a time on a single slot', async () => {
        const dir = scratch();
        const log = join(dir, 'log');
        const step = `echo start >> ${log}; sleep 0.3; echo end >> ${log}`;
        const runs = [startHeavy(heavyEnv(join(dir, 'state')), ['sh', '-c', step])];
        await until(() => existsSync(log));
        runs.push(startHeavy(heavyEnv(join(dir, 'state')), ['sh', '-c', step]));
        expect(await Promise.all(runs.map((run) => run.done))).toEqual([0, 0]);
        expect(readFileSync(log, 'utf8')).toBe('start\nend\nstart\nend\n');
    });

    it('reclaims a slot whose holder died', () => {
        const state = scratch();
        writeFileSync(join(state, 'slot-1'), `${deadPid()}\tgone\n`);
        const run = spawnSync('sh', [HEAVY, 'true'], { env: heavyEnv(state), timeout: 5000 });
        expect(run.status).toBe(0);
        expect(existsSync(join(state, 'slot-1'))).toBe(false);
    });

    it('queues --exclusive behind a live holder and holds later shared claims behind it', async () => {
        const dir = scratch();
        const state = join(dir, 'state');
        const log = join(dir, 'log');
        mkdirSync(state);
        writeFileSync(join(state, 'slot-1'), `${process.pid}\tlive\n`);
        const exclusive = startHeavy(heavyEnv(state, 2), ['--exclusive', 'sh', '-c', `echo exclusive >> ${log}`]);
        await until(() => existsSync(join(state, 'exclusive-wait')));
        const shared = startHeavy(heavyEnv(state, 2), ['sh', '-c', `echo shared >> ${log}`]);
        await sleep(400);
        expect(existsSync(log)).toBe(false);
        rmSync(join(state, 'slot-1'));
        expect(await Promise.all([exclusive.done, shared.done])).toEqual([0, 0]);
        expect(readFileSync(log, 'utf8')).toBe('exclusive\nshared\n');
    });

    it('forwards a signal to the command and frees its slot', async () => {
        const state = scratch();
        const run = startHeavy(heavyEnv(state), ['sleep', '30']);
        await until(() => existsSync(join(state, 'slot-1')));
        await sleep(100);
        run.child.kill('SIGTERM');
        expect(await run.done).toBe(143);
        expect(existsSync(join(state, 'slot-1'))).toBe(false);
    });
});

describe('heavy.sh host guard', () => {
    // <load> <cores> <free %>, read by the probe on every check.
    const guarded = (dir: string, host: string, extra: NodeJS.ProcessEnv = {}) => {
        const probe = join(dir, 'host');
        writeFileSync(probe, host);
        return {
            probe,
            env: {
                ...heavyEnv(join(dir, 'state')),
                FACTORY_HEAVY_GUARD: '1',
                FACTORY_HEAVY_PROBE: `cat ${probe}`,
                FACTORY_HEAVY_SWEEP_UNDER: join(dir, 'checkouts/'),
                ...extra,
            },
        };
    };
    const runHeavy = (env: NodeJS.ProcessEnv, args: string[]) => {
        const child = spawn('sh', [HEAVY, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
        return { child, done, stderr: () => stderr };
    };
    const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

    it.each([
        ['load over twice the cores', '40 8 50', 'load 40 over 16'],
        ['low free memory', '1 8 5', 'free memory 5% under 15%'],
    ])('holds the slot while the host shows %s, then runs', async (_label, busy, reason) => {
        const dir = scratch();
        const log = join(dir, 'log');
        const { env, probe } = guarded(dir, busy);
        const run = runHeavy(env, ['sh', '-c', `echo ran >> ${log}`]);
        await until(() => run.stderr().includes(`holding the slot until the host settles (${reason})`));
        await sleep(300);
        expect(existsSync(log)).toBe(false);
        writeFileSync(probe, '1 8 50');
        expect(await run.done).toBe(0);
        expect(lines(log)).toEqual(['ran']);
    });

    it('runs anyway once the host wait is spent', async () => {
        const dir = scratch();
        const { env } = guarded(dir, '40 8 50', { FACTORY_HEAVY_HOST_WAIT: '0' });
        const run = runHeavy(env, ['true']);
        expect(await run.done).toBe(0);
        expect(run.stderr()).toContain('host still busy (load 40 over 16) after 0s; running anyway');
    });

    it.each([
        ['KILL', 137],
        ['TERM', 143],
    ])('reruns once a command the host killed with SIG%s', async (signal, code) => {
        const dir = scratch();
        const log = join(dir, 'log');
        const { env } = guarded(dir, '1 8 50');
        const run = runHeavy(env, ['sh', '-c', `echo ran >> ${log}; kill -${signal} $$`]);
        expect(await run.done).toBe(code);
        expect(lines(log)).toEqual(['ran', 'ran']);
        expect(run.stderr()).toContain(`exit ${code} and nobody signalled heavy.sh`);
    });

    it('never reruns an ordinary failure, a signalled run, or with the guard off', async () => {
        const dir = scratch();
        const log = join(dir, 'log');
        const { env } = guarded(dir, '1 8 50');
        expect(await runHeavy(env, ['sh', '-c', `echo fail >> ${log}; exit 1`]).done).toBe(1);
        expect(
            await runHeavy({ ...env, FACTORY_HEAVY_GUARD: '0' }, ['sh', '-c', `echo off >> ${log}; kill -KILL $$`]).done
        ).toBe(137);
        const signalled = runHeavy(env, ['sh', '-c', `echo signalled >> ${log}; sleep 30`]);
        await until(() => lines(log).includes('signalled'));
        signalled.child.kill('SIGTERM');
        expect(await signalled.done).toBe(143);
        await sleep(300);
        expect(lines(log)).toEqual(['fail', 'off', 'signalled']);
    });

    it('kills orphaned test runners before it claims, and spares ones with a live parent', async (ctx) => {
        const dir = scratch();
        const runner = join(dir, 'checkouts/repo/node_modules/vitest/runner.js');
        mkdirSync(join(dir, 'checkouts/repo/node_modules/vitest'), { recursive: true });
        writeFileSync(runner, 'setInterval(() => {}, 1000);\n');
        const titled = `process.title = 'node (vitest 99)'; setInterval(() => {}, 1000);`;
        // Started from a shell that exits at once, so each is reparented: an orphan.
        const orphan = (cmd: string) =>
            Number(spawnSync('sh', ['-c', `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
        const orphans = [orphan(`node -e "${titled}"`), orphan(`node ${runner}`)];
        const parented = spawn('node', ['-e', titled], { stdio: 'ignore' });
        children.push(parented);
        const ppid = (pid: number) =>
            spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0;
        for (let i = 0; i < 40 && !orphans.every((pid) => ppid(pid) === '1'); i++) await sleep(50);
        if (!orphans.every((pid) => ppid(pid) === '1')) {
            // A subreaper (some CI containers) adopts orphans instead of PID 1: not this host's shape.
            for (const pid of orphans) spawnSync('kill', ['-KILL', String(pid)]);
            ctx.skip();
        }
        await sleep(200);

        const { env } = guarded(dir, '1 8 50');
        const run = runHeavy(env, ['true']);
        expect(await run.done).toBe(0);
        expect(run.stderr()).toContain('killing orphaned test runners');
        await until(() => orphans.every((pid) => !alive(pid)));
        expect(alive(parented.pid!)).toBe(true);
    }, 15_000);
});

describe('cleanup.sh', () => {
    const fakes = (dir: string, worktree: string, tag: string) => {
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        const log = join(dir, 'calls');
        const fake = (name: string, body: string) => {
            writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
        };
        fake(
            'kind',
            `[ "$1 $2" = 'get clusters' ] && printf 'factory\\nfix${tag}\\nfix${tag}-lane\\nfix${tag}0\\n'; exit 0`
        );
        fake(
            'docker',
            [
                'case "$1 $2" in',
                `  'ps -a') case "$*" in *compose*) printf 'fix${tag}\\nfactory-ai\\n' ;; *) printf 'fix${tag}-pg\\nfix${tag}0-pg\\nfactory-ai-postgres-1\\n' ;; esac ;;`,
                `  'volume ls') printf 'fix${tag}-data\\nother\\n' ;;`,
                `  'network ls') printf 'fix${tag}\\nkind\\n' ;;`,
                'esac',
                'exit 0',
            ].join('\n')
        );
        fake('git', `printf 'worktree /elsewhere/repo\\nworktree ${worktree}\\nworktree ${worktree}0\\n'`);
        return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log };
    };

    it('refuses anything but an issue number or a lowercase tracker key', () => {
        for (const arg of [[], ['fix4242'], ['ENG-12'], ['eng'], ['eng-12-x'], ['4242\nx']])
            expect(spawnSync('sh', [CLEANUP, ...arg]).status, String(arg)).toBe(2);
    });

    it.each(['4242', 'eng-42'])(
        'removes only what is named after issue %s and kills processes of its worktrees',
        async (tag) => {
            const dir = scratch();
            const worktree = join(dir, `repo-fix-${tag}`);
            const other = join(dir, `repo-fix-${tag}0`);
            mkdirSync(worktree);
            mkdirSync(other);
            const { env, log } = fakes(dir, worktree, tag);
            const keep = 'setInterval(() => {}, 1000)';
            const named = spawn('node', ['-e', keep, join(worktree, 'marker')], { stdio: 'ignore' });
            const inside = spawn('node', ['-e', keep], { cwd: worktree, stdio: 'ignore' });
            const sibling = spawn('node', ['-e', keep, join(other, 'marker')], { stdio: 'ignore' });
            children.push(named, inside, sibling);
            const exited = (child: ChildProcess) => new Promise((resolve) => child.on('exit', resolve));
            const killed = Promise.all([exited(named), exited(inside)]);
            await sleep(200);

            // Async, so the children's exits are reaped while the script still waits on them.
            const run = spawn('sh', [CLEANUP, tag], { env, stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            run.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            expect(await exited(run), stderr).toBe(0);
            await killed;
            expect(sibling.exitCode).toBeNull();

            const calls = readFileSync(log, 'utf8');
            for (const call of [
                `kind delete cluster --name fix${tag}`,
                `kind delete cluster --name fix${tag}-lane`,
                `docker compose -p fix${tag} down --volumes --remove-orphans`,
                `docker rm -f -v fix${tag}-pg`,
                `docker volume rm fix${tag}-data`,
                `docker network rm fix${tag}`,
            ])
                expect(calls).toContain(`${call}\n`);
            const removals = calls.split('\n').filter((line) => / (delete|rm|down) /.test(line));
            expect(removals).toHaveLength(6);
        },
        30_000
    );

    it.skipIf(!existsSync('/proc/self'))(
        'finds a process by its working directory through /proc on a host without lsof',
        async () => {
            const dir = scratch();
            const worktree = join(dir, 'repo-fix-4242');
            mkdirSync(worktree);
            const { env } = fakes(dir, worktree, '4242');
            // A PATH of the tools the script needs, lsof left out: a slim image ships none.
            const tools = join(dir, 'tools');
            mkdirSync(tools);
            for (const tool of ['awk', 'dirname', 'grep', 'ps', 'readlink', 'sed', 'sleep', 'sort', 'tr']) {
                const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
                symlinkSync(found, join(tools, tool));
            }
            const inside = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, stdio: 'ignore' });
            children.push(inside);
            const killed = new Promise((resolve) => inside.on('exit', resolve));
            await sleep(200);

            // Only the kill is asserted: the stripped PATH fails the cluster teardown, not under test here.
            const run = spawnSync('/bin/sh', [CLEANUP, '4242'], {
                env: { ...env, PATH: `${join(dir, 'bin')}:${tools}` },
                encoding: 'utf8',
            });
            expect(run.stdout).toMatch(new RegExp(`kill -TERM( \\d+)* ${inside.pid}( |$)`, 'm'));
            await killed;
        },
        30_000
    );
});
