import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * The forges the board knows (docs/connections.md): a forge registers here once, and the gate, the claim's hold and the
 * refusal text all read it. `github` now; `gitlab:<host>` registers its own entry with its provider.
 */
interface ForgeEntry {
    /** What a member reads in a refusal. */
    label: string;
    /** The sign-in that replaces the grant, relative to the board's public origin. */
    signInPath: string;
}

const FORGES = new Map<string, ForgeEntry>([[GITHUB_FORGE, { label: 'GitHub', signInPath: '/api/auth/github' }]]);

export const forgeLabel = (forge: string): string => FORGES.get(forge)?.label ?? forge;

export const forgeSignInPath = (forge: string): string | null => FORGES.get(forge)?.signInPath ?? null;

/** The forge a repo lives on; null for a task with no repo, which needs no grant. Every repo is GitHub's for now. */
export const forgeOfRepo = (repo: string | null): string | null => (repo === null ? null : GITHUB_FORGE);
