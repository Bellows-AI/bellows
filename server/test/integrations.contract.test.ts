import { readdirSync, readFileSync } from 'node:fs';
import { runOperation } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    FAKE_TOKEN,
    fakeCredentials,
    fakeDefinition,
    fakeFetch,
    fakeHandle,
    fakeReadItem,
} from './integrations-fake-provider.js';

const CORE_DIR = new URL('../../core/src/integrations/', import.meta.url);

/** Every module specifier the portable layer imports. */
const imports = (): string[] =>
    readdirSync(CORE_DIR)
        .filter((f) => f.endsWith('.ts'))
        .flatMap((f) =>
            [...readFileSync(new URL(f, CORE_DIR), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '')
        );

describe('integration backend contract', () => {
    it('backend invokes the fake operation adapter with an injected credential source, no skill loaded', async () => {
        const fetch = fakeFetch({ id: '7' });
        const r = await runOperation(
            fakeDefinition,
            fakeReadItem,
            { handle: fakeHandle(), credentials: fakeCredentials(), fetch, deadlineMs: 1000 },
            '7'
        );
        expect(r).toEqual({ ok: true, value: { id: '7' } });
        expect(fetch.calls).toEqual([
            { url: 'https://acme.fake.test/rest/items/7', authorization: `Bearer ${FAKE_TOKEN}` },
        ]);
        // The definition names skills; running an operation never reads one.
        expect(fakeDefinition.skills).toEqual(['fake']);
        // Every import stays inside the layer: no skills parser, no filesystem, no server code.
        expect(imports().filter((spec) => !/^\.{1,2}\/[a-z-]+\.js$/.test(spec))).toEqual([]);
        expect(imports().filter((spec) => /skills/.test(spec))).toEqual([]);
    });

    it('the adapter receives a handle, never a secret ref', () => {
        const handle = fakeHandle();
        expect(Object.keys(handle).sort()).toEqual(['authority', 'connectionId', 'provider', 'resource']);
        expect(JSON.stringify(handle)).not.toMatch(/secret/i);
    });
});
