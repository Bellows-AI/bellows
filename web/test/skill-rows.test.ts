import { describe, expect, it } from 'vitest';
import type { CatalogSkill, StoredSkill } from '../src/api/skills.js';
import {
    builtinHiddenNote,
    managedHiddenNote,
    needsOf,
    shadowedForMe,
    versionLabel,
} from '../src/settings/skill-rows.js';

const stored = (over: Partial<StoredSkill> = {}): StoredSkill => ({
    id: 'i',
    name: 'deploy',
    scope: 'workspace',
    enabled: true,
    createdBy: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    current: {
        id: 'v',
        sha256: 'abcdef0123456789',
        size: 1,
        description: 'd',
        createdAt: '2026-11-03T10:00:00.000Z',
        author: { id: 'u', login: 'ada' },
    },
    ...over,
});
const builtin = (connections: string[], over: Partial<CatalogSkill> = {}): CatalogSkill => ({
    name: 'factory-jira',
    description: 'd',
    source: 'builtin',
    requires: {
        tools: [],
        connections: connections.map((name) => ({
            name,
            env: [],
            selectedBy: name === 'jira' ? 'connections' : null,
        })),
    },
    ...over,
});
const conn = (provider: string, status: 'active' | 'disconnected') => ({
    id: provider,
    provider,
    site: 's',
    account: 'a',
    access: 'read' as const,
    status,
    needsReconnect: false,
    createdAt: '2026-11-01T10:00:00.000Z',
});

describe('shadowedForMe', () => {
    it('is true when the workspace holds an enabled skill of the name', () => {
        expect(shadowedForMe(stored({ scope: 'org' }), [stored()])).toBe(true);
    });
    it('is false when the workspace skill is disabled', () => {
        expect(shadowedForMe(stored({ scope: 'org' }), [stored({ enabled: false })])).toBe(false);
    });
    it('is false when no workspace skill has the name', () => {
        expect(shadowedForMe(stored({ scope: 'org' }), [stored({ name: 'other' })])).toBe(false);
    });
});

describe('managedHiddenNote', () => {
    it('says Switched off for a disabled row and nothing otherwise', () => {
        expect(managedHiddenNote(stored({ enabled: false }))).toBe('Switched off');
        expect(managedHiddenNote(stored())).toBeNull();
    });
});

describe('builtinHiddenNote', () => {
    it('says Switched off for a switched-off entry', () => {
        expect(builtinHiddenNote(builtin([], { switchedOff: true }), [])).toBe('Switched off');
    });
    it('names a connection provider with no active connection', () => {
        expect(builtinHiddenNote(builtin(['jira']), [])).toBe('Needs Jira');
        expect(builtinHiddenNote(builtin(['jira']), [conn('jira', 'disconnected')])).toBe('Needs Jira');
    });
    it('is null once an active connection exists', () => {
        expect(builtinHiddenNote(builtin(['jira']), [conn('jira', 'active')])).toBeNull();
    });
    it('never shows github', () => {
        expect(builtinHiddenNote(builtin(['github']), [])).toBeNull();
    });
    it('never says Needs when the connections are unknown', () => {
        expect(builtinHiddenNote(builtin(['jira']), 'unknown')).toBeNull();
        expect(builtinHiddenNote(builtin(['jira'], { switchedOff: true }), 'unknown')).toBe('Switched off');
    });
});

describe('versionLabel', () => {
    it('is the 7-character sha and the date, without the author', () => {
        expect(versionLabel(stored().current)).toBe('abcdef0 · 2026-11-03');
    });
});

describe('needsOf', () => {
    it('lists the labels of the connection providers only', () => {
        expect(needsOf(builtin(['jira', 'github']).requires)).toEqual(['Jira']);
        expect(needsOf(builtin([]).requires)).toEqual([]);
    });
});
