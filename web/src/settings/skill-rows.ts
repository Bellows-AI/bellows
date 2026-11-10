import { INTEGRATION_PROVIDERS, selectedBy } from '@factory-ai/core';
import type { ConnectionView } from '../api/connections.js';
import type { CatalogRequirements, CatalogSkill, SkillVersion, StoredSkill } from '../api/skills.js';

/** The Skills page's row rules, as pure functions of the wire rows. */

const SHORT_SHA = 7;
const DATE_LENGTH = 10;

/** `'unknown'`: the connections read failed — no row may claim a connection is missing. */
export type ConnectionsState = ConnectionView[] | 'unknown';

export const SWITCHED_OFF = 'Switched off';

/** True when the workspace holds an enabled skill of the org row's name: the workspace one wins for me. */
export const shadowedForMe = (orgRow: StoredSkill, workspaceRows: readonly StoredSkill[]): boolean =>
    workspaceRows.some((row) => row.enabled && row.name === orgRow.name);

/** A managed row is only ever hidden by its switch; it never gets a "Needs" note. */
export const managedHiddenNote = (row: StoredSkill): string | null => (row.enabled ? null : SWITCHED_OFF);

const labelOf = (provider: string): string =>
    Object.hasOwn(INTEGRATION_PROVIDERS, provider)
        ? INTEGRATION_PROVIDERS[provider as keyof typeof INTEGRATION_PROVIDERS].label
        : provider;

/** The providers a built-in needs connected: only those a task selects by connection (never `github`). */
const connectionProviders = (requires: CatalogRequirements): string[] =>
    requires.connections.filter((c) => selectedBy(c.name) === 'connections').map((c) => c.name);

/** The labels of the connections a built-in needs, for its row and its View meta line. */
export const needsOf = (requires: CatalogRequirements): string[] => connectionProviders(requires).map(labelOf);

export const builtinHiddenNote = (entry: CatalogSkill, connections: ConnectionsState): string | null => {
    if (entry.switchedOff === true) return SWITCHED_OFF;
    if (connections === 'unknown') return null;
    const missing = connectionProviders(entry.requires).find(
        (provider) => !connections.some((c) => c.provider === provider && c.status === 'active')
    );
    return missing === undefined ? null : `Needs ${labelOf(missing)}`;
};

export const shortSha = (current: SkillVersion): string => current.sha256.slice(0, SHORT_SHA);

/** The version cell: the short sha and the date. The author is only in View. */
export const versionLabel = (current: SkillVersion): string =>
    `${shortSha(current)} · ${current.createdAt.slice(0, DATE_LENGTH)}`;
