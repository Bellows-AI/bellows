import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createSkill,
    deleteSkill,
    downloadZip,
    editSkillMd,
    getBuiltin,
    getSkill,
    listCatalog,
    listSkills,
    promote,
    setBuiltinEnabled,
    setEnabled,
    uploadVersion,
} from '../src/api/skills.js';

/** The skills client's wire contract: strict reads, refusals as sent, and the zip create's URL. */

const VERSION = {
    id: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    size: 12,
    description: 'Does a thing',
    createdAt: '2026-11-01T10:00:00.000Z',
    author: { id: 'u1', login: 'ada' },
};
const row = (over: Record<string, unknown> = {}) => ({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'deploy',
    scope: 'workspace',
    enabled: true,
    createdBy: 'u1',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    current: VERSION,
    ...over,
});
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (respond: (url: string, init?: RequestInit) => Response) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return respond(url, init);
        })
    );
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('reads', () => {
    it('lists a door and parses every row', async () => {
        const calls = stubFetch(() => json({ skills: [row(), row({ id: '33333333-3333-4333-8333-333333333333' })] }));
        const result = await listSkills('org');
        expect(calls[0]?.url).toBe('/api/org/skills');
        expect(result.ok && result.skills.map((s) => s.name)).toEqual(['deploy', 'deploy']);
    });

    it('accepts a null author', async () => {
        stubFetch(() => json({ skills: [row({ current: { ...VERSION, author: null } })] }));
        const result = await listSkills('workspace');
        expect(result.ok && result.skills[0]?.current.author).toBeNull();
    });

    it('fails the whole list on one malformed row, never filtering it out', async () => {
        stubFetch(() => json({ skills: [row(), row({ enabled: 'yes' })] }));
        const result = await listSkills('workspace');
        expect(result.ok).toBe(false);
    });

    it('fails on a row whose version is missing a field', async () => {
        stubFetch(() => json({ skills: [row({ current: { ...VERSION, sha256: undefined } })] }));
        expect((await listSkills('workspace')).ok).toBe(false);
    });

    it('fails on a body with no skills array', async () => {
        stubFetch(() => json({}));
        expect((await listSkills('workspace')).ok).toBe(false);
    });

    it('turns a 503 into a failure carrying the route message and code', async () => {
        stubFetch(() => json({ error: 'The skill store is unavailable', code: 'UNAVAILABLE' }, 503));
        const result = await listSkills('org');
        expect(result).toMatchObject({ ok: false, error: 'The skill store is unavailable', code: 'UNAVAILABLE' });
    });

    it('turns a network error into a failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline');
            })
        );
        expect(await listSkills('org')).toMatchObject({ ok: false, error: 'offline' });
    });

    it('gets a skill with its SKILL.md and file list', async () => {
        const calls = stubFetch(() => json({ skill: row(), skillMd: '# hi', files: [{ path: 'SKILL.md', size: 4 }] }));
        const result = await getSkill('workspace', 'abc');
        expect(calls[0]?.url).toBe('/api/workspace/skills/abc');
        expect(result.ok && result.skillMd).toBe('# hi');
        expect(result.ok && result.files).toEqual([{ path: 'SKILL.md', size: 4 }]);
        expect(result.ok && result.skill.id).toBe(row().id);
    });

    it('fails a get whose files are malformed', async () => {
        stubFetch(() => json({ skill: row(), skillMd: '', files: [{ path: 'a' }] }));
        expect((await getSkill('org', 'abc')).ok).toBe(false);
    });

    it('gets a built-in with its release version', async () => {
        const calls = stubFetch(() =>
            json({
                name: 'factory-jira',
                description: 'd',
                requires: { tools: [], connections: [] },
                skillMd: '# j',
                files: [{ path: 'SKILL.md', size: 3 }],
                version: '0.0.16',
            })
        );
        const result = await getBuiltin('factory-jira');
        expect(calls[0]?.url).toBe('/api/skills/builtin/factory-jira');
        expect(result.ok && result.builtin.version).toBe('0.0.16');
    });

    it('lists the catalog including a switched-off built-in and its requirements', async () => {
        const calls = stubFetch(() =>
            json({
                skills: [
                    {
                        name: 'factory-jira',
                        description: 'd',
                        source: 'builtin',
                        switchedOff: true,
                        requires: {
                            tools: [],
                            connections: [{ name: 'jira', env: [], selectedBy: 'connections' }],
                        },
                    },
                    {
                        name: 'x',
                        description: 'd',
                        source: 'org',
                        shadowedBy: 'workspace',
                        requires: { tools: ['Bash'], connections: [] },
                    },
                ],
            })
        );
        const result = await listCatalog();
        expect(calls[0]?.url).toBe('/api/skills');
        expect(result.ok && result.skills[0]?.switchedOff).toBe(true);
        expect(result.ok && result.skills[1]?.shadowedBy).toBe('workspace');
    });

    it('fails the catalog on a malformed entry', async () => {
        stubFetch(() => json({ skills: [{ name: 'x', description: 'd', source: 'nowhere', requires: {} }] }));
        expect((await listCatalog()).ok).toBe(false);
    });
});

