import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commitDate } from '../src/format.js';
import { WorkspaceExecutorsPanel } from '../src/panels/WorkspaceExecutorsPanel.js';
import { expectNoPlaceholder } from './fixtures.js';

/* What stays here is the executors panel; the repositories list is pinned in repository-setup.*. */

describe('the executors panel', () => {
    // The panel is the list itself plus the scope context: the "My workspace" heading, the
    // guidance that says the type controls task execution, and the rows. Since 391 the default is
    // a per-member preference naming a scope — the panel reads it off the poll's resolved
    // default, never off a row flag.
    const executor = (name: string, type: string, createdAt = '2026-09-01T00:00:00.000Z', gateFixRounds = 3) => ({
        id: name,
        name,
        suspended: false,
        type,
        createdAt,
        gateFixRounds,
    });
    const noop = () => {};
    /** Two profiles, no resolved default, nothing saving; overrides name the difference. */
    const renderPanel = (overrides: Partial<ComponentProps<typeof WorkspaceExecutorsPanel>> = {}) =>
        renderToStaticMarkup(
            <WorkspaceExecutorsPanel
                executors={[executor('main', 'claude-code'), executor('oc', 'opencode')]}
                defaultExecutor={null}
                onAdd={noop}
                onEdit={noop}
                onMakeDefault={noop}
                onSuspend={noop}
                onRemove={noop}
                saving={false}
                {...overrides}
            />
        );

    it('heads the list "My workspace" with a count and its own Add executor, and repeats no guidance', () => {
        const html = renderPanel();
        expect(html).toContain('<div class="panel-head"><h2>My workspace<span class="count">2</span></h2>');
        expect(html).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Add executor<\/button>/);
        // The guidance is the page's single disclosure, not a paragraph under every scope head.
        expect(html).not.toContain('Each task runs with its selected executor');
    });

    it('an empty personal scope is one line with Add executor, no table', () => {
        const html = renderPanel({ executors: [] });
        expect(html).toContain('No personal executors.');
        expect(html).toContain('select an organization executor');
        expect(html).toContain('Add executor');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('No executors configured');
    });

    it('renders a row per executor with its HUMAN type label, and never a placeholder value', () => {
        const html = renderPanel();
        expect(html).toContain('Claude Code');
        expect(html).toContain('OpenCode');
        // The stored union value is for the API, not for the member.
        expect(html).not.toContain('claude-code');
        expect(html).not.toContain('No personal executors.');
        expectNoPlaceholder(html);
    });

    it('carries no Default tag when nothing is selectable — a poll without a resolved default', () => {
        const html = renderPanel();
        expect(html).not.toContain('>Default<');
        expect(html).not.toContain('Default — selected on new tasks');
    });

    it('the personal default shows a Default tag, not a caption paragraph', () => {
        const html = renderPanel({ defaultExecutor: { scope: 'user', name: 'oc' } });
        // Exactly one row wears the tag, and it is a pill beside the name, never a paragraph.
        expect(html.match(/<span class="pill">Default<\/span>/g)?.length).toBe(1);
        expect(html).not.toContain('Default — selected on new tasks');
        expect(html).not.toMatch(/<p[^>]*>Default/);
    });

    it('is a compact table whose cells stay sans', () => {
        const html = renderPanel();
        expect(html).toContain('<table class="data data-compact table-cards"');
        for (const label of ['Name', 'Type', 'Gate repair', 'Added', 'Actions']) {
            expect(html, label).toContain(`data-label="${label}"`);
        }
    });

    it('never carries a row config — the poll payload has none, and the type enforces it', () => {
        // WorkspaceExecutor has no config field; an excess property is a compile error, and the
        // render proves the summary path cannot leak one either.
        const html = renderPanel({ executors: [executor('main', 'claude-code')] });
        expect(html).not.toContain('{');
    });

    it('uses the real table primitives, focusable wrapper included', () => {
        const html = renderPanel({ executors: [executor('main', 'claude-code')] });
        expect(html).toContain('table-wrap');
        expect(html).toContain('<table class="data data-compact table-cards"');
        expect(html).toContain('scope="col"');
    });

    it('renders an Edit action per executor row', () => {
        const html = renderPanel();
        expect(html.match(/>Edit</g)?.length).toBe(2);
    });

    it('keeps only Edit inline and puts the other actions behind one trigger naming the row', () => {
        const html = renderPanel();
        expect(html).toContain('aria-label="Actions for main"');
        expect(html).toContain('aria-label="Actions for oc"');
        for (const word of ['Make default', 'Suspend', 'Remove']) {
            expect(html).not.toContain(`>${word}<`);
        }
    });
});

describe('formatting', () => {
    it('renders an absent or unparseable commit date as an em dash', () => {
        expect(commitDate(null)).toBe('—');
        expect(commitDate('not a date')).toBe('—');
        expect(commitDate('2026-08-20T09:00:00.000Z')).toBe('2026-08-20');
    });
});
