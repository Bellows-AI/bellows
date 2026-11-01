import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderMark } from '../src/components/ProviderMark.js';
import { INTEGRATION_PROVIDERS } from '../src/settings/integration-providers.js';

describe('ProviderMark', () => {
    it.each(INTEGRATION_PROVIDERS.map((provider) => [provider.id, provider.label] as const))(
        'draws %s as a labelled image filled with its brand token',
        (id, label) => {
            const html = renderToStaticMarkup(<ProviderMark provider={id} />);
            expect(html).toContain('role="img"');
            expect(html).toContain(`aria-label="${label} logo"`);
            expect(html).toContain(`fill="var(--brand-${id})"`);
            expect(html).toContain('<path d="');
        }
    );

    it.each([
        ['jira', '0 0 24 24'],
        ['slack', '0 0 127 127'],
        ['discord', '0 0 24 24'],
        ['github', '0 0 24 24'],
        ['gitlab', '0 0 24 24'],
        ['mcp', '0 0 24 24'],
    ])('draws the official %s mark on its own grid, filled nonzero as published', (id, viewBox) => {
        const html = renderToStaticMarkup(<ProviderMark provider={id} />);
        expect(html).toContain(`viewBox="${viewBox}"`);
        expect(html).not.toContain('evenodd');
    });
});
