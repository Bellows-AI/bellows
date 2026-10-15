/**
 * The `cache:` list under `environment:` in `.bellows.yaml` (issue #734): env names the driver points
 * at `<member>/.cache/<owner>/<repo>/<NAME>` in the runner and gate env (driver/src/claim.ts
 * `repoCacheEnv`).
 *
 *     environment:
 *         image: node:24
 *         cache:
 *             - NPM_CONFIG_CACHE
 */

import { ENV_NAME, ENV_NAME_LIMIT, RESERVED_ENV_NAMES } from '@factory-ai/core';
import { fail } from './bellows-grammar.js';

const MAX_CACHE_NAMES = 16;
/**
 * Names a cache path may not take: what the driver sets on runner and gate env itself, and what a
 * shell, loader or runtime reads as code to run — a path there would plant code into later runs.
 * Mirrored in driver/src/claim.ts (`CACHE_REFUSED_NAMES`), which re-asserts it.
 */
const CACHE_REFUSED_NAMES: ReadonlySet<string> = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'ENV',
    'BASH_ENV',
    'XDG_DATA_HOME',
    'NPM_CONFIG_UPDATE_NOTIFIER',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'RUBYOPT',
    'JAVA_TOOL_OPTIONS',
    ...RESERVED_ENV_NAMES,
]);
const CACHE_REFUSED_PREFIXES = [
    'RUNNER_',
    'OTEL_',
    'FACTORY_',
    'BELLOWS_',
    'CLAUDE_',
    'OPENCODE_',
    'GIT_',
    'LD_',
    'DYLD_',
];

/** The list as read so far: null until `cache:` is declared; `open` while its items are read. */
export interface CacheBlock {
    names: string[] | null;
    open: boolean;
    /** The line `cache:` opened on — the line an empty list's error names. */
    line: number;
}

export const newCacheBlock = (): CacheBlock => ({ names: null, open: false, line: 0 });

/** `cache:` under `environment:` — opens the list `readCacheItem` fills; declared once, no value. */
export function openCache(block: CacheBlock, line: number, raw: string | undefined): void {
    if (raw !== undefined && raw !== '') fail(line, 'cache takes a list, not a value');
    if (block.names !== null) fail(line, 'cache is declared twice');
    block.names = [];
    block.open = true;
    block.line = line;
}

/** One `- NAME` under `cache:`: env-shaped, not driver-owned, not repeated, at most MAX_CACHE_NAMES. */
export function readCacheItem(block: CacheBlock, line: number, trimmed: string): void {
    const cache = block.names ?? [];
    const name = trimmed.slice(2).trim();
    if (!ENV_NAME.test(name) || name.length > ENV_NAME_LIMIT) {
        fail(line, `cache name "${name}" is not an environment variable name`);
    }
    if (CACHE_REFUSED_NAMES.has(name) || CACHE_REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        fail(line, `cache name "${name}" is reserved for the driver or a runtime hook`);
    }
    if (cache.includes(name)) fail(line, `cache name "${name}" is declared twice`);
    if (cache.length >= MAX_CACHE_NAMES) fail(line, `more than ${MAX_CACHE_NAMES} cache names`);
    cache.push(name);
}

/** Leaving `cache:` — an open list with no item is a declaration of nothing, refused. */
export function closeCache(block: CacheBlock): void {
    if (!block.open) return;
    block.open = false;
    if (block.names?.length === 0) fail(block.line, 'cache lists no names');
}
