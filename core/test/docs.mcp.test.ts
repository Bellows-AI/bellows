import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The MCP client-support record in docs/mcp.md. GUI clients ship with defaults, so what is known to work and what is
 * not verified are stated limits; a doc edit that drops one fails here instead of in a person's connector dialog.
 * Whitespace-sensitive: each pin is one sentence of the doc.
 */

const mcpDoc = readFileSync(new URL('../../docs/mcp.md', import.meta.url), 'utf8');
const prose = (text: string): string => text.replace(/\s+/g, ' ');
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('the MCP client-support record', () => {
    it('names the clients known to work', () => {
        expect(prose(mcpDoc)).toContain('**Known to work:** the SDK v2 client on `2026-07-28`');
        expect(prose(mcpDoc)).toContain('headless Claude Code');
    });

    it('states that the GUI clients are unverified', () => {
        expect(prose(mcpDoc)).toContain('**Stated limit: GUI clients are unverified.**');
        for (const client of ['claude.ai', 'Claude Desktop', 'Cursor', 'VS Code']) expect(mcpDoc).toContain(client);
    });

    it('states that no lane runs headless Claude Code', () => {
        expect(prose(mcpDoc)).toContain('**Stated limit: headless Claude Code is not run by any lane.**');
    });

    it('states the attachment and deadline limits', () => {
        expect(prose(mcpDoc)).toContain('**Stated limit: no file bytes through MCP.**');
        expect(prose(mcpDoc)).toContain('**Stated limit: a call ends at 55 s**');
    });

    it('anchors every client-support path to a file that exists', () => {
        const section = mcpDoc.slice(mcpDoc.indexOf('## Connecting a client'), mcpDoc.indexOf('## Invariants'));
        const paths = [...section.matchAll(/`((?:e2e|scripts|server|web|core)\/[\w./-]+\.\w+)/g)].map(
            (m) => m[1] ?? ''
        );
        expect(paths.length).toBeGreaterThan(4);
        for (const path of paths) expect(existsSync(`${root}/${path}`), path).toBe(true);
    });
});
