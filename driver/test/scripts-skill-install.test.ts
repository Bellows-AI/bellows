import { execFile } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Of, skillOf, tarOf, type TarEntry } from './fixtures/skill-tar.js';

/**
 * The skill install script: the pins of a claim are read from the control endpoint's `/input/skills/<versionId>` route,
 * verified, unpacked by a reader that takes only regular files and directories under the skill's own directory, and
 * renamed into place. The script FILE runs as the container runs it, against a fake control endpoint.
 */
const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'src', 'scripts', 'skill-install.cjs'), 'utf8');
const TOKEN = 'input-token';
const run = promisify(execFile);
const V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface Verdict {
    ok: boolean;
    reason?: string;
    kind?: string;
    transient?: boolean;
    skills?: number;
    fetched?: number;
    pruned?: number;
}
type Pin = ReturnType<typeof skillOf>['pin'];

describe('the skill install script', () => {
    let server: Server | null = null;
    let root = '';
    let target = '';
    let asked: string[] = [];
    const bodies = new Map<string, Buffer>();
    /** A status the fake endpoint answers per version instead of the bundle, or `hang`. */
    let overrides: Map<string, number | 'hang'>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-install-'));
        target = join(root, '.claude', 'skills');
        asked = [];
        bodies.clear();
        overrides = new Map();
    });
    afterEach(() => {
        server?.closeAllConnections();
        server?.close();
        server = null;
        rmSync(root, { recursive: true, force: true });
    });

    const publish = (name: string, versionId: string, files?: Record<string, string>): Pin => {
        const { tar, pin } = skillOf(name, versionId, files);
        bodies.set(versionId, tar);
        return pin;
    };

    async function serve(): Promise<string> {
        server = createServer((request, reply) => {
            const [, route, delivery, id = ''] = (request.url ?? '').split('/');
            if (request.headers.authorization !== `Bearer ${TOKEN}`) return void reply.writeHead(401).end('{}');
            if (route !== 'input' || delivery !== 'skills') return void reply.writeHead(400).end('{}');
            asked.push(id);
            const override = overrides.get(id);
            if (override === 'hang') return;
            if (override) return void reply.writeHead(override).end('{}');
            const body = bodies.get(id);
            if (!body) return void reply.writeHead(404).end('{}');
            reply.writeHead(200, { 'x-content-sha256': sha256Of(body) }).end(body);
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    async function install(pin: readonly unknown[], env: Record<string, string> = {}): Promise<Verdict> {
        const url = await serve();
        const { stdout } = await run(process.execPath, ['--no-warnings', '-e', SCRIPT], {
            env: {
                PATH: process.env.PATH ?? '',
                TARGET_DIR: target,
                PIN: JSON.stringify(pin),
                INPUT_DELIVERY: 'skills',
                STAGING_SEQ: '4',
                RESTORE_URL: url,
                RESTORE_TOKEN: TOKEN,
                ...env,
            },
        });
        return JSON.parse(stdout.trim().split('\n').pop() ?? '') as Verdict;
    }

    const ledger = () => JSON.parse(readFileSync(join(target, '.factory-skills.json'), 'utf8')) as { owned: object };
    const mode = (path: string) => statSync(path).mode & 0o777;

    it('installs each pinned skill as <name>/SKILL.md with its helper files, 0755 dirs and 0644 files, and owns them', async () => {
        const a = publish('org-style', V1, {
            'SKILL.md': 'A\n',
            'scripts/run.sh': 'echo hi\n',
            'ref/deep/notes.md': 'n\n',
        });
        const b = publish('other', V2);
        expect(await install([a, b])).toEqual({ ok: true, skills: 2, fetched: 2, pruned: 0 });
        expect(readFileSync(join(target, 'org-style', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
        expect(readFileSync(join(target, 'org-style', 'ref', 'deep', 'notes.md'), 'utf8')).toBe('n\n');
        expect(mode(join(target, 'org-style'))).toBe(0o755);
        expect(mode(join(target, 'org-style', 'ref', 'deep'))).toBe(0o755);
        expect(mode(join(target, 'org-style', 'scripts', 'run.sh'))).toBe(0o644);
        expect(ledger().owned).toEqual({ 'org-style': a.sha256, other: b.sha256 });
        expect(readdirSync(target).filter((n) => n.startsWith('.staging-'))).toEqual([]);
    });

    it('skips a skill whose recorded sha256 is already installed, without a read', async () => {
        const a = publish('org-style', V1);
        await install([a]);
        asked = [];
        expect(await install([a])).toEqual({ ok: true, skills: 1, fetched: 0, pruned: 0 });
        expect(asked).toEqual([]);
    });

    it('refetches a skill whose installed directory is gone or whose sha256 changed', async () => {
        const a = publish('org-style', V1);
        await install([a]);
        rmSync(join(target, 'org-style'), { recursive: true });
        expect((await install([a])).fetched).toBe(1);
        const next = publish('org-style', V2, { 'SKILL.md': 'v2\n' });
        expect((await install([next])).fetched).toBe(1);
        expect(readFileSync(join(target, 'org-style', 'SKILL.md'), 'utf8')).toBe('v2\n');
        expect(ledger().owned).toEqual({ 'org-style': next.sha256 });
    });

    it('prunes an owned skill the pin no longer lists, keeps an agent-made directory, and overwrites a same-name one', async () => {
        const a = publish('org-style', V1);
        const b = publish('other', V2);
        await install([a, b]);
        mkdirSync(join(target, 'agent-made'));
        writeFileSync(join(target, 'agent-made', 'SKILL.md'), 'mine');
        mkdirSync(join(target, 'later'));
        writeFileSync(join(target, 'later', 'SKILL.md'), 'agent copy');
        const later = publish('later', V3, { 'SKILL.md': 'pinned\n' });

        expect(await install([a, later])).toEqual({ ok: true, skills: 2, fetched: 1, pruned: 1 });

        expect(existsSync(join(target, 'other'))).toBe(false);
        expect(readFileSync(join(target, 'agent-made', 'SKILL.md'), 'utf8')).toBe('mine');
        expect(readFileSync(join(target, 'later', 'SKILL.md'), 'utf8')).toBe('pinned\n');
        expect(ledger().owned).toEqual({ 'org-style': a.sha256, later: later.sha256 });
    });

    it('prunes every owned skill for an empty pin', async () => {
        const a = publish('org-style', V1);
        await install([a]);
        expect(await install([])).toEqual({ ok: true, skills: 0, fetched: 0, pruned: 1 });
        expect(existsSync(join(target, 'org-style'))).toBe(false);
        expect(ledger().owned).toEqual({});
    });

    it('has nothing to prune for an empty pin when no skills directory exists, and creates none', async () => {
        rmSync(target, { recursive: true, force: true });
        expect(await install([])).toEqual({ ok: true, skills: 0, fetched: 0, pruned: 0 });
        expect(existsSync(target)).toBe(false);
    });

    it.each<[string, (ledgerPath: string) => void]>([
        ['malformed JSON', (p) => writeFileSync(p, '{ not json')],
        ['an empty file', (p) => writeFileSync(p, '')],
        ['a ledger without an owned map', (p) => writeFileSync(p, '{"owned":[1]}')],
        ['a ledger that cannot be read (a directory in its place: EISDIR)', (p) => mkdirSync(p)],
    ])('is inconclusive and keeps the ledger and the skills when the ledger is %s', async (_what, damage) => {
        const a = publish('org-style', V1);
        const b = publish('other', V2);
        await install([a, b]);
        const path = join(target, '.factory-skills.json');
        const before = readFileSync(path, 'utf8');
        rmSync(path);
        damage(path);
        const damaged = existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
        asked = [];

        for (const pin of [[], [a]]) {
            expect(await install(pin)).toMatchObject({ ok: false, transient: true });
        }

        expect(asked).toEqual([]);
        expect(existsSync(join(target, 'org-style', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(target, 'other', 'SKILL.md'))).toBe(true);
        expect(existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null).toBe(damaged);
        expect(before).toContain('org-style');
    });

    it.skipIf(process.getuid?.() === 0)(
        'is inconclusive, not a refetch, when the installed skill cannot be inspected (EACCES, not absence)',
        async () => {
            const a = publish('org-style', V1);
            await install([a]);
            asked = [];
            chmodSync(join(target, 'org-style'), 0o000);
            try {
                expect(await install([a])).toMatchObject({ ok: false, transient: true });
                expect(asked).toEqual([]);
            } finally {
                chmodSync(join(target, 'org-style'), 0o755);
            }
        }
    );

    it('owns nothing on a confirmed absence of the ledger: a skills directory without one installs normally', async () => {
        const a = publish('org-style', V1);
        mkdirSync(target, { recursive: true });
        expect(await install([a])).toEqual({ ok: true, skills: 1, fetched: 1, pruned: 0 });
    });

    it('discards the staging directory a killed install left, and installs over it', async () => {
        const a = publish('org-style', V1);
        mkdirSync(join(target, '.staging-3', 'org-style'), { recursive: true });
        writeFileSync(join(target, '.staging-3', 'org-style', 'half'), 'partial');
        mkdirSync(join(target, '.staging-4', 'org-style'), { recursive: true });
        writeFileSync(join(target, '.staging-4', 'org-style', 'SKILL.md'), 'stale half');
        expect((await install([a])).ok).toBe(true);
        expect(readdirSync(target).sort()).toEqual(['.factory-skills.json', 'org-style']);
        expect(readFileSync(join(target, 'org-style', 'SKILL.md'), 'utf8')).toContain('org-style');
    });

    it('leaves no skill at a final name when a later bundle in the pin fails', async () => {
        const a = publish('org-style', V1);
        const bad = { ...publish('other', V2), sha256: 'f'.repeat(64) };
        expect(await install([a, bad])).toMatchObject({ ok: false, kind: 'skill_unavailable' });
        expect(existsSync(join(target, 'org-style'))).toBe(false);
        expect(existsSync(join(target, '.factory-skills.json'))).toBe(false);
    });

    it('refuses bytes that do not match the pin as skill_unavailable', async () => {
        const a = publish('org-style', V1);
        bodies.set(
            V1,
            Buffer.concat([bodies.get(V1)!.subarray(0, 600), Buffer.from('x'), bodies.get(V1)!.subarray(601)])
        );
        const verdict = await install([a]);
        expect(verdict).toMatchObject({ ok: false, kind: 'skill_unavailable' });
        expect(verdict.reason).toMatch(/sha256/);
    });

    it.each([[410], [422]])('refuses the board’s %i as skill_unavailable', async (status) => {
        const a = publish('org-style', V1);
        overrides.set(V1, status);
        expect(await install([a])).toMatchObject({ ok: false, kind: 'skill_unavailable' });
    });

    it.each([[500], [502], [503], [404], [409]])(
        'treats the board’s %i as inconclusive, never a refusal',
        async (status) => {
            const a = publish('org-style', V1);
            overrides.set(V1, status);
            const verdict = await install([a]);
            expect(verdict).toMatchObject({ ok: false, transient: true });
            expect(verdict.kind).toBeUndefined();
        }
    );

    it('treats a timeout as inconclusive', async () => {
        const a = publish('org-style', V1);
        overrides.set(V1, 'hang');
        expect(await install([a], { FETCH_TIMEOUT_MS: '300' })).toMatchObject({ ok: false, transient: true });
    });

    it('treats a malformed pin as inconclusive, not as no skills', async () => {
        const good = publish('org-style', V1);
        for (const pin of [
            [{ ...good, name: '../x' }],
            [{ ...good, versionId: 'not-a-uuid' }],
            [{ ...good, sha256: 'short' }],
            [{ ...good, source: 'repo' }],
            [good, good],
            [null],
        ]) {
            expect(await install(pin)).toMatchObject({ ok: false, transient: true });
        }
        expect(await install([], { PIN: '{"a":1}' })).toMatchObject({ ok: false, transient: true });
        expect(asked).toEqual([]);
    });

    describe('refuses a bundle that is not a safe skill, as skill_unavailable, writing nothing outside the skill', () => {
        const hostile: [string, TarEntry[]][] = [
            [
                'a path that climbs out',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: '../escape.txt', body: 'x' },
                ],
            ],
            [
                'a path that climbs out in the middle',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'a/../../escape', body: 'x' },
                ],
            ],
            [
                'an absolute path',
                [
                    { path: '/etc/passwd', body: 'x' },
                    { path: 'SKILL.md', body: 'x' },
                ],
            ],
            [
                'a dot segment',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: './a', body: 'x' },
                ],
            ],
            [
                'a symlink',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'link', type: '2' },
                ],
            ],
            [
                'a hard link',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'link', type: '1' },
                ],
            ],
            [
                'a pax header',
                [
                    { path: 'pax', type: 'x', body: '30 path=../escape\n' },
                    { path: 'SKILL.md', body: 'x' },
                ],
            ],
            [
                'a device',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'dev', type: '3' },
                ],
            ],
            ['a bad checksum', [{ path: 'SKILL.md', body: 'x', badChecksum: true }]],
            [
                'a path that is a file and a directory',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'a', body: 'x' },
                    { path: 'a/b', body: 'x' },
                ],
            ],
            [
                'a path twice',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'SKILL.md', body: 'y' },
                ],
            ],
            ['no SKILL.md at the root', [{ path: 'docs/SKILL.md', body: 'x' }]],
            [
                'an empty path segment',
                [
                    { path: 'SKILL.md', body: 'x' },
                    { path: 'a//b', body: 'x' },
                ],
            ],
        ];
        it.each(hostile)('%s', async (_name, entries) => {
            const tar = tarOf(entries);
            bodies.set(V1, tar);
            const verdict = await install([{ name: 'org-style', source: 'org', versionId: V1, sha256: sha256Of(tar) }]);
            expect(verdict).toMatchObject({ ok: false, kind: 'skill_unavailable' });
            expect(existsSync(join(root, 'escape.txt'))).toBe(false);
            expect(existsSync(join(root, '.claude', 'escape.txt'))).toBe(false);
            expect(existsSync(join(target, 'org-style'))).toBe(false);
        });

        it('a tar with no end marker, and one cut inside an entry', async () => {
            for (const tar of [
                tarOf([{ path: 'SKILL.md', body: 'x' }], { endMarker: false }),
                tarOf([{ path: 'SKILL.md', body: 'x'.repeat(2000) }]).subarray(0, 700),
            ]) {
                bodies.set(V1, tar);
                expect(
                    await install([{ name: 'org-style', source: 'org', versionId: V1, sha256: sha256Of(tar) }])
                ).toMatchObject({ ok: false, kind: 'skill_unavailable' });
            }
        });

        it('a bundle of more than 64 files', async () => {
            const tar = tarOf([
                { path: 'SKILL.md', body: 'x' },
                ...Array.from({ length: 64 }, (_, i) => ({ path: `f${i}`, body: 'x' })),
            ]);
            bodies.set(V1, tar);
            expect(
                await install([{ name: 'org-style', source: 'org', versionId: V1, sha256: sha256Of(tar) }])
            ).toMatchObject({ ok: false, kind: 'skill_unavailable' });
        });
    });

    it('reads a long path through the ustar prefix field and creates its directories', async () => {
        const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
        const a = publish('org-style', V1, { 'SKILL.md': 'x', [deep]: 'deep' });
        expect((await install([a])).ok).toBe(true);
        expect(readFileSync(join(target, 'org-style', deep), 'utf8')).toBe('deep');
    });

    it('opens a read-only target of an earlier run: the install owns its directory', async () => {
        const a = publish('org-style', V1);
        await install([a]);
        chmodSync(target, 0o755);
        const next = publish('other', V2);
        expect((await install([a, next])).ok).toBe(true);
    });
});
