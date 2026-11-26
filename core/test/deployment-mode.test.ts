import { describe, expect, it } from 'vitest';
import {
    CLAUDE_CODE_OAUTH_TOKEN,
    CLOUD_CREDENTIAL_MESSAGE,
    credentialRedirectMessage,
    DEPLOYMENT_MODES,
    forbiddenCredentialIn,
    isCredentialKey,
    isCredentialRedirectMessage,
    platformCredentialBlanks,
    redirectsPlatformCredential,
} from '../src/deployment-mode.js';

const VALUE = 'sk-ant-oat01-secret-value';

describe('forbiddenCredentialIn', () => {
    it('finds the OAuth token as an env name', () => {
        expect(forbiddenCredentialIn({ [CLAUDE_CODE_OAUTH_TOKEN]: VALUE })).toBe(CLAUDE_CODE_OAUTH_TOKEN);
    });

    it('finds it as a key at any depth of the executor JSON, arrays included', () => {
        expect(forbiddenCredentialIn(undefined, { env: { [CLAUDE_CODE_OAUTH_TOKEN]: VALUE } })).toBe(
            CLAUDE_CODE_OAUTH_TOKEN
        );
        expect(forbiddenCredentialIn({}, { a: [{ b: { [CLAUDE_CODE_OAUTH_TOKEN]: VALUE } }] })).toBe(
            CLAUDE_CODE_OAUTH_TOKEN
        );
    });

    it('passes an API key and a config without the token', () => {
        expect(forbiddenCredentialIn({ ANTHROPIC_API_KEY: VALUE }, { env: { ANTHROPIC_API_KEY: VALUE } })).toBeNull();
        expect(forbiddenCredentialIn(undefined, undefined)).toBeNull();
        // A value naming the token is not the token: only a name carries it.
        expect(forbiddenCredentialIn({ NOTE: CLAUDE_CODE_OAUTH_TOKEN }, { note: CLAUDE_CODE_OAUTH_TOKEN })).toBeNull();
    });

    it('names the API key alternative and never a value', () => {
        expect(DEPLOYMENT_MODES).toEqual(['self-hosted', 'cloud']);
        expect(CLOUD_CREDENTIAL_MESSAGE).toContain('ANTHROPIC_API_KEY');
        expect(CLOUD_CREDENTIAL_MESSAGE).not.toContain(VALUE);
    });
});

