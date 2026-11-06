import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The skill install script never takes a read that confirmed nothing as an answer. Every filesystem read goes through
 * one primitive that reports absence only for ENOENT/ENOTDIR, and the ownership manifest is one strictly validated
 * document: a damaged one is a transient failure that touches nothing. The script FILE runs as the container runs it.
 */
const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'src', 'scripts', 'skill-install.cjs'), 'utf8');
const run = promisify(execFile);
const SHA = 'a'.repeat(64);
const V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PIN = [{ name: 'pinned-one', source: 'org', versionId: V1, sha256: 'b'.repeat(64) }];
const isRoot = process.getuid?.() === 0;

interface Verdict {
    ok: boolean;
    reason?: string;
    transient?: boolean;
    kind?: string;
    pruned?: number;
}

/** The body of the first `{ ... }` after `from`, brace-matched. */
const blockAfter = (text: string, from: number): string => {
    const open = text.indexOf('{', from);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
    }
    return '';
};

describe('the skill install script reads', () => {
    it('never calls existsSync', () => {
        expect(SCRIPT).not.toMatch(/existsSync/);
    });

    it('never has a catch that does not rethrow: no failed read becomes a default', () => {
        const catches = [...SCRIPT.matchAll(/\bcatch\b/g)];
        expect(catches.length).toBeGreaterThan(0);
        for (const found of catches) {
            expect(blockAfter(SCRIPT, found.index), SCRIPT.slice(found.index, found.index + 80)).toMatch(/\bthrow\b/);
        }
        expect(SCRIPT).not.toMatch(/\.catch\(/);
    });

    it('reads the filesystem only inside probe', () => {
        const at = SCRIPT.indexOf('const probe = ');
        expect(at).toBeGreaterThan(-1);
        const probe = blockAfter(SCRIPT, SCRIPT.indexOf('=>', at));
        const outside = SCRIPT.replace(probe, '');
        expect(outside).not.toMatch(
            /\b(?:statSync|lstatSync|readdirSync|readFileSync|accessSync|openSync|readlinkSync)\b/
        );
    });
});

describe('the skill install script on a damaged skills directory', () => {
    let root = '';
    let target = '';
    const manifestPath = () => join(target, '.factory-skills.json');

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-reads-'));
        target = join(root, '.claude', 'skills');
        mkdirSync(join(target, 'agent-made'), { recursive: true });
        mkdirSync(join(target, 'owned-one'), { recursive: true });
        writeFileSync(join(target, 'agent-made', 'SKILL.md'), 'mine');
        writeFileSync(join(target, 'owned-one', 'SKILL.md'), 'installed');
        writeFileSync(manifestPath(), JSON.stringify({ owned: { 'owned-one': SHA } }) + '\n');
    });
    afterEach(() => {
        for (const dir of [join(root, '.claude'), target, manifestPath()]) {
            try {
                chmodSync(dir, dir === manifestPath() ? 0o644 : 0o755);
            } catch {
                // a path the test removed or never made
            }
        }
        rmSync(root, { recursive: true, force: true });
    });

    const install = async (pin: readonly unknown[]): Promise<Verdict> => {
        const { stdout } = await run(process.execPath, ['--no-warnings', '-e', SCRIPT], {
            env: {
                PATH: process.env.PATH ?? '',
                TARGET_DIR: target,
                PIN: JSON.stringify(pin),
                INPUT_DELIVERY: 'skills',
                STAGING_SEQ: '4',
                // nothing listens here: a run that reaches the fetch fails with "control endpoint", not for the damage
                RESTORE_URL: 'http://127.0.0.1:1',
                RESTORE_TOKEN: 't',
            },
        });
        return JSON.parse(stdout.trim().split('\n').pop() ?? '') as Verdict;
    };
    const names = () => readdirSync(target).sort();
    /** The manifest's bytes, or `dir` when something else is in its place. */
    const snapshot = () => (statSync(manifestPath()).isFile() ? readFileSync(manifestPath()) : 'dir');

    /** Transient, before any fetch, with the manifest bytes and every directory as they were. */
    const expectUntouched = async (pin: readonly unknown[], deny?: () => void) => {
        const manifest = snapshot();
        const before = names();
        deny?.();
        const verdict = await install(pin);
        chmodSync(join(root, '.claude'), 0o755);
        chmodSync(target, 0o755);
        chmodSync(manifestPath(), 0o644);
        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(verdict.reason).not.toMatch(/control endpoint/);
        expect(snapshot()).toEqual(manifest);
        expect(names()).toEqual(before);
        expect(readFileSync(join(target, 'agent-made', 'SKILL.md'), 'utf8')).toBe('mine');
        expect(readFileSync(join(target, 'owned-one', 'SKILL.md'), 'utf8')).toBe('installed');
    };

    it.skipIf(isRoot)(
        'does not report success for an empty pin when the skills directory cannot be inspected',
        async () => {
            await expectUntouched([], () => chmodSync(join(root, '.claude'), 0o000));
        }
    );

    it('does not prune for an empty pin when the manifest owns an entry with a null digest', async () => {
        writeFileSync(manifestPath(), '{"owned":{"agent-made":null}}');
        await expectUntouched([]);
    });

    const bad: [string, string][] = [
        ['null digest', '{"owned":{"owned-one":null}}'],
        ['numeric digest', '{"owned":{"owned-one":12}}'],
        ['short digest', `{"owned":{"owned-one":"${'a'.repeat(63)}"}}`],
        ['uppercase digest', `{"owned":{"owned-one":"${'A'.repeat(64)}"}}`],
        ['one bad entry beside a good one', `{"owned":{"owned-one":"${SHA}","agent-made":"nope"}}`],
        ['a key that climbs out', `{"owned":{"../escape":"${SHA}"}}`],
        ['a key that is not a skill name', `{"owned":{"Bad_Name":"${SHA}"}}`],
        ['an empty key', `{"owned":{"":"${SHA}"}}`],
        ['an owned array', '{"owned":[]}'],
        ['a null owned', '{"owned":null}'],
        ['no owned', '{}'],
        ['a top-level array', '[]'],
        ['a top-level null', 'null'],
        ['malformed JSON', '{ not json'],
        ['an empty file', ''],
        ['a directory in its place (EISDIR)', 'DIR'],
    ];
    it.each(bad)('is transient and touches nothing for a manifest with %s', async (_what, body) => {
        if (body === 'DIR') {
            rmSync(manifestPath());
            mkdirSync(manifestPath());
        } else writeFileSync(manifestPath(), body);
        for (const pin of [[], PIN]) await expectUntouched(pin);
    });

    it.skipIf(isRoot)('is transient and touches nothing when the manifest cannot be read (EACCES)', async () => {
        for (const pin of [[], PIN]) await expectUntouched(pin, () => chmodSync(manifestPath(), 0o000));
    });

    it.skipIf(isRoot)(
        'is transient and touches nothing when the target cannot be inspected, for a pin too',
        async () => {
            await expectUntouched(PIN, () => chmodSync(join(root, '.claude'), 0o000));
        }
    );

    it('is transient when the skills path is a file', async () => {
        rmSync(target, { recursive: true, force: true });
        writeFileSync(target, 'a file');
        const verdict = await install([]);
        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(readFileSync(target, 'utf8')).toBe('a file');
    });

    it('prunes only owned names of a valid manifest', async () => {
        expect(await install([])).toMatchObject({ ok: true, pruned: 1 });
        expect(names()).toEqual(['.factory-skills.json', 'agent-made']);
    });
});
