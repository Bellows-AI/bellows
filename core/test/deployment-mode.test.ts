import { describe, expect, it } from 'vitest';
import {
    CLAUDE_CODE_OAUTH_TOKEN,
    CLOUD_CREDENTIAL_MESSAGE,
    DEPLOYMENT_MODES,
    forbiddenCredentialIn,
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
