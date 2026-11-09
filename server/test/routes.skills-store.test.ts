import { MAX_SKILL_FILE_BYTES } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRepoSource } from '../src/github/repo-source.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NO_CONTENT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_PAYLOAD_TOO_LARGE,
    HTTP_UNAVAILABLE,
    trackApps,
} from './helpers-http.js';
import { listingClient } from './helpers-app-client.js';
import { memorySkillStore, type MemorySkillStore } from './helpers-skill-store.js';

/**
 * Offline: the HTTP contract of the org and workspace skill routes against the in-memory store double. The store's own
 * owner rules run against Postgres in server/test-db/skill-store.test.ts.
 */

const track = trackApps();
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;

const skillMd = (name: string, description = 'Does a thing.'): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

/** A stored (uncompressed) zip: enough for the codec, which does not check CRCs. */
function zip(entries: { name: string; data: string }[]): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    const u16 = (n: number) => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(n);
        return b;
    };
    const u32 = (n: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n >>> 0);
        return b;
    };
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const data = Buffer.from(entry.data);
        const local = Buffer.concat([
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(data.length),
            u32(data.length),
            u16(name.length),
            u16(0),
            name,
            data,
        ]);
        central.push(
            Buffer.concat([
                u32(0x02014b50),
                u16((3 << 8) | 20),
                u16(20),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(0),
                u32(data.length),
                u32(data.length),
                u16(name.length),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(0o100644 << 16),
                u32(offset),
                name,
            ])
        );
        chunks.push(local);
        offset += local.length;
    }
    const directory = Buffer.concat(central);
    return Buffer.concat([
        ...chunks,
        directory,
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(entries.length),
        u16(entries.length),
        u32(directory.length),
        u32(offset),
        u16(0),
    ]);
}

