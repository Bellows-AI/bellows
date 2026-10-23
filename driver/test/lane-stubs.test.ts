import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT, readRepoFile as read } from './fixtures/repo-files.js';

/*
 * The lane stub executor images (scripts/test-jobs.sh, scripts/test-k8s.sh) only build where a
 * docker daemon lives, so these pins are the bytes that keep them on the task supervisor's agent
 * contract (driver/src/supervisor-contract.ts): node-owned mailbox mount points baked into the
 * image, and every executor stub started through scripts/stub-agent.sh, which beats the heartbeat,
 * honors a kill order and writes agent.exit — the real entrypoints' half of the contract.
 */

const MAILBOX =
    'mkdir -p /factory/in /factory/out /factory/export /factory/supervisor /factory/gate /factory/review /factory/binding && chown -R node:node /factory';
const COPY = 'COPY ctl-agent.cjs stub-agent.sh /usr/local/bin/\n';
// Issue #814: the driver starts every agent container as root, so every stub drops to node behind
// the tool broker, the executor images' own launcher.
const ENTRY = 'ENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh",';
const STAGE =
    'cp docker/claude-executor/ctl-agent.cjs docker/claude-executor/factory-launch.sh docker/claude-executor/factory-tool.cjs \\\n' +
    '    docker/claude-executor/tool-bash.sh scripts/stub-agent.sh scripts/lane-gh.sh scripts/stub-runner.Dockerfile "$work/"';
const BASE = read('scripts/stub-runner.Dockerfile');

/** The one printf line that writes `target`. */
const dockerfile = (script: string, target: string): string => {
    const lines = script.split('\n').filter((l) => l.includes(`>${target}`));
    expect(lines).toHaveLength(1);
    return lines[0] ?? '';
};

describe('the lane stub executor images', () => {
    it('stand on one base that bakes the mailbox, the agent helpers and the tool isolation, and ends as node', () => {
        for (const needle of [
            COPY,
            MAILBOX,
            'chmod 0700 /factory/in /factory/out',
            'COPY factory-launch.sh /usr/local/bin/factory-launch\n',
            'COPY factory-tool.cjs /usr/local/lib/factory-tool/factory-tool.cjs\n',
            'COPY tool-bash.sh /usr/local/libexec/factory-tool/bash\n',
            'adduser -D -u 1001 -G node -h /home/factory-tool -s /bin/bash factory-tool',
            'addgroup -g 1002 factory-agent && addgroup node factory-agent',
            'chmod 2750 /run/factory-tool',
            'ln -s /bin/setpriv /usr/bin/setpriv',
            'COPY lane-gh.sh /usr/local/bin/gh\n',
            'chmod 0755 /usr/local/bin/factory-launch /usr/local/libexec/factory-tool/bash /usr/local/bin/gh',
        ]) {
            expect(BASE, needle).toContain(needle);
        }
        expect(BASE.trimEnd().endsWith('USER node')).toBe(true);
    });

    it('test-jobs: every executor stub builds on that base and starts through factory-launch and stub-agent.sh', () => {
        const script = read('scripts/test-jobs.sh');
        expect(script).toContain(STAGE);
        expect(script).toContain('-f "$work/stub-runner.Dockerfile"');
        expect(script.indexOf(STAGE)).toBeLessThan(script.indexOf('-f "$work/stub-runner.Dockerfile"'));
        for (const target of [
            '"$work/Dockerfile.ok"',
            '"$work/Dockerfile.fail"',
            '"$work/run/Dockerfile"',
            '"$work/kill/Dockerfile"',
        ]) {
            expect(dockerfile(script, target)).toContain(ENTRY);
        }
        // The service stub is no agent: no supervisor watches it.
        expect(dockerfile(script, '"$work/svc/Dockerfile"')).not.toContain('stub-agent.sh');
    });

    it('test-k8s: the stub builds on that base and starts through factory-launch and stub-agent.sh', () => {
        const script = read('scripts/test-k8s.sh');
        expect(script).toContain(STAGE);
        const line = dockerfile(script, '"$work/stub.Dockerfile"');
        expect(line).toContain(`${ENTRY}"sh","/stub.sh"]`);
        expect(script).toContain('cp docker/claude-executor/github-credential.cjs "$work/"');
        expect(line).toContain('COPY github-credential.cjs /usr/local/bin/\\n');
        expect(script.indexOf(STAGE)).toBeLessThan(script.indexOf('-f "$work/stub-runner.Dockerfile"'));
        expect(script.indexOf('-f "$work/stub-runner.Dockerfile"')).toBeLessThan(
            script.indexOf('-f "$work/stub.Dockerfile"')
        );
    });

    it('test-k8s: every pod runs the stub by its pushed registry ref, never the bare host name', () => {
        const script = read('scripts/test-k8s.sh');
        expect(script).toContain('STUB_REF="$LANE_REGISTRY/echo-executor:$RELEASE"');
        expect(script).toContain('--set "driver.executorImages.claudeCode=$STUB_REF"');
        expect(script).toContain('--set "driver.executorImages.opencode=$STUB_REF"');
        expect(script).toContain('--image="$STUB_REF"');
        expect(script).toContain('"image":"$STUB_REF"');
        expect(script).toContain('image: $STUB_REF}');
        for (const bare of ['=$STUB_IMAGE"', '--image="$STUB_IMAGE"', '"image":"$STUB_IMAGE"', 'image: $STUB_IMAGE']) {
            expect(script).not.toContain(bare);
        }
    });
});

