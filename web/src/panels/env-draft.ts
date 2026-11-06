/**
 * The environment draft editor's pure layer — no React. The `task-composer.ts` precedent: the
 * panel's decisions live here so the offline suite can pin them without a DOM. It imports
 * `env-raw.ts`, the other pure module, for the advanced editor's serializer.
 *
 * Three contracts the server forces, each applied from `server/src/routes/env.ts` (whose
 * `parseVars` stays the sole authority; the check here is UX-only early feedback):
 *
 * - The WHOLE list is the unit of save, and the only shape dirty comparison looks at is the API
 *   payload — `{ name, value, isSecret }` rows. React row ids never reach it, so a re-keyed table
 *   is not a change; row order is not either, because every scope read comes back
 *   `order by name asc` (env-var-store.ts) and the store's order is the only one a future read
 *   could return.
 * - A secret's `value: null` is the keep-what-is-stored marker and `''` is a typed replacement
 *   input. The distinction lives at row level — `secretState` and the new-row validation —
 *   because the wire has only one keep form: a blank input (typed or untouched) PUTs null, and
 *   clearing a typed value returns the editor to clean, which is what blank promised.
 * - The scope cap, name rules and value bounds are the server's own (core/src/env.ts, shared);
 *   a validation error only disables Save early, never redefines legality.
 */

import { ENV_NAME, ENV_NAME_LIMIT, ENV_VALUE_LIMIT, isReservedEnvName, MAX_ENV_VARS_PER_SCOPE } from '@factory-ai/core';
import { parseEnvRaw, serializeEnv } from './env-raw.js';

/** One editable row in the panel's draft state. `id` is a React key only — never in a payload. */
export interface EnvRowState {
    id: string;
    name: string;
    /** null = untouched stored secret (keep); '' = typed empty; any other string = typed text. */
    value: string | null;
    isSecret: boolean;
    /** false for rows seeded from the server echo; a new row may vanish without Undo. */
    isNew: boolean;
    /** Existing rows only: kept visible, struck through with Undo, until save. */
    pendingRemove: boolean;
    /** The stored row's last write (ISO); null for a row the draft added. Display only. */
    updatedAt: string | null;
}

export type EnvPayloadRow = { name: string; value: string | null; isSecret: boolean };

/** A stored row as a scope read echoes it: the payload plus its last write. */
export type EnvStoredRow = EnvPayloadRow & { updatedAt?: string };

/** The seed rows a panel starts from: the stored truth, nothing pending, nothing new. */
export function seedRows(initialVars: readonly EnvStoredRow[]): EnvRowState[] {
    return initialVars.map((row, index) => ({
        id: `seed-${index}`,
        name: row.name,
        value: row.value,
        isSecret: row.isSecret,
        isNew: false,
        pendingRemove: false,
        updatedAt: row.updatedAt ?? null,
    }));
}

/**
 * The API payload the draft would save: active rows only (pending-removed rows are excluded —
 * an omitted name is how the whole-list PUT deletes), names trimmed, a secret's blank input
 * turned back into the keep marker. Unfinished rows are INCLUDED — a blank-name addition must
 * read as dirty — and save runs only after validation passes, so one is never actually sent.
 */
export function envPayload(rows: readonly EnvRowState[]): EnvPayloadRow[] {
    return rows
        .filter((row) => !row.pendingRemove)
        .map((row) => ({
            name: row.name.trim(),
            value: row.isSecret && (row.value === '' || row.value === null) ? null : (row.value ?? ''),
            isSecret: row.isSecret,
        }));
}

/** Order-insensitive deep equality of two payloads — the store's read order is name asc. */
export function payloadEquals(a: readonly EnvPayloadRow[], b: readonly EnvPayloadRow[]): boolean {
    const key = (row: EnvPayloadRow) => JSON.stringify(row);
    const left = a.map(key).sort();
    const right = b.map(key).sort();
    return left.length === right.length && left.every((row, i) => row === right[i]);
}

/** Canonical dirty state: the baseline payload against the draft's, nothing else consulted. */
export function isDirty(baseline: readonly EnvRowState[], draft: readonly EnvRowState[]): boolean {
    return !payloadEquals(envPayload(baseline), envPayload(draft));
}

/** Dirty state of one type only — the tab marker for unsaved variables or secrets. */
export function isKindDirty(
    baseline: readonly EnvRowState[],
    draft: readonly EnvRowState[],
    isSecret: boolean
): boolean {
    const ofKind = (rows: readonly EnvRowState[]) => rows.filter((row) => row.isSecret === isSecret);
    return isDirty(ofKind(baseline), ofKind(draft));
}

export type EnvRowChange = 'new' | 'changed';

/**
 * What a row's unsaved-change marker says: `new` when no stored row of its type has its name
 * (an addition, or a rename), `changed` when the stored value differs or a secret has a
 * replacement typed. Matched by name, not id — the raw editor re-keys every variable row.
 */
export function rowChange(row: EnvRowState, baseline: readonly EnvRowState[]): EnvRowChange | null {
    const name = row.name.trim();
    const stored = baseline.find((candidate) => candidate.isSecret === row.isSecret && candidate.name === name);
    if (!stored) return 'new';
    if (row.isSecret) return secretState(row) === 'replace' ? 'changed' : null;
    return (row.value ?? '') === (stored.value ?? '') ? null : 'changed';
}

/** The tab count for one type: additions included, pending removals excluded. */
export function countActive(rows: readonly EnvRowState[], isSecret: boolean): number {
    return rows.filter((row) => row.isSecret === isSecret && !row.pendingRemove).length;
}

