import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bundleFromZip } from '../src/skills/skill-bundle.js';
import { zipOfFiles } from '../src/skills/skill-zip.js';

const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
const EOCD_CENTRAL_OFFSET = 16;
const CENTRAL_CRC_OFFSET = 16;

describe('zipOfFiles', () => {
    it('writes each entry with the CRC32 of its bytes', () => {
        const files = [file('SKILL.md', 'hello\n'), file('b.txt', 'second')];
        const zip = zipOfFiles(files);
        let at = zip.readUInt32LE(zip.length - 22 + EOCD_CENTRAL_OFFSET);
        for (const f of files) {
            expect(zip.readUInt32LE(at)).toBe(0x02014b50);
            expect(zip.readUInt32LE(at + CENTRAL_CRC_OFFSET)).toBe(crc32(f.bytes));
            at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
        }
    });

    it('round-trips a nested path through the bundle codec', () => {
        const files = [file('SKILL.md', '---\nname: x\ndescription: d\n---\n'), file('scripts/deep/run.sh', 'echo\n')];
        const back = bundleFromZip('x', zipOfFiles(files)).files;
        expect(back.map((f) => [f.path, f.bytes.toString()])).toEqual(files.map((f) => [f.path, f.bytes.toString()]));
    });

    it('is deterministic', () => {
        const files = [file('SKILL.md', 'a'), file('z/y.txt', 'b')];
        expect(zipOfFiles(files).equals(zipOfFiles(files))).toBe(true);
    });
});