// Every spawn leads its own process group and is group-killed after its case, so a wrapper, its
// ctl-agent and its command never outlive the case. The ctl-agent is always the wrapper's child, so
// the only pid it can signal is that wrapper.
const spawned: ReturnType<typeof spawn>[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const child of spawned.splice(0)) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            // The whole group already ended.
        }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CASE_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5000;
const POLL_MS = 20;

/** A temp copy of the wrapper beside ctl-agent.cjs, as the images lay them out, plus a mailbox. */
const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-stub-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const inDir = join(root, 'in');
    const outDir = join(root, 'out');
    for (const dir of [bin, inDir, outDir]) mkdirSync(dir);
    copyFileSync(join(ROOT, 'scripts/stub-agent.sh'), join(bin, 'stub-agent.sh'));
    copyFileSync(join(ROOT, 'docker/claude-executor/ctl-agent.cjs'), join(bin, 'ctl-agent.cjs'));
    return { wrapper: join(bin, 'stub-agent.sh'), inDir, outDir };
};

const run = (wrapper: string, args: string[], env: Record<string, string>) => {
    const child = spawn('/bin/sh', [wrapper, ...args], {
        env: { PATH: process.env.PATH ?? '', FACTORY_CTL_TICK_MS: '20', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    spawned.push(child);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stub-agent.sh did not exit')), EXIT_TIMEOUT_MS);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
    return { exited, stdout: () => stdout };
};

const whenFileExists = (path: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + EXIT_TIMEOUT_MS;
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() > deadline) return reject(new Error(`${path} never appeared`));
            setTimeout(poll, POLL_MS);
        };
        poll();
    });

