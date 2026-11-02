// biome-ignore lint/correctness/useImportExtensions: a Vite `?raw` query, not a module path
import tokensCss from '../../web/src/styles/tokens.css?raw';

/**
 * The token explorer: `web/src/styles/tokens.css` read as text, never copied, so a token added
 * there appears here with no edit. Each custom property of the two palette blocks (dark `:root`,
 * `:root[data-theme="light"]`) is one row: its name, both authored values, and a swatch that
 * resolves the live token under whichever theme the page is showing.
 */

export interface TokenRow {
    name: string;
    dark: string;
    light: string;
}

const blockBody = (css: string, opener: string): string => {
    const start = css.indexOf(opener);
    if (start === -1) return '';
    const open = css.indexOf('{', start);
    const close = css.indexOf('\n}', open);
    return css.slice(open + 1, close);
};

const declarations = (body: string): Map<string, string> => {
    const found = new Map<string, string>();
    for (const match of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
        found.set(match[1] as string, (match[2] as string).trim());
    }
    return found;
};

/** Tokens of the dark block, each paired with its light value ("—" where the light block omits it). */
export const readTokens = (css: string): TokenRow[] => {
    const dark = declarations(blockBody(css, ':root {'));
    const light = declarations(blockBody(css, ':root[data-theme="light"]'));
    return [...dark].map(([name, value]) => ({ name, dark: value, light: light.get(name) ?? '—' }));
};

const TOKENS = readTokens(tokensCss);

export function TokenExplorer() {
    return (
        <section aria-labelledby="specimen-tokens-title" className="specimen-block">
            <h2 id="specimen-tokens-title">Tokens</h2>
            <table className="specimen-tokens">
                <thead>
                    <tr>
                        <th scope="col">Token</th>
                        <th scope="col">Dark</th>
                        <th scope="col">Light</th>
                        <th scope="col">Live</th>
                    </tr>
                </thead>
                <tbody>
                    {TOKENS.map((token) => (
                        <tr key={token.name} data-token={token.name}>
                            <th scope="row" className="mono">
                                {token.name}
                            </th>
                            <td className="mono">{token.dark}</td>
                            <td className="mono">{token.light}</td>
                            <td>
                                <span className="specimen-swatch" style={{ background: `var(${token.name})` }} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}
