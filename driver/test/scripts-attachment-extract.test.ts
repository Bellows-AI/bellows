import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The attachment extract script: text derived beside PDF and Word attachments, an explicit `unreadable` entry for
 * what cannot be read, originals untouched. Fixtures are generated here; the script FILE runs as the container runs it.
 */
const SCRIPT = join(import.meta.dirname, '..', 'src', 'scripts', 'attachment-extract.cjs');
const run = promisify(execFile);
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const hasPdftotext = spawnSync('pdftotext', ['-v']).error === undefined;
const SENTENCE = 'The quick brown fox jumps over the lazy dog';
const ID = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
};

/** A zip of `parts`, deflated; `flags` sets the general-purpose bit flag of the part named in it. */
const zipOf = (parts: Record<string, Buffer>, flags: Record<string, number> = {}): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, raw] of Object.entries(parts)) {
        const packed = deflateRawSync(raw);
        const nameBytes = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags[name] ?? 0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc32(raw), 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags[name] ?? 0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc32(raw), 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, packed);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + packed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(parts).length, 8);
    end.writeUInt16LE(Object.keys(parts).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

const body = (xml: string) =>
    Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${xml}</w:body></w:document>`);
const docx = (xml: string, extra: Record<string, Buffer> = {}) => zipOf({ 'word/document.xml': body(xml), ...extra });
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** The smallest PDF with one text line; pdftotext reads it. */
const pdfOf = (text: string): Buffer => {
    const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets = objects.map((object, i) => {
        const at = out.length;
        out += `${i + 1} 0 obj\n${object}\nendobj\n`;
        return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
};
const encryptedPdf = () =>
    Buffer.from(
        '%PDF-1.6\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF\n'
    );
const png = () => {
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pixels]);
};

interface Delivered {
    id: string;
    name: string;
    mediaType: string;
    bytes: Buffer;
}
interface Entry {
    id: string;
    path: string;
    mediaType: string;
    derived?: { path: string; kind: string; truncated?: boolean };
    status?: string;
    reason?: string;
}

describe('the attachment extract script', () => {
    let target = '';
    beforeEach(() => {
        target = mkdtempSync(join(tmpdir(), 'attachment-extract-'));
    });
    afterEach(() => {
        chmodSync(target, 0o755);
        rmSync(target, { recursive: true, force: true });
    });

    /** Lays the directory out as the fetch script leaves it, then extracts. */
    async function extract(files: Delivered[], env: Record<string, string> = {}) {
        const list = files.map((file) => {
            const ext = file.name.slice(file.name.lastIndexOf('.'));
            writeFileSync(join(target, file.id + ext), file.bytes);
            return {
                id: file.id,
                name: file.name,
                mediaType: file.mediaType,
                size: file.bytes.length,
                sha256: sha(file.bytes),
                path: file.id + ext,
            };
        });
        writeFileSync(join(target, 'manifest.json'), JSON.stringify({ files: list }));
        const { stdout } = await run('node', ['--no-warnings', SCRIPT], {
            env: { ...process.env, TARGET_DIR: target, ...env },
            encoding: 'utf8',
        });
        const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { files: Entry[] };
        return {
            verdict: JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>,
            entries: manifest.files,
        };
    }
    const text = (path: string) => readFileSync(join(target, path), 'utf8');

    it('derives <id>.txt from a DOCX and points the manifest entry at it', async () => {
        const original = docx(paragraph('Heading') + paragraph(`${SENTENCE} &amp; more`));
        const { verdict, entries } = await extract([
            { id: ID(1), name: 'brief.docx', mediaType: DOCX, bytes: original },
        ]);

        expect(verdict).toMatchObject({ ok: true, derived: 1, unreadable: 0 });
        expect(entries[0]!.derived).toEqual({ path: `${ID(1)}.derived.txt`, kind: 'text' });
        expect(text(`${ID(1)}.derived.txt`)).toBe(`Heading\n${SENTENCE} & more\n`);
        expect(statSync(join(target, `${ID(1)}.derived.txt`)).mode & 0o777).toBe(0o444);
        expect(sha(readFileSync(join(target, `${ID(1)}.docx`)))).toBe(sha(original));
    });

    it('never overwrites an original: a DOCX delivered at <id>.txt keeps its bytes, the text goes to <id>.derived.txt', async () => {
        const original = docx(paragraph(SENTENCE));
        const { entries } = await extract([{ id: ID(9), name: 'x.txt', mediaType: DOCX, bytes: original }]);

        expect(entries[0]!.path).toBe(`${ID(9)}.txt`);
        expect(entries[0]!.derived!.path).toBe(`${ID(9)}.derived.txt`);
        expect(sha(readFileSync(join(target, `${ID(9)}.txt`)))).toBe(sha(original));
        expect(text(`${ID(9)}.derived.txt`)).toContain(SENTENCE);
    });

    it('reads headers, footers and footnotes too, after the body', async () => {
        const part = (root: string, inner: string) =>
            Buffer.from(`<?xml version="1.0"?><w:${root} xmlns:w="w">${inner}</w:${root}>`);
        const original = docx(paragraph('BODY-TEXT'), {
            'word/header1.xml': part('hdr', paragraph('HEADER-TEXT')),
            'word/footer1.xml': part('ftr', paragraph('FOOTER-TEXT')),
            'word/footnotes.xml': part('footnotes', paragraph('FOOTNOTE-TEXT')),
            'word/endnotes.xml': part('endnotes', paragraph('ENDNOTE-TEXT')),
        });
        const { entries } = await extract([{ id: ID(1), name: 'a.docx', mediaType: DOCX, bytes: original }]);
        const derived = text(entries[0]!.derived!.path);

        expect(derived.split('\n').filter(Boolean)).toEqual([
            'BODY-TEXT',
            'ENDNOTE-TEXT',
            'FOOTER-TEXT',
            'FOOTNOTE-TEXT',
            'HEADER-TEXT',
        ]);
        expect(entries[0]!.derived!.truncated).toBeUndefined();
    });

    it('marks the derived text truncated when a later part does not fit the shared cap', async () => {
        const huge = Buffer.from(`<w:hdr xmlns:w="w">${paragraph('y'.repeat(17 * 1024 * 1024))}</w:hdr>`);
        const { entries } = await extract([
            {
                id: ID(1),
                name: 'a.docx',
                mediaType: DOCX,
                bytes: docx(paragraph(SENTENCE), { 'word/header1.xml': huge }),
            },
        ]);

        expect(entries[0]!.derived).toEqual({ path: `${ID(1)}.derived.txt`, kind: 'text', truncated: true });
        expect(text(`${ID(1)}.derived.txt`)).toContain(SENTENCE);
    });

    it.each([
        ['a body cut after a paragraph', Buffer.from(`<w:document xmlns:w="w"><w:body>${paragraph(SENTENCE)}`)],
        ['a document with no closing body', Buffer.from(`<w:document xmlns:w="w">${paragraph(SENTENCE)}</w:document>`)],
        [
            'a tag cut off at the end',
            Buffer.from(`<w:document xmlns:w="w"><w:body>${paragraph(SENTENCE)}</w:body></w:docu`),
        ],
    ])('%s is unreadable (malformed), never partial text', async (_, xml) => {
        const { entries } = await extract([
            { id: ID(1), name: 'a.docx', mediaType: DOCX, bytes: zipOf({ 'word/document.xml': xml }) },
        ]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'malformed' });
        expect(entries[0]!.derived).toBeUndefined();
    });

    it('a malformed header makes the whole DOCX unreadable', async () => {
        const { entries } = await extract([
            {
                id: ID(1),
                name: 'a.docx',
                mediaType: DOCX,
                bytes: docx(paragraph(SENTENCE), { 'word/header1.xml': Buffer.from('<w:hdr xmlns:w="w"><w:p>') }),
            },
        ]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'malformed' });
    });

    it('never opens a macro part: a .docm-style package yields only its document text', async () => {
        const macro = Buffer.from('Sub AutoOpen() MsgBox "MACRO-MARKER" End Sub');
        const { entries } = await extract([
            {
                id: ID(2),
                name: 'm.docm',
                mediaType: DOCX,
                bytes: docx(paragraph(SENTENCE), { 'word/vbaProject.bin': macro }),
            },
        ]);

        expect(text(entries[0]!.derived!.path)).toContain(SENTENCE);
        expect(text(entries[0]!.derived!.path)).not.toContain('MACRO-MARKER');
    });

    it('a DOCX whose document inflates past the cap is unreadable (limit), within the time cap', async () => {
        const bomb = docx(paragraph('x'.repeat(17 * 1024 * 1024)));
        const started = Date.now();
        const { entries } = await extract([{ id: ID(3), name: 'bomb.docx', mediaType: DOCX, bytes: bomb }]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'limit' });
        expect(entries[0]!.derived).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(readdirSync(target).some((name) => name === `${ID(3)}.derived.txt`)).toBe(false);
    });

    it('a malformed zip is unreadable and its original stays', async () => {
        const junk = Buffer.from('PK\u0003\u0004 this is not a zip');
        const { entries } = await extract([{ id: ID(4), name: 'bad.docx', mediaType: DOCX, bytes: junk }]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'malformed' });
        expect(readFileSync(join(target, `${ID(4)}.docx`))).toEqual(junk);
    });

    it('an encrypted DOCX part is unreadable (encrypted)', async () => {
        const locked = zipOf({ 'word/document.xml': body(paragraph(SENTENCE)) }, { 'word/document.xml': 1 });
        const { entries } = await extract([{ id: ID(5), name: 'locked.docx', mediaType: DOCX, bytes: locked }]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'encrypted' });
    });

    it('an encrypted PDF is unreadable (encrypted)', async () => {
        const { entries } = await extract([{ id: ID(6), name: 'locked.pdf', mediaType: PDF, bytes: encryptedPdf() }]);

        expect(entries[0]).toMatchObject({ status: 'unreadable', reason: 'encrypted' });
    });

    it.skipIf(!hasPdftotext)(
        'derives <id>.txt from a PDF with pdftotext (skipped where poppler is not installed; the images carry it)',
        async () => {
            const original = pdfOf(SENTENCE);
            const { entries } = await extract([{ id: ID(7), name: 'doc.pdf', mediaType: PDF, bytes: original }]);

            expect(entries[0]!.derived).toEqual({ path: `${ID(7)}.derived.txt`, kind: 'text' });
            expect(text(`${ID(7)}.derived.txt`)).toContain(SENTENCE);
            expect(sha(readFileSync(join(target, `${ID(7)}.pdf`)))).toBe(sha(original));
        }
    );

    it('a PDF the tool cannot parse is unreadable, never dropped', async () => {
        const { entries } = await extract([
            { id: ID(8), name: 'broken.pdf', mediaType: PDF, bytes: Buffer.from('%PDF-1.4 truncated') },
        ]);

        expect(entries[0]!.status).toBe('unreadable');
        expect(['malformed', 'no_extractor']).toContain(entries[0]!.reason);
        expect(entries[0]!.path).toBe(`${ID(8)}.pdf`);
    });

    it('leaves images and text formats exactly as delivered, with no derived entry', async () => {
        const files: Delivered[] = [
            { id: ID(1), name: 'shot.png', mediaType: 'image/png', bytes: png() },
            { id: ID(2), name: 'a.csv', mediaType: 'text/csv', bytes: Buffer.from('a,b\n1,2\n') },
            { id: ID(3), name: 'a.md', mediaType: 'text/markdown', bytes: Buffer.from('# hi\n') },
            { id: ID(4), name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('plain\n') },
        ];
        const { verdict, entries } = await extract(files);

        expect(verdict).toMatchObject({ ok: true, derived: 0, unreadable: 0 });
        for (const entry of entries) expect(entry.derived ?? entry.status).toBeUndefined();
        expect(readdirSync(target).sort()).toEqual([...entries.map((e) => e.path), 'manifest.json'].sort());
        for (const [i, file] of files.entries())
            expect(readFileSync(join(target, entries[i]!.path))).toEqual(file.bytes);
    });

    it('is retry-safe: a second run, with a stale temp file beside, gives the same manifest', async () => {
        const files = [{ id: ID(1), name: 'brief.docx', mediaType: DOCX, bytes: docx(paragraph(SENTENCE)) }];
        const first = await extract(files);
        const again = await run('node', ['--no-warnings', SCRIPT], {
            env: { ...process.env, TARGET_DIR: target },
            encoding: 'utf8',
        });
        const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { files: Entry[] };

        expect(JSON.parse(again.stdout.trim())).toMatchObject({ ok: true, derived: 1 });
        expect(manifest.files).toEqual(first.entries);
        expect(readdirSync(target).filter((name) => name.endsWith('.part') || name.endsWith('.tmp'))).toEqual([]);
    });
});
