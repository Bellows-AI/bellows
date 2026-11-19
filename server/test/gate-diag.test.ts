import { spawn } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));
const URL_ARG = 'postgres://factory:factory@127.0.0.1:5432/postgres';
const DURATION =
    '   Duration  10.88s (transform 2.33s, setup 0ms, collect 3.70s, tests 5.00s, environment 1.83s, prepare 131ms)';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(prefix: string): { root: string; bin: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    return { root, bin, log: join(root, 'calls.log') };
}

function tool(bin: string, name: string, body: string): void {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
}

// Only the fakes, the real node and the system tools: no PGOPTIONS or other state from the host.
function env(bin: string, extra: Record<string, string>): NodeJS.ProcessEnv {
    return {
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ...extra,
    };
}

const lines = (calls: string) => calls.split('\n').filter((line) => line !== '');

// spawn, awaited: a pass runs a dozen node processes, and a synchronous wait that long blocks the
// worker's own RPC to vitest.
function exec(
    args: string[],
    opts: { cwd?: string; env: NodeJS.ProcessEnv }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn('sh', args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 55_000);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

interface Pass {
    status: number | null;
    stdout: string;
    stderr: string;
    calls: string[];
    /** Every value printed for a measure, in order. */
    values: (key: string) => string[];
    value: (key: string) => string | undefined;
    root: string;
}

// scripts/gate-diag.sh against fake psql, nproc, mount, npm and npx on PATH and the real node.
// The checkout is a temp dir with a small node_modules; each fake logs its argv (and the postgres
// clients their env) so a case reads what ran, in what order.
async function runPass(
    opts: { url?: boolean; nodeModules?: boolean; env?: Record<string, string> } = {}
): Promise<Pass> {
    const { root, bin, log } = fixture('gate-diag-');
    const work = join(root, 'work');
    mkdirSync(join(work, 'scripts'), { recursive: true });
    copyFileSync(join(SCRIPTS, 'gate-diag.sh'), join(work, 'scripts', 'gate-diag.sh'));
    copyFileSync(join(SCRIPTS, 'gate-pg-fast.sh'), join(work, 'scripts', 'gate-pg-fast.sh'));
    if (opts.nodeModules !== false) {
        mkdirSync(join(work, 'node_modules', 'typescript'), { recursive: true });
        mkdirSync(join(work, 'node_modules', 'left-pad'), { recursive: true });
        writeFileSync(join(work, 'node_modules', 'typescript', 'index.js'), 'module.exports = {};\n');
        writeFileSync(join(work, 'node_modules', 'typescript', 'package.json'), '{"main":"index.js"}\n');
        writeFileSync(join(work, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    }
    const pg = `printf '%s PGCONNECT_TIMEOUT=%s PGOPTIONS=%s %s\\n' "$(basename "$0")" "\${PGCONNECT_TIMEOUT:-}" "\${PGOPTIONS:-}" "$*" >> "${log}"`;
    // `-f <file>`: logs the workload's name, its first-last id and its statement count instead of running
    // it; FAKE_PSQL_FAIL names one workload (or `create`, the table setup) that fails.
    tool(
        bin,
        'psql',
        `${pg}
[ "\${FAKE_PSQL_STATUS:-0}" = 0 ] || exit "$FAKE_PSQL_STATUS"
file= prev=
for arg in "$@"; do [ "$prev" = -f ] && file=$arg; prev=$arg; done
if [ -n "$file" ]; then
    name=$(basename "$file" .sql)
    first=$(head -n 1 "$file" | tr -cd 0-9); last=$(tail -n 1 "$file" | tr -cd 0-9); n=$(wc -l < "$file" | tr -d ' ')
    echo "psql-file $name $first-$last $n" >> "${log}"
    [ "$name" != "\${FAKE_PSQL_FAIL:-}" ] || exit 3
    exit 0
fi
case "$*" in
*'alter system'*) [ -n "\${FAKE_PSQL_STUCK:-}" ] || : > "${root}/fast" ;;
*'create table gate_diag'*) [ "\${FAKE_PSQL_FAIL:-}" != create ] || exit 3 ;;
*server_version*) echo 17.2 ;;
*data_directory*) echo /var/lib/postgresql/data ;;
*pg_read_file*) printf '%s\\n' '61 1 0:40 / / rw - virtiofs none rw' '62 61 0:41 / /dev/shm rw - tmpfs shm rw' ;;
*current_setting*)
    if [ -f "${root}/fast" ]; then echo 'fsync=off synchronous_commit=off full_page_writes=off'
    else echo 'fsync=on synchronous_commit=on full_page_writes=on'; fi ;;
esac`
    );
    tool(bin, 'nproc', `[ -z "\${FAKE_NO_NPROC:-}" ] || { echo 'nproc: not found' >&2; exit 127; }\necho 4`);
    tool(
        bin,
        'mount',
        "printf '%s\\n' 'none on /task type virtiofs (rw)' 'overlay on / type overlay (rw)' 'proc on /proc type proc (rw)'"
    );
    tool(bin, 'npm', `echo "npm $*" >> "${log}"\nexit "\${FAKE_NPM_STATUS:-0}"`);
    tool(
        bin,
        'npx',
        `echo "npx cwd=$(pwd) $*" >> "${log}"
[ -z "\${FAKE_NPX_SILENT:-}" ] || exit 1
echo ' Test Files  1 passed (1)'
echo '${DURATION}'
exit "\${FAKE_NPX_STATUS:-0}"`
    );
    const args = [join('scripts', 'gate-diag.sh'), ...(opts.url === false ? [] : [URL_ARG])];
    // A short CPU loop and 8 rows: their values are not under test, only how they are run and timed.
    const extra = { GATE_DIAG_LOOP: '1000', GATE_DIAG_PG_ROWS: '8', ...opts.env };
    const run = await exec(args, { cwd: work, env: env(bin, extra) });
    const out = lines(run.stdout).map((line) => line.split('\t'));
    const values = (key: string) => out.filter(([k]) => k === key).map(([, v]) => v ?? '');
    return {
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        calls: existsSync(log) ? lines(readFileSync(log, 'utf8')) : [],
        values,
        value: (key) => values(key)[0],
        root,
    };
}

const NUMBER = /^\d+(\.\d+)?$/;
const REQUIRED = [
    'nproc',
    'available_parallelism',
    'files_count',
    'files_seconds',
    'node_baseline_seconds',
    'require_typescript_seconds',
    'core_build_seconds',
    'vitest_seconds',
    'vitest_transform',
    'vitest_setup',
    'vitest_collect',
    'vitest_tests',
    'vitest_environment',
    'vitest_prepare',
    'vitest_exit',
    'pg_version',
    'pg_data_directory',
    'pg_settings_durable',
    'pg_durable_write_c1_tps',
    'pg_durable_read_c1_tps',
    'pg_durable_write_c4_tps',
    'pg_settings_fast',
    'pg_fast_write_c1_tps',
    'pg_fast_read_c1_tps',
    'pg_fast_write_c4_tps',
];
const WORKLOADS = ['write_c1', 'read_c1', 'write_c4'];
const TPS = (set: string) => WORKLOADS.map((w) => `pg_${set}_${w}_tps`);
const INFORMATIONAL = ['mem_total', 'cgroup_cpu_max', 'cpu_model', 'hypervisor', 'fs_cwd', 'fs_root'];
const PG = REQUIRED.filter((key) => key.startsWith('pg'));
const VITEST = ['vitest_seconds', 'vitest_transform', 'vitest_setup', 'vitest_collect', 'vitest_tests'];
const PHASES = [...VITEST, 'vitest_environment', 'vitest_prepare'];

// A pass spawns a dozen node processes one after another: on a loaded host that outruns the default
// 30 s. The cases stay sequential; run concurrently they starve the spawn tier's other files.
describe('scripts/gate-diag.sh', { timeout: 60_000 }, () => {
    it('prints every required measure as one tab-separated line', async () => {
        const run = await runPass();
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        for (const key of [...REQUIRED, ...INFORMATIONAL]) expect(run.values(key), key).toHaveLength(1);
        for (const key of REQUIRED) expect(run.value(key), key).not.toBe('unmeasured');
        expect(run.values('cpu_loop_seconds')).toHaveLength(3);
        for (const value of run.values('cpu_loop_seconds')) expect(value).toMatch(NUMBER);
        expect(run.value('nproc')).toBe('4');
        expect(run.value('files_count')).toBe('3');
        expect(run.values('mount')).toEqual(['none on /task type virtiofs (rw)', 'overlay on / type overlay (rw)']);
        for (const line of lines(run.stdout)) expect(line.split('\t'), line).toHaveLength(2);
    });

    it('measures postgres durable, applies gate-pg-fast, then measures fast', async () => {
        const run = await runPass();
        expect(run.status).toBe(0);
        const pg = run.calls.filter((call) => call.startsWith('psql '));
        const settings = (call: string) => call.includes("current_setting('fsync')");
        const steps = run.calls
            .map((call) => {
                if (call.startsWith('psql-file ')) return call.slice('psql-file '.length);
                if (!call.startsWith('psql ')) return null;
                if (settings(call)) return 'settings';
                if (call.includes('alter system set fsync = off')) return 'gate-pg-fast';
                if (call.includes('create table gate_diag')) return 'setup';
                if (call.includes('drop table if exists gate_diag')) return 'drop';
                return null;
            })
            .filter((step) => step !== null);
        // The four concurrent sessions log in any order.
        const order = steps.map((step, i) => (step.startsWith('write_c4_') ? `c4:${i}` : step));
        const c4 = steps.filter((step) => step.startsWith('write_c4_'));
        const set = ['setup', 'write_c1 1-8 8', 'read_c1 1-8 8', ...['c4', 'c4', 'c4', 'c4'], 'drop'];
        expect(order.map((step) => (step.startsWith('c4:') ? 'c4' : step))).toEqual([
            'settings',
            ...set,
            'gate-pg-fast',
            'settings',
            ...set,
        ]);
        // Each session inserts its own quarter of fresh ids, after the single session's.
        const quarters = ['write_c4_0 9-10 2', 'write_c4_1 11-12 2', 'write_c4_2 13-14 2', 'write_c4_3 15-16 2'];
        expect([...c4].sort()).toEqual([...quarters, ...quarters].sort());
        expect(run.value('pg_settings_durable')).toBe('fsync=on synchronous_commit=on full_page_writes=on');
        expect(run.value('pg_settings_fast')).toBe('fsync=off synchronous_commit=off full_page_writes=off');
        for (const key of [...TPS('durable'), ...TPS('fast')]) expect(run.value(key), key).toMatch(NUMBER);
        expect(pg.length).toBeGreaterThan(0);
        for (const call of pg) {
            expect(call, call).toContain(' PGCONNECT_TIMEOUT=10 ');
            expect(call, call).toContain(' PGOPTIONS= ');
        }
    });

    it('a fast set whose settings did not change is unmeasured', async () => {
        const run = await runPass({ env: { FAKE_PSQL_STUCK: '1' } });
        expect(run.status).toBe(1);
        expect(run.value('pg_settings_fast')).toBe('fsync=on synchronous_commit=on full_page_writes=on');
        for (const key of TPS('fast')) expect(run.value(key), key).toBe('unmeasured');
        for (const key of TPS('durable')) expect(run.value(key), key).toMatch(NUMBER);
    });

    it("reads the service's own mounts through the server", async () => {
        const run = await runPass();
        expect(
            run.calls.some((call) => call.startsWith('psql') && call.includes("pg_read_file('/proc/self/mountinfo')"))
        ).toBe(true);
        expect(run.values('pg_mounts')).toEqual([
            '61 1 0:40 / / rw - virtiofs none rw',
            '62 61 0:41 / /dev/shm rw - tmpfs shm rw',
        ]);
    });

    it('without a url the postgres measures are unmeasured, not zero', async () => {
        const run = await runPass({ url: false });
        expect(run.status).toBe(0);
        for (const key of PG) expect(run.value(key), key).toBe('unmeasured');
        expect(run.calls.filter((call) => call.startsWith('psql'))).toEqual([]);
    });

    it.each(['write_c1', 'read_c1', 'write_c4_2'])(
        'a failing %s session is unmeasured and fails the pass',
        async (name) => {
            const run = await runPass({ env: { FAKE_PSQL_FAIL: name } });
            expect(run.status).toBe(1);
            const failed = name.replace(/_\d$/, '');
            for (const set of ['durable', 'fast']) {
                for (const workload of WORKLOADS) {
                    const key = `pg_${set}_${workload}_tps`;
                    expect(run.value(key), key).toMatch(workload === failed ? /^unmeasured$/ : NUMBER);
                }
            }
            // The later measures still print.
            expect(run.value('pg_settings_fast')).toBe('fsync=off synchronous_commit=off full_page_writes=off');
        }
    );

    it('a table that cannot be created leaves its set unmeasured', async () => {
        const run = await runPass({ env: { FAKE_PSQL_FAIL: 'create' } });
        expect(run.status).toBe(1);
        for (const key of [...TPS('durable'), ...TPS('fast')]) expect(run.value(key), key).toBe('unmeasured');
        expect(run.calls.filter((call) => call.startsWith('psql-file '))).toEqual([]);
        expect(run.stderr).toContain('could not create the gate_diag table');
    });

    it('an unreachable server is unmeasured', async () => {
        const run = await runPass({ env: { FAKE_PSQL_STATUS: '2' } });
        expect(run.status).toBe(1);
        for (const key of ['pg_version', 'pg_data_directory', 'pg_mounts', 'pg_settings_durable', 'pg_settings_fast']) {
            expect(run.value(key), key).toBe('unmeasured');
        }
    });

    it('no node_modules: file and require measures are unmeasured', async () => {
        const run = await runPass({ nodeModules: false });
        expect(run.status).toBe(1);
        for (const key of ['files_count', 'files_seconds', 'require_typescript_seconds']) {
            expect(run.value(key), key).toBe('unmeasured');
        }
        expect(run.stderr).toContain('no node_modules');
    });

    it('a missing nproc is unmeasured', async () => {
        const run = await runPass({ env: { FAKE_NO_NPROC: '1' } });
        expect(run.status).toBe(1);
        expect(run.value('nproc')).toBe('unmeasured');
    });

    it("parses vitest's summary into its phases", async () => {
        const run = await runPass({ env: { FAKE_NPX_STATUS: '1' } });
        expect(run.value('vitest_transform')).toBe('2.33s');
        expect(run.value('vitest_setup')).toBe('0ms');
        expect(run.value('vitest_collect')).toBe('3.70s');
        expect(run.value('vitest_tests')).toBe('5.00s');
        expect(run.value('vitest_environment')).toBe('1.83s');
        expect(run.value('vitest_prepare')).toBe('131ms');
        expect(run.value('vitest_seconds')).toMatch(NUMBER);
        // A failing suite still reports its timings, and its exit status on a line of its own.
        expect(run.value('vitest_exit')).toBe('1');
        const build = run.calls.indexOf('npm run build -w core');
        const vitest = run.calls.findIndex((call) => call.startsWith('npx '));
        expect(build).toBeGreaterThanOrEqual(0);
        expect(vitest).toBeGreaterThan(build);
        expect(run.calls[vitest]).toMatch(/ vitest run --project dom web\/test\/[\w-]+\.dom\.test\.tsx$/);
        expect(run.status).toBe(0);
    });

    it('a vitest summary that never prints is unmeasured', async () => {
        const run = await runPass({ env: { FAKE_NPX_SILENT: '1' } });
        for (const key of PHASES) expect(run.value(key), key).toBe('unmeasured');
        expect(run.value('vitest_exit')).toBe('1');
        expect(run.status).toBe(1);
    });

    it('GATE_DIAG_TMP_COPY repeats files, require and vitest on the copy', async () => {
        const copy = join(mkdtempSync(join(tmpdir(), 'gate-diag-copy-')), 'work');
        dirs.push(dirname(copy));
        const run = await runPass({ env: { GATE_DIAG_TMP_COPY: copy } });
        expect(run.status).toBe(0);
        expect(run.value('copy_seconds')).toMatch(NUMBER);
        expect(run.value('files_count_tmp')).toBe(run.value('files_count'));
        expect(run.value('require_typescript_seconds_tmp')).toMatch(NUMBER);
        expect(run.value('vitest_transform_tmp')).toBe('2.33s');
        const npx = run.calls.filter((call) => call.startsWith('npx '));
        expect(npx).toHaveLength(2);
        expect(npx[1]).toContain(`cwd=${copy} `);
    });

    it('an unwritable copy dir leaves the copy measures unmeasured', async () => {
        const run = await runPass({ env: { GATE_DIAG_TMP_COPY: '/dev/null/work' } });
        expect(run.status).toBe(1);
        expect(run.value('copy_seconds')).toBe('unmeasured');
        for (const key of ['files_count', 'files_seconds', 'require_typescript_seconds', ...PHASES]) {
            expect(run.value(`${key}_tmp`), key).toBe('unmeasured');
        }
        expect(run.value('files_count')).toBe('3');
    });
});

// --- the launcher ------------------------------------------------------------------------------------

const LAUNCHER = join(SCRIPTS, 'gate-diag-pod.sh');
const ARGS = [
    '--context',
    'ctx-a',
    '--namespace',
    'ns-a',
    '--node-pool',
    'pool-a',
    '--storage-class',
    'sc-a',
    '--repo',
    'https://example.com/repo.git',
    '--ref',
    'abc123',
    '--gate-cpu',
    '2',
    '--gate-mem',
    '4Gi',
    '--service-cpu',
    '1',
    '--service-mem',
    '1Gi',
    '--pad-cpu',
    '500m',
    '--pad-mem',
    '512Mi',
];

interface Launch {
    status: number | null;
    stdout: string;
    stderr: string;
    calls: string[];
    root: string;
}

// A fake kubectl scripted by env: FAKE_NS (absent | foreign | error) answers the namespace read until
// the launcher creates it, FAKE_POD is the space-separated sequence of pod reads (pending, running,
// exit:<n>; the last repeats), FAKE_REJECT refuses the apply.
function kubectl(): { root: string; bin: string; log: string } {
    const fx = fixture('gate-diag-pod-');
    tool(
        fx.bin,
        'kubectl',
        `printf 'kubectl %s\\n' "$*" >> "${fx.log}"
case "$*" in
*' get namespace '*)
    if [ -f "${fx.root}/ns" ]; then printf gate-diag; exit 0; fi
    case \${FAKE_NS:-absent} in
    absent) echo 'Error from server (NotFound): namespaces "ns-a" not found' >&2; exit 1 ;;
    foreign) printf someone-else ;;
    error) echo 'Unable to connect to the server: dial tcp: i/o timeout' >&2; exit 1 ;;
    esac ;;
*' create -f -'*) cat > "${fx.root}/namespace.yaml"; : > "${fx.root}/ns" ;;
*' apply -f -'*)
    cat > "${fx.root}/manifest.yaml"
    [ -z "\${FAKE_REJECT:-}" ] || { echo 'Error from server (Forbidden): pods "gate-diag" is forbidden: violates PodSecurity' >&2; exit 1; } ;;
*' get pod '*)
    n=$(cat "${fx.root}/reads" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${fx.root}/reads"
    set -- \${FAKE_POD:-pending}
    i=1
    while [ "$i" -lt "$n" ] && [ $# -gt 1 ]; do shift; i=$((i + 1)); done
    case $1 in
    pending) printf 'gate-diag||' ;;
    running) printf 'gate-diag|2026-01-01T00:00:00Z|' ;;
    exit:*) printf 'gate-diag||%s' "\${1#exit:}" ;;
    esac ;;
*' logs -f '*) echo 'stream line' ;;
*' logs '*) printf 'nproc\\t4\\nfiles_count\\t10\\n' ;;
*' get events '*) echo 'Warning FailedScheduling 0/3 nodes are available' ;;
# --wait=false: the namespace stays readable, owner label and all, while it terminates.
*' delete namespace '*) ;;
esac`
    );
    return fx;
}

async function launch(args: string[], extra: Record<string, string> = {}): Promise<Launch> {
    const { root, bin, log } = kubectl();
    const run = await exec([LAUNCHER, ...args], { env: env(bin, extra) });
    const calls = existsSync(log) ? lines(readFileSync(log, 'utf8')) : [];
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls, root };
}

const deletes = (calls: string[]) => calls.filter((call) => call.includes(' delete namespace '));

describe('scripts/gate-diag-pod.sh', () => {
    it.each([
        ['--context', 'ctx-a'],
        ['--namespace', 'ns-a'],
    ])('refuses without %s', async (flag) => {
        const args = [...ARGS, '--mode', 'microvm'];
        const at = args.indexOf(flag);
        args.splice(at, 2);
        const run = await launch(args);
        expect(run.status).toBe(2);
        expect(run.calls).toEqual([]);
    });

    it('every call names the context and the given namespace', async () => {
        const run = await launch([...ARGS, '--mode', 'microvm'], { FAKE_POD: 'running exit:0' });
        expect(run.status).toBe(0);
        expect(run.calls.length).toBeGreaterThan(5);
        for (const call of run.calls) {
            expect(call, call).toMatch(/^kubectl --context ctx-a --namespace ns-a --request-timeout=\d+s /);
        }
    });

    it.each(['microvm', 'plain'])('renders the gate-faithful manifest (%s)', async (mode) => {
        const run = await launch([...ARGS, '--mode', mode], { FAKE_POD: 'exit:0' });
        expect(run.stderr).not.toContain('rejected');
        expect(run.status).toBe(0);
        const [pvc, pod] = parseAllDocuments(readFileSync(join(run.root, 'manifest.yaml'), 'utf8')).map((doc) =>
            doc.toJS()
        );
        expect(pvc.kind).toBe('PersistentVolumeClaim');
        expect(pvc.spec.storageClassName).toBe('sc-a');
        expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce']);
        const spec = pod.spec;
        expect(spec.securityContext).toEqual({ fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' });
        expect(spec.nodeSelector).toEqual({ 'cloud.google.com/gke-nodepool': 'pool-a' });
        expect(spec.tolerations).toEqual([
            { key: 'sandbox.gke.io/runtime', operator: 'Equal', value: 'microvm', effect: 'NoSchedule' },
        ]);
        expect(spec.runtimeClassName).toBe(mode === 'microvm' ? 'microvm' : undefined);
        expect(spec.activeDeadlineSeconds).toBe(3600);
        const volumes = Object.fromEntries(spec.volumes.map((v: { name: string }) => [v.name, v]));
        expect(volumes.task.persistentVolumeClaim.claimName).toBe(pvc.metadata.name);
        expect(volumes['diag-tmp'].emptyDir).toEqual({ medium: 'Memory' });
        expect(volumes.scripts.configMap.name).toBe('gate-diag-scripts');
        const configMap = run.calls.find((call) => call.includes(' create configmap gate-diag-scripts '));
        expect(configMap).toContain(`--from-file=gate-diag.sh=${join(SCRIPTS, 'gate-diag.sh')}`);
        expect(configMap).toContain(`--from-file=gate-pg-fast.sh=${join(SCRIPTS, 'gate-pg-fast.sh')}`);

        const [postgres] = spec.initContainers;
        expect(spec.initContainers).toHaveLength(1);
        expect(postgres.image).toBe('postgres:17');
        expect(postgres.restartPolicy).toBe('Always');
        expect(postgres.securityContext.runAsUser).toBe(999);
        expect(postgres.volumeMounts).toBeUndefined();
        // Requests are the real pod's, never defaulted to the limits: limits summed past one node's
        // allocatable would leave the pod unschedulable, while the guest is sized from the limits.
        expect(postgres.resources).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '1', memory: '1Gi' },
        });

        const containers = Object.fromEntries(spec.containers.map((c: { name: string }) => [c.name, c]));
        expect(Object.keys(containers).sort()).toEqual(['diag', 'pad']);
        const bellows = readFileSync(join(SCRIPTS, '..', '.bellows.yaml'), 'utf8');
        for (const name of ['diag', 'pad']) {
            expect(bellows).toContain(`image: ${containers[name].image}`);
            expect(containers[name].securityContext).toEqual({ runAsUser: 1000, runAsGroup: 1000 });
        }
        expect(containers.pad.resources).toEqual({
            requests: { cpu: '10m', memory: '16Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
        });
        expect(containers.diag.resources).toEqual({
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '2', memory: '4Gi' },
        });
        const mounts = Object.fromEntries(
            containers.diag.volumeMounts.map((m: { name: string; mountPath: string }) => [m.mountPath, m.name])
        );
        expect(mounts).toEqual({ '/task': 'task', '/diag-tmp': 'diag-tmp', '/diag': 'scripts' });
        expect(containers.diag.args[0]).toContain(
            'GATE_DIAG_TMP_COPY=/diag-tmp/work sh /diag/gate-diag.sh postgres://factory:factory@127.0.0.1:5432/postgres'
        );
        expect(containers.diag.args[0]).toContain('npm_ci_seconds');

        // 2 + 1 + 0.5 cpu, 4Gi + 1Gi + 512Mi.
        expect(run.stdout).toContain('pod_limits_cpu\t3500m\n');
        expect(run.stdout).toContain('pod_limits_mem\t5632Mi\n');
        expect(run.stdout).toContain('nproc\t4\n');
        expect(run.stdout).toContain('diag_exit\t0\n');
        const ns = readFileSync(join(run.root, 'namespace.yaml'), 'utf8');
        expect(ns).toContain('app.kubernetes.io/managed-by: gate-diag');
        expect(deletes(run.calls)).toHaveLength(1);
    });

    it('refuses a namespace it does not own', async () => {
        const run = await launch([...ARGS, '--mode', 'microvm'], { FAKE_NS: 'foreign' });
        expect(run.status).toBe(2);
        expect(run.calls.filter((call) => / (create|apply|delete) /.test(call))).toEqual([]);
    });

    it('a namespace read that errors is not absence', async () => {
        const run = await launch([...ARGS, '--mode', 'microvm'], { FAKE_NS: 'error' });
        expect(run.status).toBe(2);
        expect(run.calls.filter((call) => / (create|apply|delete) /.test(call))).toEqual([]);
        expect(run.stderr).toContain('Unable to connect');
    });

    it('never started: Pending until the deadline', async () => {
        const run = await launch([...ARGS, '--mode', 'microvm', '--deadline', '6'], { FAKE_POD: 'pending' });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain('FailedScheduling');
        expect(run.stdout).not.toContain('diag_exit');
        expect(deletes(run.calls)).toHaveLength(1);
    });

    it('a rejected pod is exit 3', async () => {
        const run = await launch([...ARGS, '--mode', 'plain'], { FAKE_REJECT: '1' });
        expect(run.status).toBe(3);
        expect(run.stderr).toContain('violates PodSecurity');
        expect(run.stdout).not.toContain('pod_limits_cpu');
        expect(deletes(run.calls)).toHaveLength(1);
    });

    it('a dropped log stream re-reads the pod', async () => {
        const run = await launch([...ARGS, '--mode', 'microvm'], { FAKE_POD: 'running exit:1' });
        expect(run.status).toBe(1);
        const stream = run.calls.findIndex((call) => call.includes(' logs -f '));
        expect(stream).toBeGreaterThan(0);
        expect(run.calls.slice(stream + 1).some((call) => call.includes(' get pod '))).toBe(true);
        expect(run.stdout).toContain('diag_exit\t1\n');
        expect(deletes(run.calls)).toHaveLength(1);
    });

    it('SIGTERM cleans up once', async () => {
        const { bin, log } = kubectl();
        const child = spawn('sh', [LAUNCHER, ...ARGS, '--mode', 'microvm'], {
            env: env(bin, { FAKE_POD: 'pending' }),
            stdio: 'ignore',
        });
        const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
        const until = Date.now() + 15_000;
        while (!(existsSync(log) && readFileSync(log, 'utf8').includes(' get pod ')) && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        child.kill('SIGTERM');
        const code = await exited;
        expect(code).toBe(143);
        expect(deletes(lines(readFileSync(log, 'utf8')))).toHaveLength(1);
    });
});
