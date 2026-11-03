import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EnvVarsPanel } from '../src/panels/EnvVarsPanel.js';
import { AdvancedEnvEditor } from '../src/panels/env-vars-panel-parts.js';
import { expectNoPlaceholder } from './fixtures.js';

/**
 * The env draft editor, server-render-tested by markup assertions — this file holds everything
 * REACHABLE from props: roles, relationships, counts, labels, masking and the save button's
 * clean-state posture. Every INTERACTION state — pending removal and Undo, a typed secret's Will
 * replace, a new row's Not set, an open advanced editor, the save lifecycle itself — is decided by
 * the pure layer in `env-draft.ts` (pinned by `env-draft.test.ts`) and driven under jsdom by
 * `env.dom.test.tsx`.
 */

const ORG = { scope: 'organization' } as const;

const noop = async () => ({ error: null, vars: [] });

const oneVar = [{ name: 'LOG_LEVEL', value: 'debug', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' }];
const oneSecret = [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' }];

describe('the env draft editor', () => {
    it('offers an empty scope a way in', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={[]} onSave={noop} />);
        expect(html).toContain('Core');
        expect(html).toContain('No variables configured');
        expect(html).toContain('Add variable');
        // Clean means no bar: there is nothing to save yet.
        expect(html).not.toContain('Save changes');
    });

    it('renders a row per variable with its name and value', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="My workspace" scope={ORG} initialVars={oneVar} onSave={noop} />
        );
        expect(html).toContain('LOG_LEVEL');
        expect(html).toContain('debug');
    });

    it('draws the env tabs with the shared .tabs strip, not a private skin', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={[...oneVar, ...oneSecret]} onSave={noop} />
        );
        expect(html).toMatch(/role="tablist"[^>]*class="tabs"|class="tabs"[^>]*role="tablist"/);
        expect(html).not.toContain('env-tab');
    });

    it('renders a real tablist with live counts and roving focus', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={[...oneVar, ...oneSecret]} onSave={noop} />
        );
        expect(html).toContain('role="tablist"');
        expect(html).toContain('role="tab"');
        expect(html).toContain('aria-selected="true"');
        expect(html).toContain('aria-selected="false"');
        // Roving tabindex: exactly the selected tab is in the page's tab order.
        expect(html).toContain('tabindex="0"');
        expect(html).toContain('tabindex="-1"');
        // Counts: one stored variable, one stored secret.
        const text = html.replace(/<[^>]*>/g, '');
        expect(text).toContain('Variables (1)');
        expect(text).toContain('Secrets (1)');
        // The tab/panel relationship is explicit, and both panels stay mounted (the inactive one
        // carries hidden) — the draft spans tabs.
        expect(html).toContain('aria-controls');
        expect(html).toMatch(/role="tabpanel"[^>]*aria-labelledby/);
        expect(html).toContain('hidden');
        expect(html).toContain('CORE_SECRET');
    });

    it('names every input per row, never one label shared by the table', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="Core"
                scope={ORG}
                initialVars={[
                    { name: 'A', value: '1', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' },
                    { name: 'B', value: '2', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' },
                ]}
                onSave={noop}
            />
        );
        expect(html).toContain('Variable 1 name');
        expect(html).toContain('Variable 1 value');
        expect(html).toContain('Variable 2 name');
        expect(html).toContain('Variable 2 value');
    });

    it('marks a stored secret Set, masks its input, and offers no way to see or retype it', () => {
        // The server nulls a secret's value on every read, so blank is the truth the panel
        // renders — with the sentence that says what blank MEANS. No checkbox anywhere: the old
        // secret flag was the one control that could turn a masked credential into an empty
        // variable, and the tab a row lives in now decides its type.
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={oneSecret} onSave={noop} />
        );
        expect(html).toContain('CORE_SECRET');
        expect(html).toContain('type="password"');
        expect(html).toContain('autoComplete="off"');
        expect(html).toContain('Leave blank to keep the current secret');
        expect(html).toContain('Set');
        expect(html).not.toContain('checkbox');
        expectNoPlaceholder(html);
    });

    it('renders the advanced disclosure closed, with no textarea and no warning', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={oneVar} onSave={noop} />);
        expect(html).toContain('Edit variables as .env');
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('<textarea');
        // Opening alone never changes the draft, so the warning is only true once it is open.
        expect(html).not.toContain('This replaces the variable draft');
    });

    it('attaches a name error to the name input only, never the value input beside it', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel
                title="Core"
                scope={ORG}
                initialVars={[{ name: '', value: 'debug', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' }]}
                onSave={noop}
            />
        );
        const nameAt = html.indexOf('Variable 1 name');
        const valueAt = html.indexOf('Variable 1 value');
        expect(nameAt).toBeGreaterThanOrEqual(0);
        expect(valueAt).toBeGreaterThan(nameAt);
        const nameField = html.slice(nameAt, valueAt);
        const valueField = html.slice(valueAt, html.indexOf('</tr>', valueAt));
        expect(nameField).toContain('aria-invalid="true"');
        expect(nameField).toContain('Name is required.');
        expect(valueField).not.toContain('aria-invalid="true"');
        expect(valueField).not.toContain('Name is required.');
    });

    it('has no primary action while clean — Add and the .env toggle stay secondary, Save arrives with the draft', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={[...oneVar, ...oneSecret]} onSave={noop} />
        );
        const primaryButtons = html.match(/class="[^"]*\bprimary\b[^"]*"/g) ?? [];
        expect(primaryButtons).toHaveLength(0);
    });

    it('never gives the open .env disclosure its own primary button, even beside the real Save', () => {
        // AdvancedEnvEditor renders whenever its parent mounts it (the open/closed decision lives
        // in EnvVarsPanel's state, out of this static suite's reach) — so this pins the disclosure's
        // OWN markup directly: Apply must never compete with the panel's one Save action.
        const html = renderToStaticMarkup(
            <AdvancedEnvEditor
                uid="t"
                text=""
                errors={[]}
                locked={false}
                onTextChange={() => {}}
                onApply={() => {}}
                onCancel={() => {}}
                containerRef={() => {}}
            />
        );
        expect(html).not.toMatch(/class="[^"]*\bprimary\b[^"]*"/);
    });

    it('renders no save bar while clean — no Save, no Cancel, no indicator', () => {
        // The settings editor pattern: the bar is unmounted when pristine (it shows once dirty,
        // env.dom.test.tsx), so a clean editor has no disabled Save to stare at.
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={oneVar} onSave={noop} />);
        expect(html).not.toContain('settings-actions');
        expect(html).not.toContain('>Save changes</button>');
        expect(html).not.toContain('Unsaved changes');
        expect(html).not.toContain('panel-actions');
    });

    it('renders the add control and the .env toggle in a toolbar beside the tabs, before the table', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={oneVar} onSave={noop} />);
        expect(html).toContain('class="env-toolbar"');
        expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf('Add variable'));
        expect(html.indexOf('Add variable')).toBeLessThan(html.indexOf('env-vars'));
        expect(html.indexOf('Edit variables as .env')).toBeLessThan(html.indexOf('env-vars'));
        expect(html).not.toContain('env-row-actions');
    });

    it('counts the tabs in a .count element while the tab name stays "Variables (n)"', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={oneVar} onSave={noop} />);
        expect(html).toContain(
            'Variables <span class="count"><span class="visually-hidden">(</span>1<span class="visually-hidden">)</span></span>'
        );
    });

    it('renders a read-only scope with the tabs intact and every control disabled', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={[...oneVar, ...oneSecret]} onSave={noop} disabled />
        );
        expect(html).toContain('Edit variables as .env');
        expect(html).toContain('Add variable');
        expect(html).not.toContain('Save changes');
        expect(html).toContain('type="password"');
        expect(html).toContain('disabled');
        expectNoPlaceholder(html);
    });

    it('renders a polite status region for confirmations — alerts are for errors only', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={[]} onSave={noop} />);
        // The clean render carries the live region and no alert: role="alert" is reserved for
        // the scope error, the save failure and the advanced parser's refusals.
        expect(html).toContain('role="status"');
        expect(html).not.toContain('role="alert"');
    });

    it('renders both panels mounted so the draft spans tabs', () => {
        const html = renderToStaticMarkup(
            <EnvVarsPanel title="Core" scope={ORG} initialVars={oneSecret} onSave={noop} />
        );
        expect(html).toContain('Leave blank to keep the current secret');
        expect(html).toContain('hidden');
    });

    it('uses no form, because the CSP sends form-action none', () => {
        const html = renderToStaticMarkup(<EnvVarsPanel title="Core" scope={ORG} initialVars={[]} onSave={noop} />);
        expect(html).not.toContain('<form');
    });

    it('never leans on window.confirm anywhere the guard reaches', () => {
        // The dialog contract replaced the browser confirm on the task page (issue 178); the env
        // guards must not quietly reintroduce it. Source pin, because the call would render
        // nothing for a static suite to catch.
        const panelPath = fileURLToPath(new URL('../src/panels/EnvVarsPanel.tsx', import.meta.url));
        const layoutPath = fileURLToPath(new URL('../src/pages/SettingsLayout.tsx', import.meta.url));
        const reposPath = fileURLToPath(new URL('../src/pages/SettingsRepositoriesPage.tsx', import.meta.url));
        for (const path of [panelPath, layoutPath, reposPath]) {
            expect(readFileSync(path, 'utf8'), path).not.toContain('window.confirm');
        }
    });
});
