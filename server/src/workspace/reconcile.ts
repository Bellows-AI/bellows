import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { UUID, type Repo } from '../config.js';

/**
 * One clone, into one member's workspace at `<root>/<orgId>/<userId>/<name>`.
 *
 * This was `ensureWorkspace()`, which looped over the organization's configured repos at boot and
 * cloned them all into one shared tree. Checkouts are per member now — chosen from the dashboard,
 * cloned in the background — so the loop moved to `workspace/queue.ts` and what is left here is the
 * single-repo operation and the rules about touching a working tree.
 *
 * Those rules are unchanged, and every one of them is about the same thing: the tree may hold
 * uncommitted work belonging to a Claude Code session, and this process cannot tell.
 */

const run = promisify(execFile);

/**
 * The agent's tools run as their own uid in group 1000 (issue #814) and write a member's tree beside
 * every other writer of it, so what this process creates there is group-writable.
 */
const SHARED_UMASK = 0o002;
const SHARED_DIR_MODE = 0o775;

/** `mkdirSync(dir, { recursive: true })`, with the directory it created made group-writable. */
export function mkdirShared(dir: string): string | undefined {
    const created = mkdirSync(dir, { recursive: true });
    if (created !== undefined) chmodSync(dir, SHARED_DIR_MODE);
    return created;
}

/** The variable the credential helper below reads. Never appears on a command line. */
const TOKEN_VAR = 'GIT_WORKSPACE_TOKEN';

/**
 * `present` means a checkout was already there and was left completely alone. `lost` means the
 * claim ran out before the publish: this clone's staging is gone and nothing was written.
 */
export type CloneOutcome = 'cloned' | 'present' | 'lost';

export type GitRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

export interface CloneOptions {
    readonly root: string;
    readonly orgId: string;
    readonly userId: string;
    readonly repo: Repo;
    /** Optional: without one, only public repos clone. A missing token is a supported state. */
    readonly token?: string | undefined;
    /** Names the staging directory (`<name>~tmp-<claimToken>`), so no two holders of a row can share one. */
    readonly claimToken: string;
    /**
     * Runs `move` (the rename into place) under whatever fence the caller holds and answers whether
     * it ran. False means the claim was lost: nothing was moved.
     */
    readonly publish: (move: () => void) => Promise<boolean>;
    readonly log?: (message: string) => void;
    /** Test seam: lets the suite clone from a local bare repo over file://, with no network. */
    readonly cloneUrl?: ((repo: Repo) => string) | undefined;
    /** Test seam: lets the suite assert on argv and the child environment without running git. */
    readonly run?: GitRunner | undefined;
}

/**
 * Where one member's checkouts live.
 *
 * The segment and the repo name sit at different depths, so neither can shadow the other — the same
 * arrangement `<orgId>/<name>` had.
 */
export function workspaceDir(root: string, orgId: string, userId: string): string {
    /*
     * The uuid is asserted before it is joined into a path.
     *
     * 010_auth.sql chose a uuid for `app_user.id` partly for this: it "becomes a docker volume name
     * component and a workspace path segment sitting next to repo names, and a uuid can collide
     * with neither". Checking rather than trusting the caller is the posture `driver/src/docker.ts`
     * takes with a session id before interpolating one into a command — that package keeps its own
     * copy of the pattern because it depends on nothing, but inside the server there is one.
     */
    if (!UUID.test(userId)) {
        throw new Error(`refusing to build a workspace path from a user id that is not a uuid: ${userId}`);
    }
    return join(root, orgId, userId);
}

function httpsUrl(repo: Repo): string {
    return `https://github.com/${repo.owner}/${repo.name}.git`;
}

async function defaultRunner(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
    // git takes the umask at its fork, inside `run`; this process keeps its own.
    const umask = process.umask(SHARED_UMASK);
    let ran: Promise<unknown>;
    try {
        ran = run('git', [...args], { env });
    } finally {
        process.umask(umask);
    }
    await ran;
}

