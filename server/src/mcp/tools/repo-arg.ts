import { formatRepoRef, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { z } from 'zod';
import { MAX_NAME_CHARS } from './paging.js';

/** How a tool spells a repository: `parseRepoRef`'s text form, the same one `list_repos` prints. */
export const REPO_FORM = 'owner/name on GitHub, forge:host/path otherwise';

/** A repository argument: the text form, refused with the expected form when it does not parse. */
export const repoText = z
    .string()
    .min(1)
    .max(MAX_NAME_CHARS)
    .refine((text) => parseRepoRef(text) !== null, `repo must be ${REPO_FORM}`);

/** The `{ forge, host, path }` a request body carries for an argument `repoText` accepted. */
export const repoBody = (text: string | undefined): RepoRef | undefined =>
    text === undefined ? undefined : (parseRepoRef(text) ?? undefined);

/** A repo the board answers as `{ forge, host, path }` (or null), read into the text form the tools print. */
export const boardRepo = z
    .object({ forge: z.enum(['github', 'gitlab']), host: z.string(), path: z.string() })
    .nullish()
    .transform((ref) => (ref ? formatRepoRef(ref) : null));
