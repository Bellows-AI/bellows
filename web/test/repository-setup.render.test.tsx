import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { InstallationRepo } from '../src/api/useRepos.js';
import {
    RepositoryConfigDetail,
    RepositoryHeaderMeta,
    RepositoryListNotices,
    RepositorySetupList,
} from '../src/components/RepositorySetup.js';
import { NOT_AVAILABLE } from '../src/components/repository-setup.js';
import { expectNoPlaceholder } from './fixtures.js';

/**
 * The repository components, server-rendered (#159's contract: presentational, no fetching, so a
 * static render is a complete render). The list is the board's tracked repositories — searchable,
 * each with Configure for its environment — and carries no selection, checkout or sync state.
 */

const repo = (overrides: Partial<InstallationRepo> = {}): InstallationRepo => ({
    owner: 'acme',
    name: 'web',
    private: false,
    defaultBranch: 'main',
    pushedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const notices = (overrides: Record<string, unknown> = {}) =>
    render(<RepositoryListNotices cachedError={null} listNotice={null} {...overrides} />);

const list = (overrides: Record<string, unknown> = {}) =>
    render(
        <RepositorySetupList
            repos={[repo()]}
            shown={[repo()]}
            search=""
            onSearch={() => {}}
            configured={null}
            onConfigure={() => {}}
            loaded={true}
            {...overrides}
        />
    );

describe('RepositoryListNotices', () => {
    it('organization and installation access render as inline header meta, not a key-value card', () => {
        const html = render(
            <RepositoryHeaderMeta
                organization="Acme"
                installation={{ account: 'acme', repositorySelection: 'selected' }}
            />
        );
        expect(html).toContain('Organization: Acme');
        expect(html).toContain('Installation: acme — access to selected repositories.');
        expect(html).not.toContain('<dl');
        expect(html).not.toContain('repo-scope');
        expect(render(<RepositoryHeaderMeta organization={null} installation={null} />)).toBe('');
    });

    it('says the list is cached, and why, when the last refresh failed', () => {
        const html = notices({ cachedError: 'GitHub is unreachable' });
        expect(html).toContain('Showing a cached list');
        expect(html).toContain('GitHub is unreachable');
    });

    it('carries the list posture (loading, or a hard failure) when there is one', () => {
        expect(notices({ listNotice: 'Loading repositories…' })).toContain('Loading repositories…');
        expect(notices()).not.toContain('class="status"');
    });

    it('draws no selection cards, root banner or checkout staleness', () => {
        const html = notices();
        for (const gone of ['repo-card', 'Selection summary', 'ORG_WORKSPACE_ROOT', 'Checkout status is stale']) {
            expect(html, gone).not.toContain(gone);
        }
    });
});

describe('RepositorySetupList', () => {
    it('names the list and gives every row its repository, branch and Configure', () => {
        const html = list({ repos: [repo(), repo({ name: 'api', defaultBranch: 'trunk' })] });
        expect(html).toContain('aria-label="Tracked repositories"');
        expect(html).toContain('acme/web');
        expect(html).toContain('>main<');
        expect(html).toMatch(/<button[^>]*>Configure<svg/);
        for (const label of ['Repository', 'Branch']) expect(html).toContain(`<th scope="col">${label}</th>`);
    });

    it('a row shows owner/name, a Public or Private tag and the branch beside its icon', () => {
        const html = list({
            repos: [repo(), repo({ name: 'api', private: true })],
            shown: [repo(), repo({ name: 'api', private: true })],
        });
        expect(html).toMatch(/<span class="pill">Public<\/span>/);
        expect(html).toMatch(/<span class="pill">Private<\/span>/);
        expect(html).not.toContain('>private<');
        expect(html.match(/<td data-label="Repository">.*?<\/td>/)?.[0]).toContain('class="icon"');
        expect(html.match(/<td data-label="Branch">.*?<\/td>/)?.[0]).toContain('class="icon"');
    });

    it('search is an icon field, and Configure keeps one button per row with no nested interactive element', () => {
        const html = list();
        expect(html).toContain('class="search-field"');
        expect(html).toContain('for="repo-setup-search"');
        const row = html.match(/<tbody>.*<\/tbody>/)?.[0] ?? '';
        expect(row.match(/<button/g)).toHaveLength(1);
        expect(row).not.toMatch(/<a[ >]/);
        expect(row).toMatch(/<button[^>]*>Configure<svg/);
        expect(html).toContain('data-compact');
    });

    it('has no selection, save, ceiling, checkout or size surface', () => {
        const html = list({ configured: 'acme/web' });
        for (const gone of [
            'type="checkbox"',
            'Enabled',
            'Save selection',
            'Selection limited to',
            'Checkout status',
            'Last commit',
            'Size',
            'No longer reported by GitHub',
            'Deselect',
        ]) {
            expect(html, gone).not.toContain(gone);
        }
    });

    it('marks a private repository and the configured row for assistive tech', () => {
        const html = list({
            repos: [repo({ private: true })],
            shown: [repo({ private: true })],
            configured: 'acme/web',
        });
        expect(html).toContain('class="pill">Private<');
        expect(html).toContain('aria-current="true"');
    });

    it('never fakes a branch: an unreported default says Not available', () => {
        const html = list({ repos: [repo({ defaultBranch: null })], shown: [repo({ defaultBranch: null })] });
        expect(html).toContain(NOT_AVAILABLE);
        expect(html).not.toContain('—');
        expectNoPlaceholder(html);
    });

    it('says no repositories match only after a successful load, and names the query', () => {
        const html = list({ shown: [], loaded: true, search: 'zzz' });
        expect(html).toContain('No repositories match');
        expect(html).toContain('zzz');
        expect(list({ shown: [], loaded: false })).not.toContain('No repositories match');
    });

    it('explains a successful zero list: the App is installed on nothing, an admin must fix it', () => {
        const html = list({ repos: [], shown: [], loaded: true });
        expect(html).toContain('not installed on any repositories');
        expect(html).toContain('administrator');
        expect(list({ shown: [], loaded: true, search: 'zzz' })).not.toContain('not installed on any repositories');
    });

    it('renders rows under a named, keyboard-focusable region, and rows are not clickable', () => {
        const html = list();
        expect(html).toContain('aria-label="Repositories"');
        expect(html).toContain('tabindex="0"');
        expect(html).not.toMatch(/<tr[^>]*onclick/i);
    });
});

describe('RepositoryConfigDetail', () => {
    it('renders nothing before a repository is chosen — no empty panel', () => {
        expect(render(<RepositoryConfigDetail repo={null} />)).toBe('');
    });

    it('heads with the chosen repository and leaves the scope truth to the editor below (rendered once there)', () => {
        const html = render(<RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} />);
        expect(html).toContain('Selected repository: acme/web');
        expect(html).not.toContain('scope-context');
        expect(html).not.toContain('rightmost scope wins');
    });

    it('carries no checkout facts — nothing is checked out on the board', () => {
        const html = render(<RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} />);
        for (const gone of ['<h3>Checkout</h3>', 'Checkout status', 'Package cache', 'Last commit', NOT_AVAILABLE]) {
            expect(html, gone).not.toContain(gone);
        }
    });

    it('renders the environment editor it is handed', () => {
        const html = render(
            <RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }}>
                <p>EDITOR</p>
            </RepositoryConfigDetail>
        );
        expect(html).toContain('EDITOR');
    });

    it("carries no switch blocker of its own — the guarded switch is the area dialog's (issue 182)", () => {
        const html = render(<RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} />);
        expect(html).not.toContain('unsaved');
        expect(html).not.toContain('Discard');
    });
});
