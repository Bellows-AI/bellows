import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWorkflows } from '../src/api/useWorkflows.js';
import { stubFetch } from './dom.js';

/** The repository context rides `?repo=` as the repo's ref text, URL-encoded (a pin: GitHub's text is `owner/name`). */
describe('useWorkflows — the repository context on the wire', () => {
    it.each([
        ['acme/web', '/api/workflows?repo=acme%2Fweb'],
        ['gitlab:gl.example/g/sub/p', '/api/workflows?repo=gitlab%3Agl.example%2Fg%2Fsub%2Fp'],
    ])('asks for %s', async (repo, url) => {
        const calls = stubFetch(() => ({ workflows: [] }));
        const { result } = renderHook(() => useWorkflows(repo));
        await waitFor(() => expect(result.current.workflows).toEqual([]));
        expect(calls.map((c) => c.url)).toEqual([url]);
    });
});
