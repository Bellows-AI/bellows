import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../src/api/connections.js';
import type { JobIntegrationRequirement } from '../src/api/useJobs.js';
import { type Candidates, TaskConnectView } from '../src/panels/TaskConnect.js';
import { FORBIDDEN } from './fixtures.js';

const requirement = (over: Partial<JobIntegrationRequirement> = {}): JobIntegrationRequirement => ({
    provider: 'jira',
    label: 'Jira',
    reason: 'missing',
    source: 'runtime',
    connectionId: null,
    target: null,
    createdAt: '2026-09-01T12:05:00.000Z',
    ...over,
});

const connection = (over: Partial<ConnectionView> = {}): ConnectionView => ({
    id: '44444444-4444-4444-8444-444444444444',
    provider: 'jira',
    site: 'one.example.test',
    account: 'first@example.test',
    access: 'read',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
});

const NONE: Candidates = { state: 'ready', connections: [] };

function render(
    over: Partial<Parameters<typeof TaskConnectView>[0]> & { requirement?: JobIntegrationRequirement } = {}
): string {
    const html = renderToStaticMarkup(
        <TaskConnectView
            requirement={requirement()}
            owner="Local"
            canAct
            candidates={NONE}
            picked={null}
            busy={null}
            error={null}
            onPick={() => {}}
            onConnect={() => {}}
            onUse={() => {}}
            onDismiss={() => {}}
            {...over}
        />
    );
    for (const bad of FORBIDDEN) expect(html).not.toContain(bad);
    return html;
}

describe('TaskConnect: the block', () => {
    it('says what the task needs when the requirement names a target, and nothing when it does not', () => {
        expect(render({ requirement: requirement({ target: 'b.example.test' }) })).toContain(
            'The task needs: b.example.test'
        );
        expect(render()).not.toContain('The task needs');
    });

    it('missing lists none and offers Connect <label> and Continue without it', () => {
        const html = render();
        expect(html).toContain('Connect Jira');
        expect(html).toContain('Continue without it');
        expect(html).not.toContain('type="radio"');
        expect(html).not.toContain('no connections');
    });

    it("ambiguous lists the caller's connections, Use disabled until one is picked", () => {
        const rows = [
            connection(),
            connection({ id: '55555555-5555-4555-8555-555555555555', site: 'two.example.test' }),
        ];
        const html = render({
            requirement: requirement({ reason: 'ambiguous' }),
            candidates: { state: 'ready', connections: rows },
        });
        expect(html.match(/type="radio"/g)).toHaveLength(2);
        expect(html).toContain('one.example.test');
        expect(html).toContain('two.example.test');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use selected connection<\/button>/);
        const picked = render({
            requirement: requirement({ reason: 'ambiguous' }),
            candidates: { state: 'ready', connections: rows },
            picked: rows[1]!.id,
        });
        expect(picked).not.toMatch(/<button[^>]*disabled=""[^>]*>Use selected connection<\/button>/);
    });

    it('reconnect offers Reconnect <label>', () => {
        const html = render({ requirement: requirement({ reason: 'reconnect', connectionId: 'c' }) });
        expect(html).toContain('Reconnect Jira');
        expect(html).not.toContain('Connect Jira');
    });

    it('is read-only for another member and names who must act', () => {
        const html = render({ canAct: false, owner: 'Octo Owner' });
        expect(html).toContain('Octo Owner');
        expect(html).not.toContain('<button');
        expect(html).not.toContain('Connect Jira');
    });

    it('a fake provider renders through the same block', () => {
        const html = render({ requirement: requirement({ provider: 'acme', label: 'Acme' }) });
        expect(html).toContain('Connect Acme');
        expect(html).not.toContain('Jira');
    });

    it('says a creation-time wait has not started, and a runtime wait paused the run', () => {
        expect(render({ requirement: requirement({ source: 'create' }) })).toContain('has not started');
        expect(render({ requirement: requirement({ source: 'runtime' }) })).toContain('paused');
    });

    it('a failed connections read shows the error and never "no connections"', () => {
        const html = render({
            requirement: requirement({ reason: 'ambiguous' }),
            candidates: { state: 'error', error: 'Could not load the connections (500)' },
        });
        expect(html).toContain('Could not load the connections (500)');
        expect(html).not.toContain('type="radio"');
        expect(html).not.toMatch(/no (Jira )?connections/i);
    });

    it('renders an action error and a busy button', () => {
        const html = render({ error: 'The task bindings changed; reload it', busy: 'connect' });
        expect(html).toContain('The task bindings changed; reload it');
        expect(html).toContain('aria-busy="true"');
    });
});
