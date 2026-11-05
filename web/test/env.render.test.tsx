import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EnvSaveResult, EnvVarView } from '../src/api/useEnv.js';
import { EnvVarsSection } from '../src/panels/EnvVarsSection.js';

/**
 * The variables summary each settings page shows (BEL-262b), server-render-tested by markup
 * assertions: counts, the first few names, masking and the empty state. The editing itself lives
 * in the dialog (`env-dialog.dom.test.tsx`) and is driven through the pages by `env.dom.test.tsx`.
 */

const ORG = { scope: 'organization' } as const;

const noop = async (): Promise<EnvSaveResult> => ({ error: null, vars: [] });

const at = '2026-09-01T00:00:00.000Z';
const oneVar = [{ name: 'LOG_LEVEL', value: 'debug', isSecret: false, updatedAt: at }];
const oneSecret = [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: at }];

const render = (vars: EnvVarView[], title = 'Core') =>
    renderToStaticMarkup(
        <EnvVarsSection title={title} scope={ORG} vars={vars} onSave={noop} draftId="org" draftLabel={title} />
    );

describe('the variables summary', () => {
    it('says clearly that an empty scope has nothing configured, and still offers the way in', () => {
        const html = render([]);
        expect(html).toContain('Core');
        expect(html).toContain('No variables or secrets configured yet.');
        expect(html).toContain('Edit variables');
    });

    it('shows the variable and secret counts', () => {
        const html = render([...oneVar, ...oneSecret]);
        const text = html.replace(/<[^>]*>/g, '');
        expect(text).toContain('1 variable');
        expect(text).toContain('1 secret');
    });

    it('pluralises the counts', () => {
        const many = [
            { name: 'A', value: '1', isSecret: false, updatedAt: at },
            { name: 'B', value: '2', isSecret: false, updatedAt: at },
            { name: 'S1', value: null, isSecret: true, updatedAt: at },
            { name: 'S2', value: null, isSecret: true, updatedAt: at },
        ];
        const text = render(many).replace(/<[^>]*>/g, '');
        expect(text).toContain('2 variables');
        expect(text).toContain('2 secrets');
    });

    it('lists names but never a value, and never a secret value', () => {
        const html = render([
            { name: 'LOG_LEVEL', value: 'debug-value-xyz', isSecret: false, updatedAt: at },
            ...oneSecret,
        ]);
        expect(html).toContain('LOG_LEVEL');
        expect(html).toContain('CORE_SECRET');
        expect(html).not.toContain('debug-value-xyz');
        expect(html).not.toContain('<input');
        expect(html).not.toContain('type="password"');
    });

    it('marks a secret as hidden in the names list', () => {
        const html = render(oneSecret);
        expect(html).toContain('CORE_SECRET');
        expect(html).toContain('secret');
        expect(html).toContain('value hidden');
    });

    it('shows only the first few names and counts the rest', () => {
        const vars = Array.from({ length: 12 }, (_, i) => ({
            name: `VAR_${String(i).padStart(2, '0')}`,
            value: 'v',
            isSecret: false,
            updatedAt: at,
        }));
        const html = render(vars);
        expect(html).toContain('VAR_00');
        expect(html).toContain('VAR_04');
        expect(html).not.toContain('VAR_11');
        expect(html).toContain('and 7 more');
    });

    it('draws no editing surface inline: no tabs, no table, no textarea, no save bar', () => {
        const html = render([...oneVar, ...oneSecret]);
        expect(html).not.toContain('role="tablist"');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('Save changes');
        expect(html).not.toContain('Edit variables as .env');
        expect(html).not.toContain('Apply .env draft');
    });

    it('has one secondary Edit variables button and no primary action', () => {
        const html = render(oneVar);
        expect(html).toMatch(/<button[^>]*>Edit variables<\/button>/);
        expect(html).not.toMatch(/class="[^"]*\bprimary\b[^"]*"/);
    });

    it('renders a polite status region for the save confirmation, and no alert', () => {
        const html = render([]);
        expect(html).toContain('role="status"');
        expect(html).not.toContain('role="alert"');
    });

    it('uses no form, because the CSP sends form-action none', () => {
        expect(render([])).not.toContain('<form');
    });

    it('never leans on window.confirm anywhere the guard reaches', () => {
        // The dialog contract replaced the browser confirm on the task page (issue 178); the env
        // guards must not quietly reintroduce it. Source pin, because the call would render
        // nothing for a static suite to catch.
        const paths = [
            '../src/panels/EnvVarsSection.tsx',
            '../src/components/EnvVarsDialog.tsx',
            '../src/pages/SettingsLayout.tsx',
            '../src/pages/SettingsRepositoriesPage.tsx',
        ].map((p) => fileURLToPath(new URL(p, import.meta.url)));
        for (const path of paths) {
            expect(readFileSync(path, 'utf8'), path).not.toContain('window.confirm');
        }
    });
});
