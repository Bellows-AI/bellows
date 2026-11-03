import { describe, expect, it } from 'vitest';
import { parseClientMetadata } from '../src/oauth/client-metadata.js';
import { redirectUriMatches } from '../src/oauth/redirect-match.js';

/**
 * The clients this server meets x the redirect URIs they present. Claude Code's document lists portless loopback
 * URIs and binds a free port per run; claude.ai registers one https callback; a DCR native tool registers loopback.
 */
const CLIENTS: Record<string, { document: Record<string, unknown>; accepts: string[]; refuses: string[] }> = {
    'Claude Code (CIMD)': {
        document: {
            client_name: 'Claude Code',
            redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        },
        accepts: [
            'http://localhost:54123/callback',
            'http://127.0.0.1:8765/callback',
            'http://127.0.0.1/callback',
            'http://localhost/callback',
        ],
        refuses: [
            'http://[::1]:54123/callback',
            'http://localhost:54123/other',
            'http://127.0.0.1:54123/callback?x=1',
            'https://localhost:54123/callback',
            'http://evil.example.test:54123/callback',
            'http://localhost.evil.example.test/callback',
            'http://localhost:54123/callback#frag',
        ],
    },
    'claude.ai (CIMD, https callback)': {
        document: {
            client_name: 'Claude',
            redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
            token_endpoint_auth_method: 'none',
        },
        accepts: ['https://claude.ai/api/mcp/auth_callback'],
        refuses: [
            'https://claude.ai:8443/api/mcp/auth_callback',
            'https://claude.ai/api/mcp/auth_callback/',
            'http://claude.ai/api/mcp/auth_callback',
            'https://www.claude.ai/api/mcp/auth_callback',
        ],
    },
    'a native tool (DCR, custom scheme)': {
        document: { redirect_uris: ['com.example.tool:/oauth'] },
        accepts: ['com.example.tool:/oauth'],
        refuses: ['com.example.tool:/other', 'com.example.other:/oauth'],
    },
};

describe('client x redirect matrix', () => {
    for (const [name, { document, accepts, refuses }] of Object.entries(CLIENTS)) {
        describe(name, () => {
            const parsed = parseClientMetadata(document);
            it('is a valid public client', () => {
                expect(parsed.ok).toBe(true);
            });
            it.each(accepts)('accepts %s', (uri) => {
                expect(parsed.ok && redirectUriMatches(uri, parsed.redirectUris)).toBe(true);
            });
            it.each(refuses)('refuses %s', (uri) => {
                expect(parsed.ok && redirectUriMatches(uri, parsed.redirectUris)).toBe(false);
            });
        });
    }
});