describe('writes', () => {
    it('creates from SKILL.md as JSON with the name in the body', async () => {
        const calls = stubFetch(() => json({ skill: row() }, 201));
        const result = await createSkill('workspace', { name: 'deploy', skillMd: '# x' });
        expect(calls[0]?.url).toBe('/api/workspace/skills');
        expect(calls[0]?.init?.method).toBe('POST');
        expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'deploy', skillMd: '# x' });
        expect(result.ok && result.skill.name).toBe('deploy');
    });

    it('creates from a zip with no name parameter', async () => {
        const calls = stubFetch(() => json({ skill: row() }, 201));
        const zip = new File([new Uint8Array([1, 2])], 'bundle.zip', { type: 'application/zip' });
        await createSkill('org', { zip });
        expect(calls[0]?.url).toBe('/api/org/skills');
        expect(calls[0]?.url).not.toContain('name');
        expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/zip');
        expect(calls[0]?.init?.body).toBe(zip);
    });

    it('carries error, code and reason of a refusal', async () => {
        stubFetch(() => json({ error: 'bad bundle', code: 'SKILL_BUNDLE_INVALID', reason: 'name_mismatch' }, 422));
        const result = await createSkill('org', { zip: new File([], 'a.zip') });
        expect(result).toEqual({
            ok: false,
            error: 'bad bundle',
            code: 'SKILL_BUNDLE_INVALID',
            reason: 'name_mismatch',
        });
    });

    it('edits SKILL.md against the version it was read on', async () => {
        const calls = stubFetch(() => json({ skill: row() }, 201));
        await editSkillMd('workspace', 'abc', '# y', VERSION.id);
        expect(calls[0]?.url).toBe('/api/workspace/skills/abc/versions');
        expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ skillMd: '# y', baseVersionId: VERSION.id });
    });

    it('surfaces a stale edit as its code', async () => {
        stubFetch(() => json({ error: 'changed', code: 'SKILL_VERSION_STALE' }, 409));
        const result = await editSkillMd('org', 'abc', '# y', VERSION.id);
        expect(result).toMatchObject({ ok: false, code: 'SKILL_VERSION_STALE' });
    });

    it('uploads a zip as a new version', async () => {
        const calls = stubFetch(() => json({ skill: row() }, 201));
        const zip = new File([], 'a.zip');
        await uploadVersion('org', 'abc', zip);
        expect(calls[0]?.url).toBe('/api/org/skills/abc/versions');
        expect(calls[0]?.init?.body).toBe(zip);
    });

    it('switches a skill and a built-in', async () => {
        const calls = stubFetch((url) =>
            url.includes('builtin') ? json({ name: 'factory-jira', enabled: false }) : json({ skill: row() })
        );
        await setEnabled('workspace', 'abc', false);
        const builtin = await setBuiltinEnabled('factory-jira', false);
        expect(calls[0]?.url).toBe('/api/workspace/skills/abc/enabled');
        expect(calls[0]?.init?.method).toBe('PUT');
        expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: false });
        expect(calls[1]?.url).toBe('/api/org/skills/builtin/factory-jira/enabled');
        expect(builtin.ok).toBe(true);
    });

    it('deletes on 204 and refuses with the 410 code', async () => {
        stubFetch(() => new Response(null, { status: 204 }));
        expect(await deleteSkill('org', 'abc')).toEqual({ ok: true });
        stubFetch(() => json({ error: 'gone', code: 'SKILL_GONE' }, 410));
        expect(await deleteSkill('org', 'abc')).toMatchObject({ ok: false, code: 'SKILL_GONE' });
    });

    it('promotes to the organization', async () => {
        const calls = stubFetch(() => json({ skill: row({ scope: 'org' }) }));
        const result = await promote('abc');
        expect(calls[0]?.url).toBe('/api/workspace/skills/abc/scope');
        expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ scope: 'org' });
        expect(result.ok && result.skill.scope).toBe('org');
    });

    it('reports a promote name clash with its code', async () => {
        stubFetch(() => json({ error: 'taken', code: 'NAME_TAKEN' }, 409));
        expect(await promote('abc')).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    });
});

describe('downloadZip', () => {
    const stubDom = () => {
        const click = vi.fn();
        const anchor = { href: '', download: '', click };
        vi.stubGlobal('document', {
            createElement: () => anchor,
            body: { append: vi.fn(), removeChild: vi.fn() },
        });
        const create = vi.fn(() => 'blob:x');
        const revoke = vi.fn();
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
        return { anchor, click, create };
    };

    it('clicks a named anchor on a 200', async () => {
        const dom = stubDom();
        const calls = stubFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
        expect(await downloadZip('workspace', 'abc', 'deploy')).toEqual({ ok: true });
        expect(calls[0]?.url).toBe('/api/workspace/skills/abc/zip');
        expect(dom.anchor.download).toBe('deploy.zip');
        expect(dom.click).toHaveBeenCalledOnce();
    });

    it('returns the refusal and never clicks on a non-200', async () => {
        const dom = stubDom();
        stubFetch(() => json({ error: 'gone', code: 'SKILL_GONE' }, 410));
        expect(await downloadZip('org', 'abc', 'deploy')).toMatchObject({ ok: false, code: 'SKILL_GONE' });
        expect(dom.click).not.toHaveBeenCalled();
        expect(dom.create).not.toHaveBeenCalled();
    });
});
