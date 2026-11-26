import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueTask } from '../src/api/taskWrites.js';

/** The forge gate's two refusals, as the composer words them: a grant to make, and an account that may not work here. */

const refuse = (body: Record<string, unknown>) =>
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } })
            )
        )
    );

const START = { command: 'x', repo: null, workflow: null, workflowParams: null };

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('a start the forge gate refused', () => {
    it('names a missing GitHub grant and links the sign-in', async () => {
        refuse({
            code: 'FORGE_GRANT_REQUIRED',
            forge: 'github',
            standing: 'broken',
            connectUrl: 'https://board.example.test/api/auth/github',
        });
        expect(await queueTask(START)).toEqual({
            id: null,
            error: 'Your GitHub connection needs reconnecting. Connect it to start work on this repository.',
            connect: { url: 'https://board.example.test/api/auth/github', label: 'GitHub' },
        });
    });

    it('names the GitLab host for a missing GitLab grant and links the settings page', async () => {
        refuse({
            code: 'FORGE_GRANT_REQUIRED',
            forge: 'gitlab:gitlab.example.test',
            standing: 'missing',
            connectUrl: 'https://board.example.test/settings/integrations/gitlab?org=o',
        });
        const result = await queueTask(START);
        expect(result.error).toBe(
            'Your GitLab (gitlab.example.test) connection is missing. Connect it to start work on this repository.'
        );
        expect(result.connect).toEqual({
            url: 'https://board.example.test/settings/integrations/gitlab?org=o',
            label: 'GitLab (gitlab.example.test)',
        });
    });

    it('words a denial as missing Developer access, with a link to the GitLab settings page', async () => {
        refuse({
            code: 'FORGE_ACCESS_DENIED',
            forge: 'gitlab:gitlab.example.test',
            standing: 'no-access',
            repo: 'gitlab:gitlab.example.test/acme/api',
            connectUrl: 'https://board.example.test/settings/integrations/gitlab?org=o',
        });
        const result = await queueTask(START);
        expect(result.id).toBeNull();
        expect(result.error).toBe(
            'Your GitLab (gitlab.example.test) account does not have Developer access to acme/api. Ask for access, or link a different account in GitLab settings.'
        );
        expect(result.connect).toEqual({
            url: 'https://board.example.test/settings/integrations/gitlab?org=o',
            label: 'GitLab (gitlab.example.test)',
            text: 'Open GitLab settings',
        });
    });

    it('leaves any other refusal to the generic sentence', async () => {
        refuse({ code: 'SOMETHING_ELSE', error: 'nope' });
        expect(await queueTask(START)).toEqual({ id: null, error: 'nope', connect: null });
    });
});
