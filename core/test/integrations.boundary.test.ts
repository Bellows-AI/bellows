import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CredentialSource } from '../src/integrations/operation.js';

const DIR = new URL('../src/integrations/', import.meta.url);

describe('integrations portable boundary', () => {
    it('the portable credential type exposes only accessToken, expiresAt, authority', async () => {
        const source: CredentialSource = {
            acquire: async () => ({
                ok: true,
                credential: { accessToken: 't', expiresAt: 1, authority: { scopes: ['a'] } },
            }),
        };
        const r = await source.acquire(new AbortController().signal);
        if (!r.ok) throw new Error('fixture source must succeed');
        expect(Object.keys(r.credential).sort()).toEqual(['accessToken', 'authority', 'expiresAt']);
        expect(Object.keys(r.credential.authority)).toEqual(['scopes']);
    });

    // A ratchet: it passes while the layer is small and refuses the change that lets a long-lived
    // credential cross into the portable layer.
    it('no core/src/integrations file names a long-lived credential', () => {
        const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            expect(readFileSync(new URL(f, DIR), 'utf8'), f).not.toMatch(/refresh_?token|client_?secret/i);
        }
    });

    it('no core/src/integrations file imports server or secrets code', () => {
        for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ts'))) {
            const imports = [...readFileSync(new URL(f, DIR), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
                (m) => m[1] ?? ''
            );
            for (const spec of imports) expect(spec, f).not.toMatch(/server|secret|skills/);
        }
    });
});
