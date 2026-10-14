/**
 * The CLI's configuration: the environment over a JSON settings file over the built-in defaults.
 *
 * No shared config with the server. Four variables — `FACTORY_URL` for the board's base URL,
 * `FACTORY_TOKEN` for a personal access token minted from the settings page (docs/auth.md), and
 * the transport bounds `FACTORY_REQUEST_TIMEOUT_S` and `FACTORY_READ_RETRIES` — each with one key
 * in the settings file (`~/.bellows/settings.json`, or `--config <path>`). A set variable wins over
 * its key; a blank one is unset. Against an `AUTH_MODE=none` board the token is simply unset.
 *
 * Unlike the driver, there is no default board URL: a CLI types at a specific deployment, and
 * guessing `127.0.0.1:8080` would queue real tasks against whichever board happens to be running
 * there. A url in neither place is a named refusal, not a fallback.
 */

import { readFileSync, statSync } from 'node:fs';
import { DEFAULT_READ_RETRIES, DEFAULT_REQUEST_TIMEOUT_MS } from './transport.js';

/** A configuration problem — a value is missing, blank or unusable, or the settings file is. */
export class CliConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliConfigError';
    }
}

export interface CliConfig {
    /** The board's base URL, trailing slashes stripped — request paths are appended to it. */
    url: string;
    /** A personal access token (`fat_…`), or '' against an open board. */
    token: string;
    /** One request attempt's deadline, headers and body included (`FACTORY_REQUEST_TIMEOUT_S`). */
    requestTimeoutMs: number;
    /** Re-issues of a failed read after the first attempt (`FACTORY_READ_RETRIES`); 0 turns them off. */
    readRetries: number;
    /** Where each value came from: `env`, the settings file's path, or `default`. */
    sources: Record<SettingsKey, string>;
}

/** The settings file to read; a missing default is no file at all, a missing `--config` is refused. */
export interface SettingsFile {
    path: string;
    explicit: boolean;
}

const ENV_NAMES = {
    url: 'FACTORY_URL',
    token: 'FACTORY_TOKEN',
    requestTimeoutS: 'FACTORY_REQUEST_TIMEOUT_S',
    readRetries: 'FACTORY_READ_RETRIES',
} as const;

type SettingsKey = keyof typeof ENV_NAMES;

/** Each key's JSON type, checked whether or not a variable overrides it; ranges are checked on use. */
const SETTINGS_TYPES: Record<SettingsKey, 'string' | 'number'> = {
    url: 'string',
    token: 'string',
    requestTimeoutS: 'number',
    readRetries: 'number',
};
type Settings = Partial<Record<SettingsKey, unknown>>;

/** One value as found: its text, the name an error calls it by, and where it came from. */
interface Found {
    raw: string;
    label: string;
    source: string;
}

/** Any permission bit for group or other: a token there is readable by more than its owner. */
const SHARED_MODE_BITS = 0o077;
const PERMISSION_BITS = 0o777;
const MODE_DIGITS = 3;
const CONFIG_FLAG = '--config';
const OCTAL = 8;

const MAX_READ_RETRIES = 10;
const MAX_REQUEST_TIMEOUT_S = 3600;
const MS_PER_SECOND = 1000;

/** An unset value takes the fallback; anything else must be an integer within bounds, or it is named. */
function intOf(found: Found | null, { fallback, min, max }: { fallback: number; min: number; max: number }): number {
    if (!found) return fallback;
    const value = Number(found.raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new CliConfigError(`${found.label} must be an integer ${min}..${max}, got "${found.raw}"`);
    }
    return value;
}

// The protocol is checked, not just the parse: `new URL('dashboard:8080')` succeeds with
// 'dashboard:' as the scheme, and the first symptom would be every request failing against a
// value that reads perfectly well.
function assertHttpUrl(url: string, label: string): void {
    const scheme = (() => {
        try {
            return new URL(url).protocol;
        } catch {
            return null;
        }
    })();
    if (scheme !== 'http:' && scheme !== 'https:') {
        throw new CliConfigError(`${label} must be an http(s) URL, got "${url}"`);
    }
}

// Checked before the scheme, whose refusal echoes the value: a credential in the URL must never be
// printed back, and the token has its own variable.
function refuseUserinfo(url: string, label: string): void {
    const parsed = (() => {
        try {
            return new URL(url);
        } catch {
            return null;
        }
    })();
    if (parsed && (parsed.username || parsed.password)) {
        throw new CliConfigError(
            `${label} must not carry credentials (user:password@) — put a personal token in FACTORY_TOKEN`
        );
    }
}

/**
 * `--config <path>` or `--config=<path>` lifted out of the options (everything before `--`)
 * wherever it sits, so the topic and verb are read off what is left and no command sees the flag.
 */
