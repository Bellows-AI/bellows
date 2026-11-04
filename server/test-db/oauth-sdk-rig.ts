import { createServer } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';

export const LOCALHOST = '127.0.0.1';
export const CALLBACK_PORT = 54321;

export const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

/** A public client that keeps its state in memory and hands the authorization URL to the test, which plays the browser. */
export class MemoryProvider implements OAuthClientProvider {
    authorizationUrl: URL | undefined;
    private saved: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
    private verifier = '';
    private client: { client_id: string } | undefined;
    /** With no client id the SDK registers the client itself (RFC 7591) and hands the answer to saveClientInformation. */
    constructor(clientId?: string) {
        this.client = clientId ? { client_id: clientId } : undefined;
    }
    get redirectUrl() {
        return `http://${LOCALHOST}:${CALLBACK_PORT}/callback`;
    }
    get clientMetadata() {
        return {
            redirect_uris: [this.redirectUrl],
            client_name: 'Flow test',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        };
    }
    clientInformation() {
        return this.client;
    }
    saveClientInformation(information: { client_id: string }) {
        this.client = information;
    }
    tokens() {
        return this.saved;
    }
    saveTokens(tokens: NonNullable<typeof this.saved>) {
        this.saved = tokens;
    }
    redirectToAuthorization(url: URL) {
        this.authorizationUrl = url;
    }
    saveCodeVerifier(verifier: string) {
        this.verifier = verifier;
    }
    codeVerifier() {
        return this.verifier;
    }
}
