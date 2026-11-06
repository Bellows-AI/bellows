import { deflateRawSync } from 'node:zlib';
import { MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { bundleFromSkillMd, bundleFromZip, SkillBundleError } from '../src/skills/skill-bundle.js';

const SKILL_MD = (name: string): string => `---\nname: ${name}\ndescription: Does a thing.\n---\n\nBody.\n`;

interface ZipEntry {
    name: string;
    data?: Buffer | string;
    method?: 0 | 8;
    /** Unix mode in the high 16 bits of the external attributes. */
    mode?: number;
    declaredSize?: number;
    raw?: Buffer;
}

function u16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
}
function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
}

function zip(entries: ZipEntry[]): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name);
        const data = Buffer.from(e.data ?? '');
        const method = e.method ?? 8;
        const body = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
        const usize = e.declaredSize ?? data.length;
        const local = Buffer.concat([
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(method),
            u16(0),
            u16(0),
            u32(0),
            u32(body.length),
            u32(usize),
            u16(name.length),
            u16(0),
            name,
            body,
        ]);
        const mode = e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);
        central.push(
            Buffer.concat([
                u32(0x02014b50),
                u16((3 << 8) | 20),
                u16(20),
                u16(0),
                u16(method),
                u16(0),
                u16(0),
                u32(0),
                u32(body.length),
                u32(usize),
                u16(name.length),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32((mode << 16) >>> 0),
                u32(offset),
                name,
            ])
        );
        chunks.push(local);
        offset += local.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(entries.length),
        u16(entries.length),
        u32(cd.length),
        u32(offset),
        u16(0),
    ]);
    return Buffer.concat([...chunks, cd, eocd]);
}

function reason(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(SkillBundleError);
        expect((error as SkillBundleError).code).toBe('SKILL_BUNDLE_INVALID');
        expect((error as SkillBundleError).message.length).toBeGreaterThan(10);
        return (error as SkillBundleError).reason;
    }
    throw new Error('expected a refusal');
}

describe('skill bundle from SKILL.md', () => {
    it('makes a one-file bundle with a description and a deterministic tar', () => {
        const a = bundleFromSkillMd('my-skill', SKILL_MD('my-skill'));
        const b = bundleFromSkillMd('my-skill', SKILL_MD('my-skill'));
        expect(a.files.map((f) => f.path)).toEqual(['SKILL.md']);
        expect(a.description).toBe('Does a thing.');
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(a.sha256).toBe(b.sha256);
        expect(a.tar.equals(b.tar)).toBe(true);
        expect(a.tar.length % 512).toBe(0);
        expect(a.size).toBe(Buffer.byteLength(SKILL_MD('my-skill')));
        expect(bundleFromSkillMd('my-skill', `${SKILL_MD('my-skill')}more`).sha256).not.toBe(a.sha256);
    });

    it('refuses bad frontmatter, a name mismatch, a reserved name and a bad name', () => {
        expect(reason(() => bundleFromSkillMd('my-skill', 'no frontmatter'))).toBe('bad_frontmatter');
        expect(reason(() => bundleFromSkillMd('my-skill', SKILL_MD('other')))).toBe('name_mismatch');
        expect(reason(() => bundleFromSkillMd('factory-x', SKILL_MD('factory-x')))).toBe('reserved_name');
        expect(reason(() => bundleFromSkillMd('Bad_Name', SKILL_MD('Bad_Name')))).toBe('bad_name');
        expect(reason(() => bundleFromSkillMd('my-skill', 'x'.repeat(MAX_SKILL_FILE_BYTES + 1)))).toBe(
            'file_too_large'
        );
    });
});

