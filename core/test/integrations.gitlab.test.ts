import { describe, expect, it } from 'vitest';
import { GITLAB_OAUTH_SCOPE, gitlabForgeOf, gitlabHostOf, gitlabIntegration } from '../src/index.js';

describe('the GitLab integration', () => {
    it('is a connection whose API is the resource host under /api/v4, asked with the api scope', () => {
        expect(gitlabIntegration).toMatchObject({ id: 'gitlab', kind: 'connection', capabilities: { api: ['api'] } });
        expect(gitlabIntegration.api.origin({ id: 'git.example.test', label: 'git.example.test' })).toBe(
            'https://git.example.test'
        );
        expect(gitlabIntegration.api.pathPrefix).toBe('/api/v4');
        expect(GITLAB_OAUTH_SCOPE).toBe('api');
    });

    it('keys a member grant gitlab:<host>, lowercased, and reads the host back only from such a key', () => {
        expect(gitlabForgeOf('Git.Example.test:8443')).toBe('gitlab:git.example.test:8443');
        expect(gitlabHostOf('gitlab:git.example.test:8443')).toBe('git.example.test:8443');
        expect(gitlabHostOf('github')).toBeNull();
        expect(gitlabHostOf('gitlab:')).toBeNull();
    });
});
