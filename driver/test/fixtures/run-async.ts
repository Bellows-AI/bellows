import { type SpawnOptions, spawn } from 'node:child_process';

export interface AsyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

const live = new Set<{ kill: (signal: NodeJS.Signals) => boolean; closed: Promise<void> }>();

/**
 * Runs a real script without blocking the worker's event loop (spawnSync starves vitest's own
 * timers and RPC on a loaded host). Settles on `close` and on `error`; there is deliberately no
 * inner timeout — the test budget and `killLiveChildren` in the file's own teardown bound it.
 */
export const runAsync = (cmd: string, args: string[], opts: SpawnOptions = {}): Promise<AsyncResult> =>
    new Promise((resolve) => {
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let markClosed = (): void => undefined;
        const entry = {
            kill: (signal: NodeJS.Signals) => child.kill(signal),
            closed: new Promise<void>((r) => {
                markClosed = r;
            }),
        };
        live.add(entry);
        const settle = (status: number | null, extra = ''): void => {
            if (settled) return;
            settled = true;
            live.delete(entry);
            markClosed();
            resolve({ status, stdout, stderr: stderr + extra });
        };
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', (error) => settle(null, String(error)));
        child.on('close', (code) => settle(code));
    });

/** SIGKILLs every child still alive and waits for it to close. Call it from the test file's own afterEach. */
export const killLiveChildren = async (): Promise<void> => {
    const pending = [...live];
    for (const entry of pending) entry.kill('SIGKILL');
    await Promise.all(pending.map((entry) => entry.closed));
};