export function takeConfigFlag(argv: readonly string[]): { argv: string[]; settings: SettingsFile | null } {
    const end = argv.indexOf('--');
    const rest = end === -1 ? [...argv] : argv.slice(0, end);
    const kept: string[] = [];
    let path: string | undefined;
    while (rest.length > 0) {
        const arg = rest.shift()!;
        const inline = arg.startsWith(`${CONFIG_FLAG}=`) ? arg.slice(CONFIG_FLAG.length + 1) : undefined;
        if (arg !== CONFIG_FLAG && inline === undefined) {
            kept.push(arg);
            continue;
        }
        if (path !== undefined) throw new CliConfigError(`${CONFIG_FLAG} given twice`);
        path = inline ?? rest.shift();
        if (!path || path.startsWith('-')) throw new CliConfigError(`${CONFIG_FLAG} needs a path`);
    }
    const settings = path === undefined ? null : { path, explicit: true };
    return { argv: end === -1 ? kept : [...kept, ...argv.slice(end)], settings };
}

function errnoOf(error: unknown): string {
    return (error as NodeJS.ErrnoException).code ?? String(error);
}

/** The file's keys, refused whole when it is not a JSON object of known keys; `{}` for an absent default. */
function readSettings(file: SettingsFile): Settings {
    let text: string;
    let mode: number;
    try {
        mode = statSync(file.path).mode;
        text = readFileSync(file.path, 'utf8');
    } catch (error) {
        if (!file.explicit && errnoOf(error) === 'ENOENT') return {};
        throw new CliConfigError(`cannot read settings file ${file.path} (${errnoOf(error)})`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new CliConfigError(`${file.path} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliConfigError(`${file.path} must hold a JSON object`);
    }
    const unknown = Object.keys(parsed).find((key) => !Object.hasOwn(ENV_NAMES, key));
    if (unknown !== undefined) {
        throw new CliConfigError(
            `${file.path}: unknown key "${unknown}" (known: ${Object.keys(ENV_NAMES).join(', ')})`
        );
    }
    const settings = parsed as Settings;
    for (const [key, type] of Object.entries(SETTINGS_TYPES)) {
        const value = settings[key as SettingsKey];
        if (value !== undefined && typeof value !== type)
            throw new CliConfigError(`${file.path}: ${key} must be a ${type}`);
    }
    // Refused even when FACTORY_TOKEN overrides it: the file exposes the token either way.
    // Windows has no POSIX mode bits to read.
    const token = settings.token;
    if (typeof token === 'string' && token.trim() && process.platform !== 'win32' && mode & SHARED_MODE_BITS) {
        const octal = (mode & PERMISSION_BITS).toString(OCTAL).padStart(MODE_DIGITS, '0');
        throw new CliConfigError(
            `${file.path} holds a token but is mode 0${octal}, readable beyond its owner — chmod 600 ${file.path}`
        );
    }
    return settings;
}

/** A set variable, else the file's key, else nothing. A blank string in the file is unset too. */
function find(key: SettingsKey, env: NodeJS.ProcessEnv, settings: Settings, path: string): Found | null {
    const name = ENV_NAMES[key];
    const fromEnv = (env[name] ?? '').trim();
    if (fromEnv) return { raw: fromEnv, label: name, source: 'env' };
    const value = settings[key];
    if (value === undefined) return null;
    const label = `${path}: ${key}`;
    const raw = String(value).trim();
    return raw ? { raw, label, source: path } : null;
}

export function loadCliConfig(env: NodeJS.ProcessEnv, file: SettingsFile): CliConfig {
    const settings = readSettings(file);
    const found = {
        url: find('url', env, settings, file.path),
        token: find('token', env, settings, file.path),
        requestTimeoutS: find('requestTimeoutS', env, settings, file.path),
        readRetries: find('readRetries', env, settings, file.path),
    };
    if (!found.url) {
        throw new CliConfigError(
            `FACTORY_URL (or url in ${file.path}) must be set to the board URL, e.g. http://127.0.0.1:8080`
        );
    }
    // Trailing slashes are stripped, because request paths are concatenated onto this string and
    // `…:8080//api/jobs` must not happen.
    const stripped = found.url.raw.replace(/\/+$/, '');
    refuseUserinfo(stripped, found.url.label);
    assertHttpUrl(stripped, found.url.label);
    return {
        url: stripped,
        // Empty is unset: the auth header is omitted rather than sent empty against an open board.
        token: found.token?.raw ?? '',
        requestTimeoutMs:
            intOf(found.requestTimeoutS, {
                fallback: DEFAULT_REQUEST_TIMEOUT_MS / MS_PER_SECOND,
                min: 1,
                max: MAX_REQUEST_TIMEOUT_S,
            }) * MS_PER_SECOND,
        readRetries: intOf(found.readRetries, {
            fallback: DEFAULT_READ_RETRIES,
            min: 0,
            max: MAX_READ_RETRIES,
        }),
        sources: {
            url: found.url.source,
            token: found.token?.source ?? 'default',
            requestTimeoutS: found.requestTimeoutS?.source ?? 'default',
            readRetries: found.readRetries?.source ?? 'default',
        },
    };
}
