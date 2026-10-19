import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        expect(readFileSync(join(skill, '../fix-local/SKILL.md'), 'utf8')).toContain('`sh HEAVY codex exec');
    });

    it('iterate on the focused suite and run the full suite once, as the ship gate', () => {
        const fix = readFileSync(join(skill, 'SKILL.md'), 'utf8');
        expect(fix).toContain('`sh HEAVY npx vitest run --changed $BASE`');
        expect(fix).toContain('The full `npm test` runs once, as the Phase 5 gate');
        expect(readFileSync(join(skill, '../fix-local/SKILL.md'), 'utf8')).toContain('re-run the focused suite');
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

describe('cleanup.sh', () => {
    const fakes = (dir: string, worktree: string) => {
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        const log = join(dir, 'calls');
        const fake = (name: string, body: string) => {
            writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
        };
        fake('kind', `[ "$1 $2" = 'get clusters' ] && printf 'factory\\nfix4242\\nfix4242-lane\\nfix42420\\n'; exit 0`);
        fake(
            'docker',
            [
                'case "$1 $2" in',
                `  'ps -a') case "$*" in *compose*) printf 'fix4242\\nfactory-ai\\n' ;; *) printf 'fix4242-pg\\nfix42420-pg\\nfactory-ai-postgres-1\\n' ;; esac ;;`,
                `  'volume ls') printf 'fix4242-data\\nother\\n' ;;`,
                `  'network ls') printf 'fix4242\\nkind\\n' ;;`,
                'esac',
                'exit 0',
            ].join('\n')
        );
        fake('git', `printf 'worktree /elsewhere/repo\\nworktree ${worktree}\\nworktree ${worktree}0\\n'`);
        return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log };
    };

    it('refuses anything but an issue number', () => {
        expect(spawnSync('sh', [CLEANUP]).status).toBe(2);
        expect(spawnSync('sh', [CLEANUP, 'fix4242']).status).toBe(2);
    });

    it('removes only what is named after the issue and kills processes of its worktrees', async () => {
        const dir = scratch();
        const worktree = join(dir, 'repo-fix-4242');
        const other = join(dir, 'repo-fix-42420');
        mkdirSync(worktree);
        mkdirSync(other);
        const { env, log } = fakes(dir, worktree);
        const keep = 'setInterval(() => {}, 1000)';
        const named = spawn('node', ['-e', keep, join(worktree, 'marker')], { stdio: 'ignore' });
        const inside = spawn('node', ['-e', keep], { cwd: worktree, stdio: 'ignore' });
        const sibling = spawn('node', ['-e', keep, join(other, 'marker')], { stdio: 'ignore' });
        children.push(named, inside, sibling);
        const exited = (child: ChildProcess) => new Promise((resolve) => child.on('exit', resolve));
        const killed = Promise.all([exited(named), exited(inside)]);
        await sleep(200);

        // Async, so the children's exits are reaped while the script still waits on them.
        const run = spawn('sh', [CLEANUP, '4242'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        run.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        expect(await exited(run), stderr).toBe(0);
        await killed;
        expect(sibling.exitCode).toBeNull();

        const calls = readFileSync(log, 'utf8');
        for (const call of [
            'kind delete cluster --name fix4242',
            'kind delete cluster --name fix4242-lane',
            'docker compose -p fix4242 down --volumes --remove-orphans',
            'docker rm -f -v fix4242-pg',
            'docker volume rm fix4242-data',
            'docker network rm fix4242',
        ])
            expect(calls).toContain(`${call}\n`);
        const removals = calls.split('\n').filter((line) => / (delete|rm|down) /.test(line));
        expect(removals).toHaveLength(6);
    }, 30_000);
});