describe('skill bundle from zip', () => {
    const md = { name: 'SKILL.md', data: SKILL_MD('my-skill') };

    it('reads stored and deflated entries, sorts paths and ignores directory entries', () => {
        const bytes = zip([
            { name: 'scripts/', data: '' },
            { name: 'scripts/run.sh', data: 'echo hi\n', method: 0 },
            md,
        ]);
        const bundle = bundleFromZip('my-skill', bytes);
        expect(bundle.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
        expect(bundle.files[1]?.bytes.toString()).toBe('echo hi\n');
        expect(bundle.size).toBe(Buffer.byteLength(SKILL_MD('my-skill')) + 8);
    });

    it('gives the same sha256 as the inline path and regardless of zip entry order or compression', () => {
        const inline = bundleFromSkillMd('my-skill', SKILL_MD('my-skill'));
        expect(bundleFromZip('my-skill', zip([md])).sha256).toBe(inline.sha256);
        const a = bundleFromZip('my-skill', zip([md, { name: 'b.txt', data: 'b' }, { name: 'a.txt', data: 'a' }]));
        const b = bundleFromZip(
            'my-skill',
            zip([{ name: 'a.txt', data: 'a', method: 0 }, { name: 'b.txt', data: 'b' }, md])
        );
        expect(a.sha256).toBe(b.sha256);
    });

    it('strips one top-level folder only when every entry shares it', () => {
        const wrapped = bundleFromZip(
            'my-skill',
            zip([
                { name: 'my-skill/', data: '' },
                { name: 'my-skill/SKILL.md', data: SKILL_MD('my-skill') },
                { name: 'my-skill/ref.md', data: 'r' },
            ])
        );
        expect(wrapped.files.map((f) => f.path)).toEqual(['SKILL.md', 'ref.md']);
        expect(wrapped.sha256).toBe(bundleFromZip('my-skill', zip([md, { name: 'ref.md', data: 'r' }])).sha256);
        expect(
            reason(() =>
                bundleFromZip(
                    'my-skill',
                    zip([
                        { name: 'dir/x.md', data: 'x' },
                        { name: 'dir/y.md', data: 'y' },
                    ])
                )
            )
        ).toBe('no_skill_md');
        expect(
            reason(() =>
                bundleFromZip(
                    'my-skill',
                    zip([
                        { name: 'my-skill/SKILL.md', data: SKILL_MD('my-skill') },
                        { name: 'other/x', data: 'x' },
                    ])
                )
            )
        ).toBe('no_skill_md');
    });

    it('refuses unsafe paths and non-regular entries', () => {
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: '../x', data: 'x' }])))).toBe('traversal');
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: 'a/../../x', data: 'x' }])))).toBe('traversal');
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: '/etc/x', data: 'x' }])))).toBe('absolute');
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: 'a\\b', data: 'x' }])))).toBe('backslash');
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: 'a\0b', data: 'x' }])))).toBe('nul');
        expect(
            reason(() => bundleFromZip('my-skill', zip([md, { name: 'link', data: 'SKILL.md', mode: 0o120777 }])))
        ).toBe('symlink');
        expect(reason(() => bundleFromZip('my-skill', zip([md, { name: 'dev', data: '', mode: 0o020644 }])))).toBe(
            'non_regular'
        );
        expect(
            reason(() => bundleFromZip('my-skill', zip([md, { name: 'x', data: 'a' }, { name: './x', data: 'b' }])))
        ).toBe('traversal');
        expect(
            reason(() => bundleFromZip('my-skill', zip([md, { name: 'x', data: 'a' }, { name: 'x', data: 'b' }])))
        ).toBe('duplicate_path');
    });

    it('refuses too many files', () => {
        const many = Array.from({ length: MAX_SKILL_FILES }, (_, i) => ({ name: `f${i}.md`, data: 'x' }));
        expect(reason(() => bundleFromZip('my-skill', zip([md, ...many])))).toBe('too_many_files');
    });

    it('is zip-bomb safe: declared sizes are not trusted', () => {
        const zeros = Buffer.alloc(MAX_SKILL_FILE_BYTES);
        const lying = (name: string) => ({ name, data: zeros });
        const total = Math.ceil(MAX_SKILL_BYTES / MAX_SKILL_FILE_BYTES) + 1;
        const many = Array.from({ length: total }, (_, i) => lying(`z${i}.bin`));
        expect(reason(() => bundleFromZip('my-skill', zip([md, ...many])))).toBe('too_large');
        const big = { name: 'big.bin', data: Buffer.alloc(MAX_SKILL_FILE_BYTES * 3), declaredSize: 10 };
        expect(reason(() => bundleFromZip('my-skill', zip([md, big])))).toBe('file_too_large');
        const honest = { name: 'big.bin', data: Buffer.alloc(MAX_SKILL_FILE_BYTES + 1) };
        expect(reason(() => bundleFromZip('my-skill', zip([md, honest])))).toBe('file_too_large');
    });

    it('accepts real-world frontmatter keys but still needs a description', () => {
        const text =
            '---\nname: my-skill\ndescription: Does a thing.\nallowed-tools: Bash, Read\nmodel: sonnet\nlicense: MIT\n---\nBody\n';
        expect(bundleFromZip('my-skill', zip([{ name: 'SKILL.md', data: text }])).description).toBe('Does a thing.');
        expect(bundleFromSkillMd('my-skill', text).description).toBe('Does a thing.');
        const bare = '---\nname: my-skill\nmodel: sonnet\n---\n';
        expect(reason(() => bundleFromZip('my-skill', zip([{ name: 'SKILL.md', data: bare }])))).toBe(
            'bad_frontmatter'
        );
    });

    it('refuses a missing SKILL.md, a bad one, and a non-zip', () => {
        expect(reason(() => bundleFromZip('my-skill', zip([{ name: 'README.md', data: 'x' }])))).toBe('no_skill_md');
        expect(reason(() => bundleFromZip('my-skill', zip([{ name: 'SKILL.md', data: 'plain' }])))).toBe(
            'bad_frontmatter'
        );
        expect(reason(() => bundleFromZip('my-skill', zip([{ name: 'SKILL.md', data: SKILL_MD('other') }])))).toBe(
            'name_mismatch'
        );
        expect(reason(() => bundleFromZip('factory-x', zip([{ name: 'SKILL.md', data: SKILL_MD('factory-x') }])))).toBe(
            'reserved_name'
        );
        expect(reason(() => bundleFromZip('my-skill', Buffer.from('not a zip at all')))).toBe('not_zip');
        expect(reason(() => bundleFromZip('my-skill', zip([md]).subarray(0, 30)))).toBe('not_zip');
    });
});
