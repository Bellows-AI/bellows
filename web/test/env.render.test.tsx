import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EnvSaveResult, EnvVarView } from '../src/api/useEnv.js';
import { EnvVarsSection } from '../src/panels/EnvVarsSection.js';

/**
 * The inline variables editor's first paint, server-render-tested by markup assertions:
 * the tabs and their counts, the rows read as text, masking and the empty state. The editing
 * itself is driven by `env-editor.dom.test.tsx` and, through the pages, by `env.dom.test.tsx`.
 */

const noop = async (): Promise<EnvSaveResult> => ({ error: null, vars: [] });

const at = '2026-09-01T00:00:00.000Z';
const oneVar = [{ name: 'LOG_LEVEL', value: 'debug', isSecret: false, updatedAt: at }];
const oneSecret = [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: at }];

const render = (vars: EnvVarView[], title = 'Organization variables') =>
    renderToStaticMarkup(<EnvVarsSection title={title} vars={vars} onSave={noop} draftId="org" draftLabel={title} />);

const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('the inline variables editor, first paint', () => {
    it('titles the section with an h2 and labels the section by it', () => {
        const html = render([]);
        expect(html).toMatch(/<section class="env-editor" aria-labelledby="([^"]+)-title">/);
        expect(html).toMatch(/<h2 id="[^"]+-title" class="env-editor-title">Organization variables<\/h2>/);
    });

    it('sets a repository title in the mono face', () => {
        const html = renderToStaticMarkup(
            <EnvVarsSection
                title="octo/hooks"
                monoTitle
                vars={[]}
                onSave={noop}
                draftId="repo:octo/hooks"
                draftLabel="octo/hooks"
            />
        );
        expect(html).toContain('class="env-editor-title mono">octo/hooks</h2>');
    });

    it('draws the Variables and Secrets tabs with their counts, Variables selected', () => {
        const html = render([...oneVar, ...oneSecret]);
        expect(html).toContain('role="tablist"');
        expect(html).toContain('aria-label="Kind"');
        expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Variables<span class="env-tab-count">1<\/span>/);
        expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Secrets<span class="env-tab-count">1<\/span>/);
        expect(html).toContain('role="tabpanel"');
    });

    it('counts each kind on its own tab', () => {
        const many = [
            { name: 'A', value: '1', isSecret: false, updatedAt: at },
            { name: 'B', value: '2', isSecret: false, updatedAt: at },
            { name: 'S1', value: null, isSecret: true, updatedAt: at },
        ];
        const html = render(many);
        expect(html).toMatch(/>Variables<span class="env-tab-count">2<\/span>/);
        expect(html).toMatch(/>Secrets<span class="env-tab-count">1<\/span>/);
    });

    it('says clearly that an empty scope has no variables, and still offers New variable', () => {
        const html = render([]);
        expect(html).toContain('No variables yet.');
        expect(html).toContain('New variable');
        expect(html).not.toContain('No variables or secrets configured yet.');
    });

    it('reads the variable rows as text with a name, a value and Edit and Remove', () => {
        const html = render(oneVar);
        expect(html).toContain('LOG_LEVEL');
        expect(html).toContain('debug');
        expect(html).toContain('aria-label="Edit LOG_LEVEL"');
        expect(html).toContain('aria-label="Remove LOG_LEVEL"');
        expect(text(html)).toContain('Updated ');
        expect(html).not.toContain('<input type="text"');
    });

    it('draws no editing surface on first paint: no row input, no textarea, no save bar', () => {
        const html = render([...oneVar, ...oneSecret]);
        expect(html).not.toContain('aria-label="Variable name"');
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain('env-savebar');
        expect(html).not.toContain('Save changes');
        expect(html).not.toContain('env-row-editing');
    });

    it('offers the filter, the raw editor toggle and one primary action, New variable', () => {
        const html = render(oneVar);
        expect(html).toContain('aria-label="Filter variables by name"');
        expect(html).toMatch(/aria-pressed="false"[^>]*>(<[^>]+>)*Raw editor/);
        expect(html.match(/class="[^"]*\bprimary\b[^"]*"/g)).toHaveLength(1);
        expect(html).toMatch(/class="primary env-new"[^>]*>(<[^>]+>)*New variable/);
    });

    it('marks no row and no tab as unsaved while clean', () => {
        const html = render([...oneVar, ...oneSecret]);
        expect(html).not.toContain('Unsaved changes');
        expect(html).not.toContain('not saved');
    });

    it('never prints a variable value into an attribute or a stored secret anywhere', () => {
        const html = render([
            { name: 'LOG_LEVEL', value: 'debug-value-xyz', isSecret: false, updatedAt: at },
            ...oneSecret,
        ]);
        expect(html).not.toContain('type="password"');
        // A secret is not on the first tab at all; its tab holds the name and a mask, never a value.
        expect(html).not.toContain('CORE_SECRET');
    });

    it('renders a polite status region for the save confirmation, and no alert', () => {
        const html = render([]);
        expect(html).toContain('role="status"');
        expect(html).not.toContain('role="alert"');
    });

    it('uses no form, because the CSP sends form-action none', () => {
        expect(render([])).not.toContain('<form');
    });
});
