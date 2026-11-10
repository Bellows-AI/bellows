import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Shared support for running the review scripts against a stub `gh` (split out of
 * `review-scripts.test.ts` for the line-count cap, into `review-collect-script.test.ts` and
 * `review-reply-script.test.ts`): a fake gh (a POSIX sh stub, `review/fake-gh.sh`) in a bin dir on PATH
 * that records every argv (the spawn-shape pins), refuses to answer without a credential, and
 * dishes canned payloads from the fixtures. The ambient board credentials are stripped so the
 * only token the child can ever see is the test's own.
 *
 * `afterEach` itself is NOT registered here — it must be called from each test file's own top
 * level, so the hook binds to that file's suite even when `isolate: false` shares this module's
 * cache across files in a worker.
 */
const execFile = promisify(execFileCb);

const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'scripts');
export const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

export const TEST_TOKEN = 'token-opencode-review-secret-42';
const EXECUTABLE_MODE = 0o755;

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'review');
export const fixture = (name: string): string => join(FIXTURES_DIR, name);
const FAKE_GH = readFileSync(fixture('fake-gh.sh'), 'utf8');
const CHECK_RUNS_DEFAULT = { total_count: 0, check_runs: [] };

/**
 * The stub's bin dir, written once per process: the first exec of a freshly written file is the
 * dominant cost under load, so it is paid once, not once per run. It is not a `tempDirs` entry
 * (those go after every test); it goes with the process.
 */
let sharedBin: string | null = null;
function stubBin(): string {
    if (sharedBin !== null) return sharedBin;
    const bin = join(mkdtempSync(join(tmpdir(), 'review-bin-')), 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), EXECUTABLE_MODE);
    const root = join(bin, '..');
    process.once('exit', () => rmSync(root, { recursive: true, force: true }));
    sharedBin = bin;
    return bin;
}

/** One payload file per fixture key, the exact bytes the stub prints; a fixture predating the check-runs read answers "no check runs". */
function writePayloads(fixtureFile: string, dir: string): void {
    const fixtures = JSON.parse(readFileSync(fixtureFile, 'utf8')) as Record<string, unknown>;
    mkdirSync(dir, { recursive: true });
    for (const [key, value] of Object.entries({ checks: CHECK_RUNS_DEFAULT, ...fixtures })) {
        writeFileSync(join(dir, `${key}.json`), JSON.stringify(value));
    }
}

/** The stub logs NUL after each argument and \u0001 after each call. */
function parseArgvLog(raw: string): string[][] {
    return raw
        .split('\u0001')
        .slice(0, -1)
        .map((call) => call.split('\u0000').slice(0, -1));
}

export const tempDirs = new Set<string>();
export function cleanupTempDirs(): void {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.clear();
}

export interface ScriptRun {
    stdout: string;
    stderr: string;
    args: string[][];
}

/** Run one review script against the stub `gh`: the end-to-end spawn shape and the wire bytes a real gh round trip produces. */
export const runScript = async (
    name: string,
    env: Record<string, string>,
    opts: { token?: boolean; cwd?: string } = {}
): Promise<ScriptRun> => runNodeScript(pathOf(name), env, opts);

/**
 * Run an arbitrary script FILE (never a review script under `src/scripts/` by name) against the
 * stub `gh` — the github-review-reconcile block's composed helper bodies (issue #133,
 * `driver/src/review/review-helpers.ts`) are assembled strings, not files under `src/scripts/`, so their
 * own suite writes one to a temp file first and hands the path here.
 */
export const runSource = async (
    path: string,
    env: Record<string, string>,
    opts: { token?: boolean; cwd?: string } = {}
): Promise<ScriptRun> => runNodeScript(path, env, opts);

async function runNodeScript(
    path: string,
    env: Record<string, string>,
    opts: { token?: boolean; cwd?: string }
): Promise<ScriptRun> {
    const dir = mkdtempSync(join(tmpdir(), 'review-'));
    tempDirs.add(dir);
    const bin = stubBin();
    const argvLog = join(dir, 'argv.log');
    const childEnv: Record<string, string> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
    const token = opts.token ?? true;
    Object.assign(childEnv, { GH_FIXTURES: fixture('gh-responses.json'), GH_ARGV_LOG: argvLog });
    if (token) childEnv.GITHUB_TOKEN = TEST_TOKEN;
    Object.assign(childEnv, env);
    const responses = join(dir, 'responses');
    childEnv.GH_RESP_DIR = responses;
    writePayloads(childEnv.GH_FIXTURES ?? '', responses);
    const { stdout, stderr } = await execFile('node', [path], { env: childEnv, cwd: opts.cwd });
    const args = existsSync(argvLog) ? parseArgvLog(readFileSync(argvLog, 'utf8')) : [];
    return { stdout, stderr, args };
}

/** A disposable extra gh fixture for the boundedness runs that outgrow the canned one. */
export const writeFixture = (body: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'review-fixture-'));
    tempDirs.add(dir);
    const file = join(dir, 'responses.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
};

/** Call the stub `gh` directly with `args` (credentialed, canned fixture): its exit code and stdout, never a throw. */
export async function runStubGh(args: string[]): Promise<{ code: number; stdout: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'review-direct-'));
    tempDirs.add(dir);
    writePayloads(fixture('gh-responses.json'), join(dir, 'responses'));
    const env = { ...process.env, PATH: `${stubBin()}:${process.env.PATH}`, GITHUB_TOKEN: TEST_TOKEN };
    try {
        const { stdout } = await execFile('gh', args, { env: { ...env, GH_RESP_DIR: join(dir, 'responses') } });
        return { code: 0, stdout };
    } catch (error) {
        const failure = error as { code: number; stdout: string };
        return { code: failure.code, stdout: failure.stdout };
    }
}