/**
 * The token reaches git through the environment, and only the helper *snippet* — which references
 * the variable — reaches argv. A token in the clone URL would be world-readable in
 * `/proc/<pid>/cmdline` and, worse, git writes the URL permanently into `.git/config`: every later
 * `git remote get-url origin` would print it, including the one `backfill/transcripts.ts` runs to
 * attribute sessions to a repo.
 *
 * The empty `credential.helper` first clears any helper inherited from the user's global config
 * (osxkeychain, store), which would otherwise answer first with a stale credential.
 */
function gitArgs(url: string, dest: string, authenticated: boolean): string[] {
    const args = ['-c', 'credential.helper='];
    if (authenticated) {
        args.push(
            '-c',
            `credential.helper=!f(){ test "$1" = get && echo username=x-access-token && echo "password=\${${TOKEN_VAR}}"; }; f`
        );
    }
    // Not --depth 1: a reused branch has to be built on in place, which needs the history
    // (docs/workspace.md).
    // `--` so a repo name that somehow reached here as "-x" is still a path.
    // `core.sharedRepository` keeps what git creates later group-writable too (SHARED_UMASK).
    return [...args, 'clone', '--config', 'core.sharedRepository=group', '--origin', 'origin', '--', url, dest];
}

export async function cloneRepo(options: CloneOptions): Promise<CloneOutcome> {
    const { root, orgId, userId, repo, token, log = () => {}, cloneUrl = httpsUrl } = options;
    const exec = options.run ?? defaultRunner;

    const userDir = workspaceDir(root, orgId, userId);
    const dest = join(userDir, repo.name);

    if (existsSync(join(dest, '.git'))) {
        log(`present ${repo.name}`);
        return 'present';
    }
    // Thrown, not counted: a non-repo directory here means the root points at the wrong tree, and
    // carrying on would scatter clones through somebody's home directory.
    if (existsSync(dest)) {
        throw new Error(`${dest} exists and is not a git checkout — refusing to clone over it`);
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Without this a private repo with no usable credential blocks on stdin forever, and the
        // clone never returns — a hang rather than a reported failure.
        GIT_TERMINAL_PROMPT: '0',
        ...(token ? { [TOKEN_VAR]: token } : {}),
    };

    // Cloned aside and renamed into place, so a process killed mid-clone leaves no partial tree at
    // `dest`. One that did would be classified as "exists, not a checkout" on the next attempt and
    // would then fail forever. The queue sweeps the leftover staging directories (`sweepStaging`).
    const staging = `${dest}~tmp-${options.claimToken}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirShared(userDir);

    log(`cloning ${repo.owner}/${repo.name}`);
    const started = Date.now();
    const raced = { present: false };
    const move = () => {
        try {
            renameSync(staging, dest);
        } catch (error) {
            // An expired holder published before this one: dest is a finished checkout, and this
            // clone's staging is garbage. Anything else is a real failure.
            const code = (error as NodeJS.ErrnoException).code;
            if ((code !== 'ENOTEMPTY' && code !== 'EEXIST') || !existsSync(join(dest, '.git'))) throw error;
            raced.present = true;
        }
    };
    try {
        await exec(gitArgs(cloneUrl(repo), staging, Boolean(token)), env);
        if (!(await options.publish(move))) {
            rmSync(staging, { recursive: true, force: true });
            log(`lease lost for ${repo.name}; the clone was not published`);
            return 'lost';
        }
        if (raced.present) {
            rmSync(staging, { recursive: true, force: true });
            log(`present ${repo.name}`);
            return 'present';
        }
        log(`cloned ${repo.name} in ${Date.now() - started}ms`);
        return 'cloned';
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        // Thrown, where the old boot-time reconcile counted a failure and carried on. It swallowed
        // this because boot had nowhere to put a message; now there is a column called `error` and
        // a page that shows it, so the caller decides.
        throw error;
    }
}