async function boot(
    skills: MemorySkillStore = memorySkillStore(),
    extra: Pick<NonNullable<Parameters<typeof staticRegistry>[0]>, 'repos' | 'repoSkills'> = {}
) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, skills, telemetry: stubTelemetryClient(), ...extra }),
        auth,
    });
    track(instance);
    const as = async (caller: typeof admin) => ({ cookie: await signedIn(auth, caller) });
    return {
        instance,
        skills,
        admin: await as(admin),
        member: await as(member),
        other: await as(other),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function publish(
    booted: Booted,
    prefix: '/api/org/skills' | '/api/workspace/skills',
    headers: { cookie: string },
    name: string
): Promise<string> {
    const response = await booted.instance.inject({
        method: 'POST',
        url: prefix,
        headers,
        payload: { name, skillMd: skillMd(name) },
    });
    expect(response.statusCode).toBe(HTTP_CREATED);
    return response.json().skill.id;
}

describe('org skills: permissions', () => {
    it('a member lists org skills but cannot write them; an admin can', async () => {
        const booted = await boot();
        const { instance, admin, member } = booted;
        const denied = [
            { method: 'POST', url: '/api/org/skills', payload: { name: 'deploy', skillMd: skillMd('deploy') } },
            { method: 'DELETE', url: '/api/org/skills/00000000-0000-4000-8000-000000000001' },
            {
                method: 'PUT',
                url: '/api/org/skills/00000000-0000-4000-8000-000000000001/enabled',
                payload: { enabled: false },
            },
            {
                method: 'POST',
                url: '/api/org/skills/00000000-0000-4000-8000-000000000001/versions',
                payload: { skillMd: skillMd('deploy') },
            },
        ] as const;
        for (const request of denied) {
            const response = await instance.inject({ ...request, headers: member });
            expect(response.statusCode, `${request.method} ${request.url}`).toBe(HTTP_FORBIDDEN);
        }
        expect(await booted.skills.listOrg()).toEqual([]);

        await publish(booted, '/api/org/skills', admin, 'deploy');
        const listed = await instance.inject({ method: 'GET', url: '/api/org/skills', headers: member });
        expect(listed.statusCode).toBe(HTTP_OK);
        expect(listed.json().skills).toEqual([
            expect.objectContaining({ name: 'deploy', scope: 'org', enabled: true }),
        ]);
    });

    it('promotes a workspace skill to the org for an admin only', async () => {
        const booted = await boot();
        const { instance, admin, member } = booted;
        const id = await publish(booted, '/api/workspace/skills', member, 'shared-tool');

        const refused = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/scope`,
            headers: member,
            payload: { scope: 'org' },
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        expect(await booted.skills.listOrg()).toEqual([]);

        // The admin's workspace door does not reach the member's skill: it is not theirs to promote.
        const foreign = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/scope`,
            headers: admin,
            payload: { scope: 'org' },
        });
        expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);

        const adminOwn = await publish(booted, '/api/workspace/skills', admin, 'admin-tool');
        const promoted = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${adminOwn}/scope`,
            headers: admin,
            payload: { scope: 'org' },
        });
        expect(promoted.statusCode).toBe(HTTP_OK);
        expect(promoted.json().skill).toEqual(expect.objectContaining({ name: 'admin-tool', scope: 'org' }));
    });

    it('refuses a promote whose name an org skill already holds with 409', async () => {
        const booted = await boot();
        const { instance, admin } = booted;
        await publish(booted, '/api/org/skills', admin, 'taken');
        const id = await publish(booted, '/api/workspace/skills', admin, 'taken');
        const response = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/scope`,
            headers: admin,
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('NAME_TAKEN');
    });

    it('rejects a scope other than org', async () => {
        const booted = await boot();
        const id = await publish(booted, '/api/workspace/skills', booted.admin, 'tool');
        const response = await booted.instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/scope`,
            headers: booted.admin,
            payload: { scope: 'workspace' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_SCOPE');
    });
});

describe('workspace skills: ownership', () => {
    it('keeps one member out of another member’s skill on every route', async () => {
        const booted = await boot();
        const { instance, member, other } = booted;
        const id = await publish(booted, '/api/workspace/skills', member, 'mine');

        const own = await instance.inject({ method: 'GET', url: '/api/workspace/skills', headers: other });
        expect(own.json().skills).toEqual([]);

        const attempts = [
            { method: 'GET', url: `/api/workspace/skills/${id}` },
            { method: 'DELETE', url: `/api/workspace/skills/${id}` },
            { method: 'PUT', url: `/api/workspace/skills/${id}/enabled`, payload: { enabled: false } },
            { method: 'POST', url: `/api/workspace/skills/${id}/versions`, payload: { skillMd: skillMd('mine') } },
            { method: 'GET', url: `/api/org/skills/${id}` },
        ] as const;
        for (const attempt of attempts) {
            const response = await instance.inject({ ...attempt, headers: other });
            expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(HTTP_NOT_FOUND);
            expect(response.json().code).toBe('SKILL_NOT_FOUND');
        }
        const still = await instance.inject({ method: 'GET', url: `/api/workspace/skills/${id}`, headers: member });
        expect(still.statusCode).toBe(HTTP_OK);
    });

    it('reads the SKILL.md text and the file list', async () => {
        const booted = await boot();
        const id = await publish(booted, '/api/workspace/skills', booted.member, 'reader');
        const response = await booted.instance.inject({
            method: 'GET',
            url: `/api/workspace/skills/${id}`,
            headers: booted.member,
        });
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.skillMd).toBe(skillMd('reader'));
        expect(body.files).toEqual([{ path: 'SKILL.md', size: Buffer.byteLength(skillMd('reader')) }]);
        expect(JSON.stringify(body)).not.toContain('objectKey');
    });

    it('answers 410 when the stored object is gone and 503 when the store is down, never an empty skill', async () => {
        const booted = await boot();
        const id = await publish(booted, '/api/workspace/skills', booted.member, 'fragile');
        booted.skills.loseObjects();
        const gone = await booted.instance.inject({
            method: 'GET',
            url: `/api/workspace/skills/${id}`,
            headers: booted.member,
        });
        expect(gone.statusCode).toBe(HTTP_GONE);
        expect(gone.json().code).toBe('SKILL_GONE');

        booted.skills.breakAll();
        for (const url of ['/api/workspace/skills', `/api/workspace/skills/${id}`, '/api/skills']) {
            const down = await booted.instance.inject({ method: 'GET', url, headers: booted.member });
            expect(down.statusCode, url).toBe(HTTP_UNAVAILABLE);
        }
    });
});

describe('skill writes', () => {
    it('creates from an inline SKILL.md and from a zip, and adds versions', async () => {
        const booted = await boot();
        const { instance, member } = booted;
        const upload = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills?name=zipped',
            headers: { ...member, 'content-type': 'application/zip' },
            payload: zip([
                { name: 'SKILL.md', data: skillMd('zipped') },
                { name: 'scripts/run.sh', data: 'echo hi\n' },
            ]),
        });
        expect(upload.statusCode).toBe(HTTP_CREATED);
        const id = upload.json().skill.id;
        const read = (
            await instance.inject({ method: 'GET', url: `/api/workspace/skills/${id}`, headers: member })
        ).json();
        expect(read.files.map((file: { path: string }) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh']);

        const changed = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/versions`,
            headers: member,
            payload: { skillMd: skillMd('zipped', 'Changed.'), baseVersionId: read.skill.current.id },
        });
        expect(changed.statusCode).toBe(HTTP_CREATED);
        expect(changed.json().skill.current.description).toBe('Changed.');

        const same = await instance.inject({
            method: 'POST',
            url: `/api/workspace/skills/${id}/versions`,
            headers: member,
            payload: { skillMd: skillMd('zipped', 'Changed.'), baseVersionId: changed.json().skill.current.id },
        });
        expect(same.statusCode).toBe(HTTP_OK);
    });

    it('maps a codec refusal to 422 with its stable reason', async () => {
        const { instance, member } = await boot();
        const traversal = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills?name=evil',
            headers: { ...member, 'content-type': 'application/zip' },
            payload: zip([
                { name: 'SKILL.md', data: skillMd('evil') },
                { name: '../x', data: 'x' },
            ]),
        });
        expect(traversal.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(traversal.json()).toEqual(
            expect.objectContaining({ code: 'SKILL_BUNDLE_INVALID', reason: 'traversal' })
        );

        const mismatch = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills',
            headers: member,
            payload: { name: 'one', skillMd: skillMd('two') },
        });
        expect(mismatch.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(mismatch.json().reason).toBe('name_mismatch');

        const notZip = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills?name=junk',
            headers: { ...member, 'content-type': 'application/zip' },
            payload: Buffer.from('not a zip at all'),
        });
        expect(notZip.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(notZip.json().reason).toBe('not_zip');
    });

    it('refuses a reserved name, a clash and a malformed body', async () => {
        const booted = await boot();
        const { instance, member } = booted;
        const reserved = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills',
            headers: member,
            payload: { name: 'factory-x', skillMd: skillMd('factory-x') },
        });
        expect(reserved.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(reserved.json().reason).toBe('reserved_name');

        await publish(booted, '/api/workspace/skills', member, 'dup');
        const clash = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills',
            headers: member,
            payload: { name: 'dup', skillMd: skillMd('dup') },
        });
        expect(clash.statusCode).toBe(HTTP_CONFLICT);
        expect(clash.json().code).toBe('NAME_TAKEN');

        for (const payload of [{}, { name: 'x' }, { name: 5, skillMd: 'a' }, { name: 'x', skillMd: 5 }]) {
            const response = await instance.inject({
                method: 'POST',
                url: '/api/workspace/skills',
                headers: member,
                payload,
            });
            expect(response.statusCode, JSON.stringify(payload)).toBe(HTTP_BAD_REQUEST);
        }
        const noName = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills',
            headers: { ...member, 'content-type': 'application/zip' },
            payload: zip([{ name: 'SKILL.md', data: skillMd('x') }]),
        });
        expect(noName.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('allows a workspace skill to share an org skill’s name', async () => {
        const booted = await boot();
        await publish(booted, '/api/org/skills', booted.admin, 'same');
        await publish(booted, '/api/workspace/skills', booted.admin, 'same');
    });

    it('enables, disables and soft-deletes', async () => {
        const booted = await boot();
        const { instance, member } = booted;
        const id = await publish(booted, '/api/workspace/skills', member, 'toggle');
        const off = await instance.inject({
            method: 'PUT',
            url: `/api/workspace/skills/${id}/enabled`,
            headers: member,
            payload: { enabled: false },
        });
        expect(off.statusCode).toBe(HTTP_OK);
        expect(off.json().skill.enabled).toBe(false);
        const bad = await instance.inject({
            method: 'PUT',
            url: `/api/workspace/skills/${id}/enabled`,
            headers: member,
            payload: { enabled: 'no' },
        });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);

        const del = await instance.inject({ method: 'DELETE', url: `/api/workspace/skills/${id}`, headers: member });
        expect(del.statusCode).toBe(HTTP_NO_CONTENT);
        const again = await instance.inject({ method: 'DELETE', url: `/api/workspace/skills/${id}`, headers: member });
        expect(again.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('refuses a zip body past the skill size cap', async () => {
        const { instance, member } = await boot();
        const response = await instance.inject({
            method: 'POST',
            url: '/api/workspace/skills?name=huge',
            headers: { ...member, 'content-type': 'application/zip' },
            payload: Buffer.alloc(6 * 1024 * 1024),
        });
        expect(response.statusCode).toBe(HTTP_PAYLOAD_TOO_LARGE);
    });
});

describe('/api/skills catalog', () => {
    it('POST /api/org/skills with an unknown connection is 422 with reason unknown_connection', async () => {
        const { instance, admin } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/org/skills',
            headers: admin,
            payload: {
                name: 'needs-nosuch',
                skillMd: skillMd('needs-nosuch').replace(
                    '---\n\nBody',
                    'metadata:\n  requires-connections: nosuch\n---\n\nBody'
                ),
            },
        });
        expect(res.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(res.json()).toEqual(
            expect.objectContaining({ code: 'SKILL_BUNDLE_INVALID', reason: 'unknown_connection' })
        );
        const listed = await instance.inject({ method: 'GET', url: '/api/org/skills', headers: admin });
        expect(listed.json().skills ?? []).toHaveLength(0);
    });

    it("GET /api/skills lists a stored skill's connections", async () => {
        const { instance, admin, member } = await boot();
        const md = skillMd('needs-jira').replace('---\n\nBody', 'metadata:\n  requires-connections: jira\n---\n\nBody');
        const made = await instance.inject({
            method: 'POST',
            url: '/api/org/skills',
            headers: admin,
            payload: { name: 'needs-jira', skillMd: md },
        });
        expect(made.statusCode).toBe(HTTP_CREATED);
        const skills = (await instance.inject({ method: 'GET', url: '/api/skills', headers: member })).json().skills;
        const entry = skills.find((e: { name: string }) => e.name === 'needs-jira');
        expect(entry.requires.connections.map((c: { name: string }) => c.name)).toEqual(['jira']);
    });

    it('lists org and workspace skills with their source, the org one shadowed by a workspace one', async () => {
        const booted = await boot();
        const { instance, admin, member, other } = booted;
        await publish(booted, '/api/org/skills', admin, 'team-skill');
        await publish(booted, '/api/org/skills', admin, 'clash');
        await publish(booted, '/api/workspace/skills', member, 'clash');
        await publish(booted, '/api/workspace/skills', member, 'personal');

        const mine = (await instance.inject({ method: 'GET', url: '/api/skills', headers: member })).json().skills;
        const by = (name: string, source: string) =>
            mine.find((entry: { name: string; source: string }) => entry.name === name && entry.source === source);
        expect(by('team-skill', 'org')).toEqual(expect.objectContaining({ description: 'Does a thing.' }));
        expect(by('personal', 'workspace')).toBeDefined();
        expect(by('clash', 'workspace')).toBeDefined();
        expect(by('clash', 'org')).toEqual(expect.objectContaining({ shadowedBy: 'workspace' }));

        const theirs = (await instance.inject({ method: 'GET', url: '/api/skills', headers: other })).json().skills;
        expect(theirs.some((entry: { name: string }) => entry.name === 'personal')).toBe(false);
        expect(theirs.some((entry: { name: string }) => entry.name === 'team-skill')).toBe(true);
    });

    it('the repo menu lists the org copy as shadowed by a repo skill of the same name', async () => {
        const client = listingClient(async () => ({
            repos: [{ owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null }],
            installation: { id: '1', account: 'acme', repositorySelection: 'selected' },
        }));
        const booted = await boot(memorySkillStore(), {
            repos: createRepoSource({ client }),
            repoSkills: async () => ({
                revision: 'r',
                skills: [{ name: 'clash', description: 'from the repo' }],
                unreadable: [],
                complete: true,
            }),
        });
        await publish(booted, '/api/org/skills', booted.admin, 'clash');

        const response = await booted.instance.inject({
            method: 'GET',
            url: '/api/repos/acme/web/skills',
            headers: booted.member,
        });
        const body = response.json();
        expect(body.skills.find((s: { name: string }) => s.name === 'clash')).toMatchObject({ source: 'repo' });
        expect(body.shadowed).toEqual([expect.objectContaining({ name: 'clash', source: 'org', shadowedBy: 'repo' })]);
    });

    it('leaves out a disabled or deleted skill', async () => {
        const booted = await boot();
        const { instance, admin, member } = booted;
        const off = await publish(booted, '/api/org/skills', admin, 'off-skill');
        const gone = await publish(booted, '/api/org/skills', admin, 'gone-skill');
        await instance.inject({
            method: 'PUT',
            url: `/api/org/skills/${off}/enabled`,
            headers: admin,
            payload: { enabled: false },
        });
        await instance.inject({ method: 'DELETE', url: `/api/org/skills/${gone}`, headers: admin });
        const skills = (await instance.inject({ method: 'GET', url: '/api/skills', headers: member })).json().skills;
        const names = skills.map((entry: { name: string }) => entry.name);
        expect(names).not.toContain('off-skill');
        expect(names).not.toContain('gone-skill');
    });
});

