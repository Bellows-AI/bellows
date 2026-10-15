import { describe, expect, it, vi } from 'vitest';

const { randomUUID } = vi.hoisted(() => ({ randomUUID: vi.fn<() => string>() }));
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    randomUUID.mockImplementation(actual.randomUUID);
    return { ...actual, randomUUID };
});

const { randomGithubId, testOrg } = await import('../test-db/fixtures.js');

describe('generated ids', () => {
    it('never repeats a github id or an org id within the process', () => {
        const repeated = '0000beef-0000-4000-8000-000000000000';
        randomUUID.mockReturnValueOnce(repeated).mockReturnValueOnce(repeated);
        const first = randomGithubId();
        expect(randomGithubId()).not.toBe(first);

        randomUUID.mockReturnValueOnce(repeated);
        expect(testOrg()).not.toBe(String(first));
    });
});