describe('scripts/stub-agent.sh, run locally under /bin/sh', () => {
    it(
        "passes the command's output through and writes and re-raises its exit status",
        async () => {
            const box = sandbox();
            const child = run(box.wrapper, ['sh', '-c', 'echo stub-said; exit 3'], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
            });
            expect(await child.exited).toBe(3);
            expect(child.stdout()).toBe('stub-said\n');
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe('3\n');
            expect(existsSync(join(box.outDir, 'agent.exit.tmp'))).toBe(false);
        },
        CASE_TIMEOUT_MS
    );

    // #829: a helper TERMed while still between its fork and exec runs the shell's handler in the
    // child and swallows the signal; a bare `wait` on it then held PID 1, and the run, forever.
    it(
        'still ends and writes agent.exit when ctl-agent swallows the first TERM',
        async () => {
            const box = sandbox();
            writeFileSync(
                join(dirname(box.wrapper), 'ctl-agent.cjs'),
                "let terms = 0; process.on('SIGTERM', () => { if (++terms > 1) process.exit(143); });\n" +
                    "require('node:fs').writeFileSync(require('node:path').join(process.env.FACTORY_CTL_OUT, 'ctl-ready'), '');\n" +
                    'setInterval(() => {}, 1000);\n'
            );
            const ready = join(box.outDir, 'ctl-ready');
            const child = run(box.wrapper, ['sh', '-c', `while [ ! -e "${ready}" ]; do sleep 0.05; done; exit 6`], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
            });
            expect(await child.exited).toBe(6);
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe('6\n');
        },
        CASE_TIMEOUT_MS
    );

    it(
        'beats agent.alive and ends the command on a kill order',
        async () => {
            const box = sandbox();
            const started = Date.now();
            const child = run(box.wrapper, ['sleep', '30'], { FACTORY_CTL_IN: box.inDir, FACTORY_CTL_OUT: box.outDir });
            await whenFileExists(join(box.outDir, 'agent.alive'));
            writeFileSync(join(box.inDir, 'kill'), '');
            expect(await child.exited).toBe(143);
            expect(Date.now() - started).toBeLessThan(EXIT_TIMEOUT_MS);
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe('143\n');
        },
        CASE_TIMEOUT_MS
    );

    // Issue #771's release: the agent starts only once the supervisor writes `go`, as the real
    // entrypoints do, and a Stop or kill order that lands first means it never starts.
    it(
        'starts the command only once the supervisor writes go',
        async () => {
            const box = sandbox();
            const ran = join(box.outDir, 'ran');
            const go = join(box.inDir, 'go');
            const child = run(box.wrapper, ['sh', '-c', `: > "${ran}"; exit 4`], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
                FACTORY_CTL_GO: go,
            });
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(existsSync(ran)).toBe(false);
            writeFileSync(go, '');
            expect(await child.exited).toBe(4);
            expect(existsSync(ran)).toBe(true);
        },
        CASE_TIMEOUT_MS
    );

    it(
        'leaves quietly, running nothing, when a stop lands before go',
        async () => {
            const box = sandbox();
            const ran = join(box.outDir, 'ran');
            const child = run(box.wrapper, ['sh', '-c', `: > "${ran}"`], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
                FACTORY_CTL_GO: join(box.inDir, 'go'),
            });
            writeFileSync(join(box.inDir, 'stop'), '');
            expect(await child.exited).toBe(0);
            expect(existsSync(ran)).toBe(false);
        },
        CASE_TIMEOUT_MS
    );

    it(
        'runs the command with no mailbox at all and writes nothing',
        async () => {
            const box = sandbox();
            const child = run(box.wrapper, ['sh', '-c', 'echo bare; exit 5'], {});
            expect(await child.exited).toBe(5);
            expect(child.stdout()).toBe('bare\n');
            expect(existsSync(join(box.outDir, 'agent.exit'))).toBe(false);
        },
        CASE_TIMEOUT_MS
    );
});

