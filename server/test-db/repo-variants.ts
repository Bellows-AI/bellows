import type { RepoRef } from '@factory-ai/core';

/**
 * The repositories a ref-keyed path must tell apart from `github.com` (the subject): one differing in the forge and
 * host both, one in the host alone, one in the forge alone. A predicate that drops the forge or the host still
 * separates the first, so only the other two show that each is used.
 */
export interface RepoVariant {
    name: string;
    forge: RepoRef['forge'];
    host: string;
}

export const REPO_VARIANTS: readonly RepoVariant[] = [
    { name: 'another forge on another host', forge: 'gitlab', host: 'gl.example' },
    { name: 'the same forge on another host', forge: 'github', host: 'ghe.example' },
    { name: 'another forge on the same host', forge: 'gitlab', host: 'github.com' },
];

/** The same as a plain array, for `it.each` / `describe.each`. */
export const VARIANT_CASES = REPO_VARIANTS.map((variant) => [variant.name, variant] as const);

export const refOf = (variant: RepoVariant, path: string): RepoRef => ({
    forge: variant.forge,
    host: variant.host,
    path,
});