/** The name-level rules: required, length, shape, reserved, unique within the active rows. */
function nameErrors(name: string, nameCounts: ReadonlyMap<string, number>): string[] {
    if (name === '') return ['Name is required.'];
    const list: string[] = [];
    if (name.length > ENV_NAME_LIMIT) list.push(`Name exceeds ${ENV_NAME_LIMIT} characters.`);
    if (!ENV_NAME.test(name)) list.push(`"${name}" is not a legal environment variable name.`);
    if (isReservedEnvName(name)) list.push(`"${name}" is reserved by the runner.`);
    if ((nameCounts.get(name) ?? 0) > 1) {
        list.push(`Duplicate name "${name}" — names must be unique in this scope.`);
    }
    return list;
}

/** The value-level rules: a new secret needs a value, no newlines, within the size bound. */
function valueErrors(row: EnvRowState): string[] {
    const value = row.value ?? '';
    const list: string[] = [];
    if (row.isSecret && row.isNew && (row.value === '' || row.value === null)) {
        list.push('Enter a value or remove the row.');
    }
    if (value.includes('\n') || value.includes('\r')) list.push('Value contains a newline.');
    if (value.length > ENV_VALUE_LIMIT) list.push(`Value exceeds ${ENV_VALUE_LIMIT} characters.`);
    return list;
}

export interface RowFieldErrors {
    name: string[];
    value: string[];
}

/**
 * Broken rules per row, split by the field each one belongs to — a name problem must render
 * under the name input, not the value one. Pending-removed rows are never flagged — they are on
 * their way out and a red error under a row the user is deleting reads as a second opinion they
 * did not ask for. Mirrors parseVars in server/src/routes/env.ts.
 */
export function rowFieldErrors(rows: readonly EnvRowState[]): Map<string, RowFieldErrors> {
    const active = rows.filter((row) => !row.pendingRemove);
    const nameCounts = new Map<string, number>();
    for (const row of active) nameCounts.set(row.name.trim(), (nameCounts.get(row.name.trim()) ?? 0) + 1);

    const errors = new Map<string, RowFieldErrors>();
    for (const row of active) {
        const name = nameErrors(row.name.trim(), nameCounts);
        const value = valueErrors(row);
        if (name.length > 0 || value.length > 0) errors.set(row.id, { name, value });
    }
    return errors;
}

/** The save-level scope rule the row checks cannot see: the whole scope's size. */
export function scopeError(rows: readonly EnvRowState[]): string | null {
    const active = rows.filter((row) => !row.pendingRemove).length;
    if (active > MAX_ENV_VARS_PER_SCOPE) {
        return `At most ${MAX_ENV_VARS_PER_SCOPE} variables can be configured per scope.`;
    }
    return null;
}

export function hasErrors(errors: ReadonlyMap<string, RowFieldErrors>, scope: string | null): boolean {
    return scope !== null || errors.size > 0;
}

export type SecretState = 'set' | 'replace' | 'not-set';

export const SECRET_STATE_LABEL: Record<SecretState, string> = {
    set: 'Set',
    replace: 'Will replace when saved',
    'not-set': 'Not set',
};

/**
 * What the State column says about one secret row. A stored secret with a blank input is Set —
 * blank means keep, whatever the user typed and deleted before that. A new row with nothing
 * typed is Not set. Any typed text is a replacement staged for the next save.
 */
export function secretState(row: EnvRowState): SecretState {
    if (!row.isSecret) return 'set';
    if (row.value !== null && row.value !== '') return 'replace';
    return row.isNew ? 'not-set' : 'set';
}

/**
 * The `.env` text the draft's variables serialize to — the editor's raw mode. Secrets
 * never enter it (their values are write-only and cannot round-trip through text), a pending
 * removal stays out so re-reading the text cannot resurrect it, and an untouched blank addition
 * (no name, no value) is not a variable yet and would only read back as a malformed line.
 */
export function rowsToRawText(rows: readonly EnvRowState[]): string {
    const untouchedBlank = (row: EnvRowState) => row.isNew && row.name.trim() === '' && (row.value ?? '') === '';
    return serializeEnv(rows.filter((row) => !row.isSecret && !row.pendingRemove && !untouchedBlank(row)));
}

export type RawApplyResult = { ok: true; rows: EnvRowState[] } | { ok: false; errors: string[] };

/**
 * Reads the text as the WHOLE variable set against the draft's rows: the parsed pairs become the
 * variable rows and the secret rows (pending states included) pass around untouched. Malformed
 * text returns its line-numbered errors and no rows — the caller keeps the draft it had, so a bad
 * edit can never overwrite a value. A pending-removed secret is not a name collision.
 */
export function applyRawText(text: string, rows: readonly EnvRowState[], nextId: () => string): RawApplyResult {
    const secretNames = rows.filter((row) => row.isSecret && !row.pendingRemove).map((row) => row.name);
    const result = parseEnvRaw(text, secretNames);
    if (!result.ok) return result;
    const variables: EnvRowState[] = result.vars.map((row) => ({
        id: nextId(),
        name: row.name,
        value: row.value,
        isSecret: false,
        isNew: false,
        pendingRemove: false,
        updatedAt: rows.find((stored) => !stored.isSecret && stored.name === row.name)?.updatedAt ?? null,
    }));
    return { ok: true, rows: [...variables, ...rows.filter((row) => row.isSecret)] };
}

/** The text mode's one line about the secrets it does not show; null when there are none. */
export function secretsNote(count: number): string | null {
    if (count === 0) return null;
    return count === 1 ? '1 secret is edited in the Secrets tab.' : `${count} secrets are edited in the Secrets tab.`;
}