describe('built-in skill switch', () => {
    const switchTo = (booted: Booted, name: string, headers: { cookie: string }, enabled: unknown = false) =>
        booted.instance.inject({
            method: 'PUT',
            url: `/api/org/skills/builtin/${name}/enabled`,
            headers,
            payload: { enabled },
        });
    const catalog = async (booted: Booted) =>
        (await booted.instance.inject({ method: 'GET', url: '/api/skills', headers: booted.member })).json();

    it('a member gets 403 switching a built-in', async () => {
        const booted = await boot();
        expect((await switchTo(booted, 'factory-jira', booted.member)).statusCode).toBe(HTTP_FORBIDDEN);
        expect(await booted.skills.switchedOff()).toEqual([]);
    });

    it('an unknown built-in is 404 SKILL_NOT_FOUND', async () => {
        const booted = await boot();
        const response = await switchTo(booted, 'no-such-builtin', booted.admin);
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe('SKILL_NOT_FOUND');
    });

    it('a non-boolean enabled is 400', async () => {
        const booted = await boot();
        expect((await switchTo(booted, 'factory-jira', booted.admin, 'no')).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('GET /api/skills marks a switched-off built-in and switching back on clears it', async () => {
        const booted = await boot();
        expect((await switchTo(booted, 'factory-jira', booted.admin)).statusCode).toBe(HTTP_OK);
        expect((await switchTo(booted, 'factory-jira', booted.admin)).statusCode).toBe(HTTP_OK);
        const off = (await catalog(booted)).skills.find((s: { name: string }) => s.name === 'factory-jira');
        expect(off).toMatchObject({ source: 'builtin', switchedOff: true });
        expect(
            (await catalog(booted)).skills.find((s: { name: string }) => s.name === 'factory-fix')
        ).not.toHaveProperty('switchedOff');
        await switchTo(booted, 'factory-jira', booted.admin, true);
        const on = (await catalog(booted)).skills.find((s: { name: string }) => s.name === 'factory-jira');
        expect(on).not.toHaveProperty('switchedOff');
    });

    it('the repo menu omits a switched-off built-in', async () => {
        const client = listingClient(async () => ({
            repos: [{ owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null }],
            installation: { id: '1', account: 'acme', repositorySelection: 'selected' },
        }));
        const booted = await boot(memorySkillStore(), {
            repos: createRepoSource({ client }),
            repoSkills: async () => ({ revision: 'r', skills: [], unreadable: [], complete: true }),
        });
        await switchTo(booted, 'factory-jira', booted.admin);
        const menu = (
            await booted.instance.inject({ method: 'GET', url: '/api/repos/acme/web/skills', headers: booted.member })
        ).json();
        expect(menu.skills.some((s: { name: string }) => s.name === 'factory-jira')).toBe(false);
        expect(menu.skills.some((s: { name: string }) => s.name === 'factory-fix')).toBe(true);
    });

    it('a switched-off read that throws is 503, never a full list', async () => {
        const skills = memorySkillStore();
        const booted = await boot({
            ...skills,
            switchedOff: async () => {
                throw new Error('read failed');
            },
        });
        const response = await booted.instance.inject({ method: 'GET', url: '/api/skills', headers: booted.member });
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
    });
});

describe('inline edit', () => {
    const DOORS = [
        { door: 'org', prefix: '/api/org/skills', who: 'admin' },
        { door: 'workspace', prefix: '/api/workspace/skills', who: 'member' },
    ] as const;
    const HELPER = 'echo hi\n';

    /** Zip-creates `name` with SKILL.md plus the given helper files; returns its id and current version id. */
    async function seed(
        booted: Booted,
        door: (typeof DOORS)[number],
        name: string,
        helpers: { name: string; data: string }[] = [{ name: 'scripts/run.sh', data: HELPER }]
    ) {
        const created = await booted.instance.inject({
            method: 'POST',
            url: `${door.prefix}?name=${name}`,
            headers: { ...booted[door.who], 'content-type': 'application/zip' },
            payload: zip([{ name: 'SKILL.md', data: skillMd(name) }, ...helpers]),
        });
        expect(created.statusCode).toBe(HTTP_CREATED);
        const skill = created.json().skill;
        return { id: skill.id as string, versionId: skill.current.id as string };
    }

    const edit = (booted: Booted, door: (typeof DOORS)[number], id: string, payload: Record<string, unknown>) =>
        booted.instance.inject({
            method: 'POST',
            url: `${door.prefix}/${id}/versions`,
            headers: booted[door.who],
            payload,
        });

    const read = async (booted: Booted, door: (typeof DOORS)[number], id: string) =>
        (
            await booted.instance.inject({ method: 'GET', url: `${door.prefix}/${id}`, headers: booted[door.who] })
        ).json();

    describe.each(DOORS)('$door door', (door) => {
        it('keeps the helper files when JSON replaces SKILL.md', async () => {
            const booted = await boot();
            const { id, versionId } = await seed(booted, door, 'keeper');
            const before = await read(booted, door, id);
            const response = await edit(booted, door, id, {
                skillMd: skillMd('keeper', 'Edited.'),
                baseVersionId: versionId,
            });
            expect(response.statusCode).toBe(HTTP_CREATED);
            expect(response.json().skill.current.description).toBe('Edited.');
            const after = await read(booted, door, id);
            expect(after.files.map((file: { path: string }) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
            const helper = (list: { path: string; size: number }[]) => list.find((f) => f.path === 'scripts/run.sh');
            expect(helper(after.files)?.size).toBe(helper(before.files)?.size);
            expect(after.skillMd).toBe(skillMd('keeper', 'Edited.'));
        });

        it('an edit whose current version cannot be read is 503 and writes no version', async () => {
            const booted = await boot();
            const { id, versionId } = await seed(booted, door, 'unreadable');
            booted.skills.breakVersionReads();
            const response = await edit(booted, door, id, {
                skillMd: skillMd('unreadable', 'Edited.'),
                baseVersionId: versionId,
            });
            expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
            booted.skills.breakVersionReads(false);
            const after = await read(booted, door, id);
            expect(after.skill.current.id).toBe(versionId);
            expect(after.files.map((file: { path: string }) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
        });

        it('an edit whose stored object is gone is 410', async () => {
            const booted = await boot();
            const { id, versionId } = await seed(booted, door, 'vanished');
            booted.skills.loseObjects();
            const response = await edit(booted, door, id, {
                skillMd: skillMd('vanished', 'Edited.'),
                baseVersionId: versionId,
            });
            expect(response.statusCode).toBe(HTTP_GONE);
            expect(response.json().code).toBe('SKILL_GONE');
        });

        it('a stale baseVersionId is 409 SKILL_VERSION_STALE', async () => {
            const booted = await boot();
            const { id, versionId: v1 } = await seed(booted, door, 'stale');
            const v2 = await booted.instance.inject({
                method: 'POST',
                url: `${door.prefix}/${id}/versions`,
                headers: { ...booted[door.who], 'content-type': 'application/zip' },
                payload: zip([
                    { name: 'SKILL.md', data: skillMd('stale', 'Second.') },
                    { name: 'scripts/run.sh', data: HELPER },
                ]),
            });
            expect(v2.statusCode).toBe(HTTP_CREATED);
            const response = await edit(booted, door, id, { skillMd: skillMd('stale', 'Late.'), baseVersionId: v1 });
            expect(response.statusCode).toBe(HTTP_CONFLICT);
            expect(response.json().code).toBe('SKILL_VERSION_STALE');
            expect((await read(booted, door, id)).skill.current.id).toBe(v2.json().skill.current.id);
        });

        it('a missing baseVersionId is 400', async () => {
            const booted = await boot();
            const { id } = await seed(booted, door, 'unbased');
            const response = await edit(booted, door, id, { skillMd: skillMd('unbased', 'Edited.') });
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        });

        it('an edit that pushes the bundle past MAX_SKILL_BYTES is 422 too_large', async () => {
            const booted = await boot();
            const big = 'x'.repeat(MAX_SKILL_FILE_BYTES - 1024);
            const helpers = [1, 2, 3, 4, 5].map((n) => ({ name: `data/${n}.txt`, data: big }));
            const { id, versionId } = await seed(booted, door, 'heavy', helpers);
            const response = await edit(booted, door, id, {
                skillMd: skillMd('heavy', 'Edited.') + 'y'.repeat(MAX_SKILL_FILE_BYTES / 2),
                baseVersionId: versionId,
            });
            expect(response.statusCode).toBe(HTTP_UNPROCESSABLE);
            expect(response.json().reason).toBe('too_large');
        });

        it('name_mismatch on edit', async () => {
            const booted = await boot();
            const { id, versionId } = await seed(booted, door, 'named');
            const response = await edit(booted, door, id, { skillMd: skillMd('other'), baseVersionId: versionId });
            expect(response.statusCode).toBe(HTTP_UNPROCESSABLE);
            expect(response.json().reason).toBe('name_mismatch');
        });

        it('a zip version still replaces the whole bundle', async () => {
            const booted = await boot();
            const { id } = await seed(booted, door, 'replaced');
            const response = await booted.instance.inject({
                method: 'POST',
                url: `${door.prefix}/${id}/versions`,
                headers: { ...booted[door.who], 'content-type': 'application/zip' },
                payload: zip([{ name: 'SKILL.md', data: skillMd('replaced', 'Only.') }]),
            });
            expect(response.statusCode).toBe(HTTP_CREATED);
            const after = await read(booted, door, id);
            expect(after.files.map((file: { path: string }) => file.path)).toEqual(['SKILL.md']);
        });
    });
});
