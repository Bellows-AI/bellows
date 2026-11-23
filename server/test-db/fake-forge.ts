import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../..', import.meta.url).pathname;

/** What a call to the fake forge left in its call log. */
export interface ForgeCall {
    method: string;
    path: string;
    tokenKind: string;
    tokenId: string | null;
    holder: string | null;
    status: number;
    [field: string]: unknown;
}
export interface ForgeHandle {
    listen: (port: number, host: string) => Promise<number>;
    close: () => Promise<void>;
    calls: () => ForgeCall[];
    advance: (ms: number) => void;
    mintInstallationToken: () => string;
}
const { createFakeForge, GITLAB_TOKEN_TTL_S, USER_TOKEN_TTL_S } = (await import(
    pathToFileURL(join(ROOT, 'scripts/fake-forge/server.mjs')).href
)) as {
    createFakeForge: (options: { stateDir: string; now?: () => number }) => ForgeHandle;
    GITLAB_TOKEN_TTL_S: number;
    USER_TOKEN_TTL_S: number;
};
export { GITLAB_TOKEN_TTL_S, USER_TOKEN_TTL_S };

/** The injected clock's start: fixed, so a token's expiry moves only when a test advances it. */
export const CLOCK_START_MS = 1_700_000_000_000;

export interface SendOptions {
    token?: string;
    /** How the token travels: `Authorization: Bearer` (default) or `PRIVATE-TOKEN`. */
    header?: 'bearer' | 'private';
    body?: object;
}
export interface Reply {
    status: number;
    location: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: a JSON answer the test narrows by use
    body: any;
}

/**
 * The fake forge (`scripts/fake-forge/server.mjs`) booted in-process on a free port: the request helper, the lane's
 * `/_control/*` door and the teardown every forge's helper shares. `stop()` closes it and removes its state directory.
 */
export const startFakeForge = async ({ now = () => CLOCK_START_MS }: { now?: () => number } = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-forge-'));
    const forge = createFakeForge({ stateDir, now });
    const base = `http://127.0.0.1:${await forge.listen(0, '127.0.0.1')}`;

    const send = async (method: string, path: string, options: SendOptions = {}): Promise<Reply> => {
        const { token, header = 'bearer', body } = options;
        const form = body !== undefined && 'grant_type' in body;
        const response = await fetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                ...(token
                    ? header === 'private'
                        ? { 'private-token': token }
                        : { authorization: `Bearer ${token}` }
                    : {}),
                ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
                accept: 'application/json',
            },
            ...(body
                ? { body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body) }
                : {}),
        });
        const text = await response.text();
        // a raw file answer stays text, even when the file happens to parse as JSON
        const json = (response.headers.get('content-type') ?? '').includes('json');
        const parsed: unknown = json ? JSON.parse(text) : text || null;
        return { status: response.status, location: response.headers.get('location'), body: parsed };
    };

    return {
        forge,
        stateDir,
        base,
        send,
        /** The lane's own door (`/_control/*`): no credential. */
        control: (path: string, body: object = {}) => send('POST', `/_control/${path}`, { body }),
        read: (path: string) => send('GET', `/_control/${path}`),
        stop: async () => {
            await forge.close();
            rmSync(stateDir, { recursive: true, force: true });
        },
    };
};
export type FakeForge = Awaited<ReturnType<typeof startFakeForge>>;
