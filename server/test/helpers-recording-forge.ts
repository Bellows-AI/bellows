import type { GitHubConfig } from '../src/config.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';

/**
 * The REAL GitHub client over a recording credential and a recording fetch: every installation-token read and every
 * request is logged, so a test can assert that a ref no client answers for reached neither (a credential read is a
 * GitHub side effect: the mint is a request, a grant read may open a wait).
 */
export function recordingForge() {
    const credentials: string[] = [];
    const requests: string[] = [];
    const tokens: InstallationTokenProvider = {
        get: async () => {
            credentials.push('installation token');
            return 'installation-token';
        },
        fresh: async () => {
            credentials.push('installation token (fresh)');
            return {
                token: 'installation-token',
                expiresAt: '2030-01-01T00:00:00Z',
                permissions: {},
                repositories: [],
            };
        },
        revoke: async () => 'revoked',
        installationId: async () => {
            credentials.push('installation id');
            return '4242';
        },
    };
    const github = {
        mode: 'app',
        appId: '1',
        apiUrl: 'https://api.github.test',
        privateKey: 'k',
    } as unknown as Extract<GitHubConfig, { mode: 'app' }>;
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof fetch;
    const forge: ForgeSource = { github: { reads: createGitHubAppClient(github, tokens, fetchFn) } };
    return { forge, credentials, requests };
}