describe('the kind recovery stub barrier', () => {
    it('blocks until released and lets a replacement observe the same release', async () => {
        const box = sandbox();
        const release = join(box.outDir, 'release');
        const args = ['sh', join(ROOT, 'scripts/k8s-stub.sh'), `prompt factory-stub-wait-${release} handover`];
        const child = run(box.wrapper, args, { HOSTNAME: 'first', CLAUDE_CODE_CONFIG_CONTENT: 'model-marker' });
        await whenFileExists(`${release}.ready-first`);
        expect(child.stdout()).not.toContain('released in');
        writeFileSync(release, '');
        expect(await child.exited).toBe(0);
        expect(child.stdout()).toContain('model-marker');
        expect(child.stdout()).toContain('released in first');
        const replacement = run(box.wrapper, args, { HOSTNAME: 'second' });
        expect(await replacement.exited).toBe(0);
        expect(replacement.stdout()).toContain('released in second');
    });

    it('fails instead of reporting success when the harness never releases it', async () => {
        const box = sandbox();
        const child = run(
            box.wrapper,
            ['sh', join(ROOT, 'scripts/k8s-stub.sh'), `factory-stub-wait-${box.outDir}/absent`],
            {
                FACTORY_STUB_TIMEOUT_SECONDS: '1',
            }
        );
        expect(await child.exited).toBe(1);
        expect(child.stdout()).not.toContain('released in');
    });

    // Issue #829: an agent that only leaves its ready file, so a lane counts its runs without holding it.
    it('passes straight through, leaving its ready file', async () => {
        const box = sandbox();
        const child = run(
            box.wrapper,
            ['sh', join(ROOT, 'scripts/k8s-stub.sh'), `factory-stub-pass-${box.outDir}/case.agent`],
            { HOSTNAME: 'only' }
        );
        expect(await child.exited).toBe(0);
        expect(existsSync(`${box.outDir}/case.agent.ready-only`)).toBe(true);
        expect(child.stdout()).toContain('passed in only');
    });

    // Issue #829: a takeover case holds the agent past the 120 s a plain wait allows.
    it('waits past the plain deadline when it is patient', async () => {
        const box = sandbox();
        const release = join(box.outDir, 'release');
        const stub = join(ROOT, 'scripts/k8s-stub.sh');
        const env = { HOSTNAME: 'first', FACTORY_STUB_TIMEOUT_SECONDS: '1' };
        const patient = run(box.wrapper, ['sh', stub, `factory-stub-patient factory-stub-wait-${release}`], env);
        await whenFileExists(`${release}.ready-first`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        writeFileSync(release, '');
        expect(await patient.exited).toBe(0);
        expect(patient.stdout()).toContain('released in first');
    });

    // Issue #822: a replacement runner on the tree a lost runner left finds that runner's mark and
    // the tree's head, so the lane can tell a restored tree from a re-synced one.
    it('marks the tree on a first run and reports the mark and head to a replacement', async () => {
        const box = sandbox();
        const tree = join(box.outDir, 'tree');
        execFileSync('git', ['init', '-q', '-b', 'main', tree]);
        execFileSync('git', [
            '-C',
            tree,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@localhost',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'the task base',
        ]);
        const release = join(box.outDir, 'release');
        const args = ['sh', join(ROOT, 'scripts/k8s-stub.sh'), `factory-stub-mark factory-stub-wait-${release} lost`];

        // The mark is down before the first run blocks: the lane disrupts it at its barrier.
        const first = run(box.wrapper, args, { HOSTNAME: 'first', WORKDIR: tree });
        await whenFileExists(`${release}.ready-first`);
        expect(readFileSync(join(tree, '.factory', 'stub-mark'), 'utf8')).toBe('first\n');
        writeFileSync(release, '');
        expect(await first.exited).toBe(0);
        expect(first.stdout()).toContain('released in first');

        const replacement = run(box.wrapper, args, { HOSTNAME: 'second', WORKDIR: tree });
        expect(await replacement.exited).toBe(0);
        expect(replacement.stdout()).toContain('mark kept from first head: the task base');
        expect(replacement.stdout()).not.toContain('released in');
    });

    // Issue #770: the kind control cases drive a Stop and a question through the supervisor.
    it('ends a stoppable wait on the supervisor’s Stop, and only a stoppable one', async () => {
        const box = sandbox();
        const release = join(box.outDir, 'release');
        const env = { HOSTNAME: 'first', FACTORY_CTL_IN: box.inDir, FACTORY_CTL_OUT: box.outDir };
        const stub = join(ROOT, 'scripts/k8s-stub.sh');
        const deaf = run(box.wrapper, ['sh', stub, `factory-stub-wait-${release}-deaf`], {
            ...env,
            FACTORY_STUB_TIMEOUT_SECONDS: '2',
        });
        const stoppable = run(box.wrapper, ['sh', stub, `factory-stub-stop factory-stub-wait-${release}`], env);
        await whenFileExists(`${release}.ready-first`);
        await whenFileExists(`${release}-deaf.ready-first`);
        writeFileSync(join(box.inDir, 'stop'), 'stop\n');
        expect(await stoppable.exited).toBe(0);
        expect(stoppable.stdout()).toContain('stopped in first');
        expect(await deaf.exited).toBe(1);
        expect(deaf.stdout()).not.toContain('stopped in');
    });

    it('asks one question through the mailbox after its delay, and goes on only once it is answered', async () => {
        const box = sandbox();
        const release = join(box.outDir, 'release');
        const env = { HOSTNAME: 'first', FACTORY_CTL_IN: box.inDir, FACTORY_CTL_OUT: box.outDir };
        const args = ['sh', join(ROOT, 'scripts/k8s-stub.sh'), `factory-stub-ask-1 factory-stub-wait-${release}`];
        const asked = Date.now();
        const child = run(box.wrapper, args, env);
        const question = join(box.outDir, 'questions', 'stub-first.json');
        await whenFileExists(question);
        expect(Date.now() - asked).toBeGreaterThanOrEqual(1000);
        expect(JSON.parse(readFileSync(question, 'utf8'))).toMatchObject({
            questionId: 'stub-first',
            questions: [{ options: [{ label: 'Red' }, { label: 'Blue' }] }],
        });
        expect(existsSync(`${release}.ready-first`)).toBe(false);
        mkdirSync(join(box.inDir, 'answers'));
        writeFileSync(join(box.inDir, 'answers', 'stub-first.json'), '{"state":"pending"}');
        writeFileSync(
            join(box.inDir, 'answers', 'stub-first.json'),
            JSON.stringify({ state: 'answered', answers: { 'Which colour should the report use?': 'Blue' } })
        );
        await whenFileExists(`${release}.ready-first`);
        writeFileSync(release, '');
        expect(await child.exited).toBe(0);
        expect(child.stdout()).toContain('ANSWER: {"state":"answered"');
        expect(child.stdout()).toContain('Blue');
    });

    it('fails when its question is settled any way but answered', async () => {
        const box = sandbox();
        const env = { HOSTNAME: 'first', FACTORY_CTL_IN: box.inDir, FACTORY_CTL_OUT: box.outDir };
        const child = run(box.wrapper, ['sh', join(ROOT, 'scripts/k8s-stub.sh'), 'factory-stub-ask-0'], env);
        await whenFileExists(join(box.outDir, 'questions', 'stub-first.json'));
        mkdirSync(join(box.inDir, 'answers'));
        writeFileSync(join(box.inDir, 'answers', 'stub-first.json'), '{"state":"cancelled"}');
        expect(await child.exited).toBe(1);
        expect(child.stdout()).toContain('ANSWER: {"state":"cancelled"}');
    });
});

// #829: the driver-kill lanes (test-jobs `driver-kill`, test-k8s `takeover`) need a commit to
// publish and a stand-in for `gh`, with state that survives the driver being killed.
describe('scripts/k8s-stub.sh factory-stub-commit', () => {
    it('leaves one empty lane-commit on the task branch before any wait', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lane-commit-'));
        dirs.push(dir);
        execFileSync('git', ['init', '-q', '-b', 'main', dir]);
        const identity = ['-c', 'user.name=t', '-c', 'user.email=t@localhost'];
        execFileSync('git', ['-C', dir, ...identity, 'commit', '-q', '--allow-empty', '-m', 'the task base']);
        execFileSync('sh', [join(ROOT, 'scripts/k8s-stub.sh'), 'factory-stub-commit'], {
            env: { PATH: process.env.PATH ?? '', WORKDIR: dir },
        });
        const log = execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' });
        expect(log).toBe('lane-commit\nthe task base\n');
    });
});