describe('isCredentialKey', () => {
    it('matches provider keys and tokens in env and JSON spelling', () => {
        for (const key of [
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'apiKey',
            'ANTHROPIC_AUTH_TOKEN',
            CLAUDE_CODE_OAUTH_TOKEN,
        ]) {
            expect(isCredentialKey(key)).toBe(true);
        }
        expect(isCredentialKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    });

    it('leaves settings that only look near one alone', () => {
        for (const key of ['model', 'baseURL', 'ANTHROPIC_BASE_URL', 'apiKeyHelper', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) {
            expect(isCredentialKey(key)).toBe(false);
        }
    });
});

describe('redirectsPlatformCredential', () => {
    const URL = 'https://collector.example.test';

    it('refuses a base URL with no member key, from member env or from the claude-code config env', () => {
        expect(redirectsPlatformCredential({ ANTHROPIC_BASE_URL: URL })).toBe('ANTHROPIC_BASE_URL');
        expect(redirectsPlatformCredential({}, { env: { ANTHROPIC_BASE_URL: URL } }, 'claude-code')).toBe(
            'ANTHROPIC_BASE_URL'
        );
        expect(redirectsPlatformCredential({ OPENAI_BASE_URL: URL })).toBe('OPENAI_BASE_URL');
    });

    it('refuses an opencode provider baseURL whose apiKey is absent or reads the runner env or a file', () => {
        const provider = (options: Record<string, unknown>) => ({ provider: { anthropic: { options } } });
        expect(redirectsPlatformCredential({}, provider({ baseURL: URL }), 'opencode')).toBe('baseURL');
        expect(redirectsPlatformCredential({}, provider({ baseURL: URL, apiKey: '{file:/run/key}' }), 'opencode')).toBe(
            'baseURL'
        );
        expect(redirectsPlatformCredential({}, provider({ baseURL: URL, apiKey: VALUE }), 'opencode')).toBeNull();
    });

    it('accepts a provider key that is exactly the {env:NAME} reference the board resolves at claim ', () => {
        const provider = (options: Record<string, unknown>) => ({ provider: { anthropic: { options } } });
        expect(
            redirectsPlatformCredential({}, provider({ baseURL: URL, apiKey: '{env:GATEWAY_KEY}' }), 'opencode')
        ).toBeNull();
        // A reference beside other text, or naming nothing at all, is not the one form the board resolves.
        expect(
            redirectsPlatformCredential({}, provider({ baseURL: URL, apiKey: 'Bearer {env:KEY}' }), 'opencode')
        ).toBe('baseURL');
        expect(redirectsPlatformCredential({}, provider({ baseURL: URL, apiKey: '{env:}' }), 'opencode')).toBe(
            'baseURL'
        );
    });

    it('passes a redirect that carries the member key anywhere in the effective env', () => {
        expect(redirectsPlatformCredential({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: VALUE })).toBeNull();
        expect(
            redirectsPlatformCredential(
                { ANTHROPIC_BASE_URL: URL },
                { env: { ANTHROPIC_API_KEY: VALUE } },
                'claude-code'
            )
        ).toBeNull();
        expect(
            redirectsPlatformCredential(
                { ANTHROPIC_API_KEY: VALUE },
                { env: { ANTHROPIC_BASE_URL: URL } },
                'claude-code'
            )
        ).toBeNull();
    });

    it('passes an Anthropic redirect answered by a member ANTHROPIC_AUTH_TOKEN, never by an empty one', () => {
        expect(redirectsPlatformCredential({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_AUTH_TOKEN: VALUE })).toBeNull();
        expect(
            redirectsPlatformCredential(
                { ANTHROPIC_BASE_URL: URL },
                { env: { ANTHROPIC_AUTH_TOKEN: VALUE } },
                'claude-code'
            )
        ).toBeNull();
        expect(redirectsPlatformCredential({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_AUTH_TOKEN: '' })).toBe(
            'ANTHROPIC_BASE_URL'
        );
        expect(redirectsPlatformCredential({ OPENAI_BASE_URL: URL, ANTHROPIC_AUTH_TOKEN: VALUE })).toBe(
            'OPENAI_BASE_URL'
        );
        const message = credentialRedirectMessage('ANTHROPIC_BASE_URL');
        expect(message).toContain('ANTHROPIC_API_KEY');
        expect(message).toContain('ANTHROPIC_AUTH_TOKEN');
    });

    it('applies the config last: an empty config key does not count as the member key', () => {
        expect(
            redirectsPlatformCredential(
                { ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: VALUE },
                { env: { ANTHROPIC_API_KEY: '' } },
                'claude-code'
            )
        ).toBe('ANTHROPIC_BASE_URL');
    });

    it('reads an opencode config env as no env at all', () => {
        expect(
            redirectsPlatformCredential({ ANTHROPIC_BASE_URL: URL }, { env: { ANTHROPIC_API_KEY: VALUE } }, 'opencode')
        ).toBe('ANTHROPIC_BASE_URL');
    });

    it('passes no redirect, and names the key and the member key in its message, never a value', () => {
        expect(
            redirectsPlatformCredential({ ANTHROPIC_API_KEY: VALUE }, { model: 'sonnet' }, 'claude-code')
        ).toBeNull();
        expect(redirectsPlatformCredential(undefined, undefined)).toBeNull();
        const message = credentialRedirectMessage('ANTHROPIC_BASE_URL');
        expect(message).toContain('ANTHROPIC_BASE_URL');
        expect(message).toContain('ANTHROPIC_API_KEY');
        expect(isCredentialRedirectMessage(message)).toBe(true);
        expect(isCredentialRedirectMessage(CLOUD_CREDENTIAL_MESSAGE)).toBe(false);
    });
});

describe('platformCredentialBlanks', () => {
    const URL = 'https://gateway.example.test';

    it('blanks the platform key beside a member redirect that carries no member key of that name', () => {
        expect(platformCredentialBlanks({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_AUTH_TOKEN: VALUE })).toEqual({
            ANTHROPIC_API_KEY: '',
        });
        expect(platformCredentialBlanks({ ANTHROPIC_BASE_URL: URL })).toEqual({ ANTHROPIC_API_KEY: '' });
        expect(platformCredentialBlanks({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: '' })).toEqual({
            ANTHROPIC_API_KEY: '',
        });
        expect(platformCredentialBlanks({ OPENAI_BASE_URL: URL })).toEqual({ OPENAI_API_KEY: '' });
    });

    it('blanks nothing when the member key is there or nothing redirects', () => {
        expect(platformCredentialBlanks({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: VALUE })).toEqual({});
        expect(platformCredentialBlanks({ OPENAI_BASE_URL: URL, OPENAI_API_KEY: VALUE })).toEqual({});
        expect(platformCredentialBlanks({ ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: VALUE })).toEqual({});
        expect(platformCredentialBlanks({})).toEqual({});
    });
});
