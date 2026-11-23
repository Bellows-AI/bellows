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
}
const { createFakeForge, GITLAB_TOKEN_TTL_S } = (await import(
    pathToFileURL(join(ROOT, 'scripts/fake-forge/server.mjs')).href
)) as {
    createFakeForge: (options: { stateDir: string; now?: () => number }) => ForgeHandle;
    GITLAB_TOKEN_TTL_S: number;
};
export { GITLAB_TOKEN_TTL_S };

/** The injected clock's start: fixed, so a token's expiry moves only when a test advances it. */
const CLOCK_START_MS = 1_700_000_000_000;

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
export interface TokenPair {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
}

/**
 * The fake GitLab (`scripts/fake-forge/gitlab.mjs`) booted in-process on a free port, for the self-tests and for
 * any suite that needs a GitLab to talk to. `stop()` closes it and removes its state directory.
 */
export const startFakeGitlab = async ({ now = () => CLOCK_START_MS }: { now?: () => number } = {}) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-gitlab-'));
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

    /** The sign-in round trip: authorize → code → token pair, as `login` (the fake's default member when omitted). */
    const signIn = async (login?: string): Promise<TokenPair> => {
        const query = new URLSearchParams({ redirect_uri: 'http://board.test/cb', response_type: 'code', state: 's1' });
        if (login) query.set('login', login);
        const authorize = await send('GET', `/oauth/authorize?${query}`);
        const code = new URL(authorize.location as string).searchParams.get('code') as string;
        const exchanged = await send('POST', '/oauth/token', {
            body: { grant_type: 'authorization_code', code, redirect_uri: 'http://board.test/cb' },
        });
        return exchanged.body as TokenPair;
    };
    const refresh = (token: string) =>
        send('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: token } });

    return {
        forge,
        stateDir,
        base,
        send,
        signIn,
        refresh,
        /** The lane's own door (`/_control/*`): no credential. */
        control: (path: string, body: object = {}) => send('POST', `/_control/${path}`, { body }),
        stop: async () => {
            await forge.close();
            rmSync(stateDir, { recursive: true, force: true });
        },
    };
};
export type FakeGitlab = Awaited<ReturnType<typeof startFakeGitlab>>;