describe('scripts/lane-gh.sh, run locally under /bin/sh', () => {
    const gh = join(ROOT, 'scripts/lane-gh.sh');
    /** A state directory standing for /task/.lane-gh, and a working directory: where the stub keeps its state. */
    const fixture = () => {
        const root = mkdtempSync(join(tmpdir(), 'lane-gh-'));
        dirs.push(root);
        const origin = join(root, 'state');
        const tree = join(root, 'tree');
        mkdirSync(origin);
        mkdirSync(tree);
        const env = { ...process.env, LANE_GH_STATE: origin };
        const call = (...args: string[]) => {
            try {
                return {
                    code: 0,
                    out: execFileSync('sh', [gh, ...args], { cwd: tree, env, encoding: 'utf8', timeout: 10_000 }),
                };
            } catch (e) {
                return { code: (e as { status: number }).status, out: String((e as { stdout: Buffer }).stdout) };
            }
        };
        return { origin, tree, call, env };
    };

    it('has no PR until one is created, then answers the recorded URL and a main base', () => {
        const { call, origin } = fixture();
        const view = ['pr', 'view', 'task-1', '--json', 'url', '-q', '.url'];
        expect(call(...view).code).toBe(1);
        const created = call('pr', 'create', '--head', 'task-1', '--title', 't', '--body', 'b');
        expect(created.code).toBe(0);
        expect(created.out.trim()).toBe('https://github.com/factory-smoke/demo/pull/1');
        expect(call(...view)).toEqual({ code: 0, out: 'https://github.com/factory-smoke/demo/pull/1\n' });
        expect(call('pr', 'view', 'task-1', '--json', 'state,baseRefName', '-q', '.state').out).toBe('OPEN main\n');
        expect(call('pr', 'edit', 'task-1', '--base', 'release').code).toBe(0);
        expect(call('pr', 'view', 'task-1', '--json', 'state,baseRefName', '-q', '.state').out).toBe('OPEN release\n');
        expect(readFileSync(join(origin, 'lane-gh-prs'), 'utf8')).toBe(
            'task-1 https://github.com/factory-smoke/demo/pull/1\n'
        );
    });

    it('refuses what it does not know', () => {
        expect(fixture().call('repo', 'view').code).toBe(2);
    });

    it('holds a create at the hold file until released, and records it once', async () => {
        const { call, origin, tree, env } = fixture();
        writeFileSync(join(origin, 'lane-gh-hold'), '');
        const child = spawn('sh', [gh, 'pr', 'create', '--head', 'task-2', '--title', 't', '--body', 'b'], {
            cwd: tree,
            env,
            stdio: ['ignore', 'pipe', 'ignore'],
            detached: true,
        });
        spawned.push(child);
        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        await whenFileExists(join(origin, 'lane-gh-hold.ready'));
        expect(existsSync(join(origin, 'lane-gh-prs'))).toBe(false);
        writeFileSync(join(origin, 'lane-gh-hold.go'), '');
        expect(await exited).toBe(0);
        expect(readFileSync(join(origin, 'lane-gh-prs'), 'utf8')).toBe(
            'task-2 https://github.com/factory-smoke/demo/pull/1\n'
        );
        expect(call('pr', 'view', 'task-2', '--json', 'url', '-q', '.url').code).toBe(0);
    });
});

describe('scripts/k8s-stub.sh factory-stub-sleep (issue #831)', () => {
    const stub = join(ROOT, 'scripts/k8s-stub.sh');
    const sleepRun = (command: string) => {
        const started = Date.now();
        const run = spawnSync('sh', [stub, command], {
            encoding: 'utf8',
            env: { ...process.env, HOSTNAME: 'bench-pod' },
        });
        return { run, seconds: (Date.now() - started) / 1000 };
    };

    it('holds for the named seconds, says where it slept and exits 0', () => {
        const { run, seconds } = sleepRun('factory-stub-sleep-1');
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('slept in bench-pod');
        expect(seconds).toBeGreaterThanOrEqual(1);
    });

    it('refuses a marker with no number', () => {
        const { run } = sleepRun('factory-stub-sleep-');
        expect(run.status).toBe(1);
        expect(run.stdout).not.toContain('slept in');
    });
});
