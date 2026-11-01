import { integrationProvider } from '../settings/integration-providers.js';

/**
 * A provider's mark: one flat, single-color glyph filled with the provider's `--brand-<id>` token
 * (`styles/tokens.css`, defined for both themes), on a neutral tile (`.provider-mark`, `styles/regions/settings.css`).
 * Outside the frozen `Icon` set: these are brands, not interface glyphs, and they keep their color in both themes.
 *
 * Source and licence of every path below: drawn for this repository as simplified geometric glyphs, 24x24 grid.
 * No third-party artwork or trademark vector is copied, so nothing here carries a third-party licence; swap in
 * the vendor's own asset (and record its source and licence at the path) when a brand kit is licensed.
 */

const GLYPHS: Record<string, string> = {
    // Three stacked chevrons.
    jira: 'M12 2 20 10l-3 3-5-5-5 5-3-3zM12 8l8 8-3 3-5-5-5 5-3-3z',
    // A hash: two vertical and two horizontal rounded bars.
    slack: 'M8 3h2v18H8zM14 3h2v18h-2zM3 8h18v2H3zM3 14h18v2H3z',
    // A speech bubble with two eyes.
    discord:
        'M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5l-2 3-2-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm3.5 4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm7 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z',
    // A disc with a ring cut out of it.
    github: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
    // A fox-head triangle with two ears.
    gitlab: 'M12 21 3 13l2-8 3 6h8l3-6 2 8z',
    // Two interlocked links.
    mcp: 'M3 8a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v2h-2V8a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v2H6a3 3 0 0 1-3-3zm9 3h6a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3v-2h2v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-6z',
};

export function ProviderMark({ provider }: { provider: string }) {
    const path = GLYPHS[provider];
    const name = integrationProvider(provider)?.label ?? provider;
    return (
        <svg
            className="provider-mark"
            data-provider={provider}
            role="img"
            aria-label={`${name} logo`}
            viewBox="0 0 24 24"
            fill={`var(--brand-${provider})`}
            fillRule="evenodd"
        >
            {path ? <path d={path} /> : null}
        </svg>
    );
}
