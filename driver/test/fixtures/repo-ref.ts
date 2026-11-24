import type { RepoRef } from '../../src/repo-ref.js';

/** The claim's repo ref for an owner/name path on github.com. */
export const githubRef = (path: string): RepoRef => ({ forge: 'github', host: 'github.com', path });
