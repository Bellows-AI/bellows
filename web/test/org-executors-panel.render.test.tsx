import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrgExecutorsPanel } from '../src/panels/OrgExecutorsPanel.js';
import { expectNoPlaceholder } from './fixtures.js';

describe('the organization executors panel', () => {
    const executor = (name: string, type: string, createdAt = '2026-09-01T00:00:00.000Z') => ({
        name,
        type,
        createdAt,
    });
    const noop = () => {};
    /** A member's view of one profile, nothing saving and no org default; overrides name the difference. */
    const renderPanel = (overrides: Partial<ComponentProps<typeof OrgExecutorsPanel>> = {}) =>
        renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={false}
                saving={false}
                defaultName={null}
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
                {...overrides}
            />
        );

    it('renders Make default on every non-default row, and not on the row the org default names', () => {
        const html = renderPanel({
            executors: [executor('team-runner', 'claude-code'), executor('oc', 'opencode')],
            defaultName: 'team-runner',
        });
        // The default row answers with its caption instead — a click there would write nothing.
        expect(html.match(/>Make default</g)?.length).toBe(1);
        expect(html.match(/Default — selected on new tasks/g)?.length).toBe(1);
    });

    it('disables Make default while a save is in flight', () => {
        const html = renderPanel({
            executors: [executor('team-runner', 'claude-code'), executor('oc', 'opencode')],
            saving: true,
        });
        expect(html).toMatch(/>Make default<\/button>/);
        expect(html).toContain('disabled');
    });

    it('shows an admin Edit inline and one overflow trigger naming the profile', () => {
        const html = renderPanel({ isAdmin: true, onAdd: noop, onEdit: noop, onDelete: noop, onDemote: noop });
        expect(html.match(/>Edit</g)?.length).toBe(1);
        expect(html).toContain('aria-label="Actions for team-runner"');
        // Make personal and Delete live in the portalled menu, so they reach no static markup —
        // what matters here is that they are no longer four equal-weight buttons in the cell.
        expect(html).not.toContain('>Delete<');
        expect(html).not.toContain('>Make personal<');
    });

    it('shows a member Make default and no overflow trigger', () => {
        const html = renderPanel();
        expect(html.match(/>Make default</g)?.length).toBe(1);
        expect(html).not.toContain('row-actions-trigger');
    });

    it('gives a member no control at all on the row the org default names', () => {
        const html = renderPanel({ defaultName: 'team-runner' });
        expect(html).not.toContain('<button');
        // And no caption over the nothing: the card reflow writes `data-label` above each cell.
        expect(html).not.toContain('data-label="Actions"');
    });

    it('labels every cell for the narrow-viewport card reflow', () => {
        const html = renderPanel();
        expect(html).toContain('table-cards');
        for (const label of ['Name', 'Type', 'Added', 'Actions']) {
            expect(html, label).toContain(`data-label="${label}"`);
        }
    });

    it('keeps the panel legible with no placeholder values', () => {
        const html = renderPanel();
        expectNoPlaceholder(html);
    });
});
