import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commitDate } from '../src/format.js';
import { WorkspaceExecutorsPanel } from '../src/panels/WorkspaceExecutorsPanel.js';
import { expectNoPlaceholder } from './fixtures.js';

/* What stays here is the executors panel; the repositories list is pinned in repository-setup.*. */

describe('the executors panel', () => {
    // The panel is the list itself plus the scope context (#183): the "My workspace" heading, the
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
                onEdit={noop}
                onMakeDefault={noop}
                onSuspend={noop}
                onRemove={noop}
                saving={false}
                {...overrides}
            />
        );

    it('scopes the list under "My workspace" and carries task-routing guidance', () => {
        const html = renderPanel({ executors: [] });
        expect(html).toContain('<h2>My workspace</h2>');
        expect(html).toContain('Each task runs with its selected executor');
        expect(html).toContain('type chooses Claude Code or OpenCode');
    });

    it('says an executor is selectable when the list is empty, the org scope included', () => {
        const html = renderPanel({ executors: [] });
        expect(html).toContain('No personal executors configured');
        expect(html).toContain('select an organization executor');
        expect(html).not.toContain('No executors configured');
    });

    it('renders a row per executor with its HUMAN type label, and never a placeholder value', () => {
        const html = renderPanel();
        expect(html).toContain('Claude Code');
        expect(html).toContain('OpenCode');
        // The stored union value is for the API, not for the member.
        expect(html).not.toContain('claude-code');
        expect(html).not.toContain('No personal executors configured');
        expectNoPlaceholder(html);
    });

    it('carries no row caption when nothing is selectable — a poll without a resolved default', () => {
        const html = renderPanel();
        expect(html).not.toContain('Default — selected on new tasks');
        expect(html).not.toContain('Selected first on new tasks');
    });

    it('captions the row the resolved default names, even when it is not first', () => {
        const html = renderPanel({ defaultExecutor: { scope: 'user', name: 'oc' } });
        expect(html).toContain('Default — selected on new tasks');
        // Exactly one row wears the caption.
        expect(html.match(/Default — selected on new tasks/g)?.length).toBe(1);
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
        expect(html).toContain('<table class="data"');
        expect(html).toContain('scope="col"');
    });

    it('renders an Edit action per executor row', () => {
        const html = renderPanel();
        expect(html.match(/>Edit</g)?.length).toBe(2);
    });

    it('renders Make default on every non-default row, and not on the default row', () => {
        const html = renderPanel({ defaultExecutor: { scope: 'user', name: 'oc' } });
        expect(html.match(/>Make default</g)?.length).toBe(1);
    });

    it('disables Make default while a save is in flight', () => {
        const html = renderPanel({ saving: true });
        expect(html).toMatch(/>Make default<\/button>/);
        expect(html).toContain('disabled');
    });
});

describe('formatting', () => {
    it('renders an absent or unparseable commit date as an em dash', () => {
        expect(commitDate(null)).toBe('—');
        expect(commitDate('not a date')).toBe('—');
        expect(commitDate('2026-08-20T09:00:00.000Z')).toBe('2026-08-20');
    });
});
