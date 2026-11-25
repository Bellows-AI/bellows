import { defineIntegration } from './definition.js';

/**
 * The GitLab adapter (docs/connections.md): a self-hosted instance an organization connects, each member linking their
 * own account through the instance's OAuth application. Pure data: the host is the connection's resource, never an
 * input, and the OAuth hooks live in the server (`providers/gitlab.ts`).
 */
export const GITLAB_FORGE = 'gitlab';

/** What a member's link asks for: the whole API, as the member. */
export const GITLAB_OAUTH_SCOPE = 'api';
export const GITLAB_SCOPES = [GITLAB_OAUTH_SCOPE] as const;

const PATH_PREFIX = '/api/v4';
const FORGE_PREFIX = `${GITLAB_FORGE}:`;

/** The grant's `provider` for one instance: a member's grant is keyed by member and `gitlab:<host>`. */
export const gitlabForgeOf = (host: string): string => `${FORGE_PREFIX}${host.toLowerCase()}`;

/** The host a `gitlab:<host>` forge names, or null when it is not one. */
export const gitlabHostOf = (forge: string): string | null => {
    const host = forge.startsWith(FORGE_PREFIX) ? forge.slice(FORGE_PREFIX.length) : '';
    return host === '' ? null : host;
};

export const gitlabIntegration = defineIntegration({
    id: GITLAB_FORGE,
    kind: 'connection',
    capabilities: { api: GITLAB_SCOPES },
    api: { origin: (resource) => `https://${resource.id}`, pathPrefix: PATH_PREFIX },
    skills: [],
});
