import { crc32 } from 'node:zlib';
import type { BundleFile } from './skill-bundle.js';

const U16 = 2;
const U32 = 4;
const UNIX_HOST_VERSION = (3 << 8) | 20;
const NEEDS_VERSION = 20;
const UTF8_FLAG = 0x0800;
const DOS_DATE_1980 = 0x21;
const FILE_MODE = 0o100644;
const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };
const SHIFT_MODE = 16;

type Field = readonly [width: typeof U16 | typeof U32, value: number];

/** Little-endian fields written back to back, in the order the zip format lays them out. */
function record(fields: Field[]): Buffer {
    const out = Buffer.alloc(fields.reduce((sum, [width]) => sum + width, 0));
    let at = 0;
    for (const [width, value] of fields) {
        if (width === U16) out.writeUInt16LE(value, at);
        else out.writeUInt32LE(value, at);
        at += width;
    }
    return out;
}

/** A stored (method 0) zip of the files, byte-identical for the same input: fixed DOS time, unix mode, CRC32 per entry. */
export function zipOfFiles(files: BundleFile[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.path, 'utf8');
        const size = file.bytes.length;
        const crc = crc32(file.bytes);
        const local = record([
            [U32, SIGNATURE.local],
            [U16, NEEDS_VERSION],
            [U16, UTF8_FLAG],
            [U16, 0], // method: stored
            [U16, 0], // DOS time
            [U16, DOS_DATE_1980],
            [U32, crc],
            [U32, size],
            [U32, size],
            [U16, name.length],
            [U16, 0], // extra length
        ]);
        const central = record([
            [U32, SIGNATURE.central],
            [U16, UNIX_HOST_VERSION],
            [U16, NEEDS_VERSION],
            [U16, UTF8_FLAG],
            [U16, 0], // method: stored
            [U16, 0], // DOS time
            [U16, DOS_DATE_1980],
            [U32, crc],
            [U32, size],
            [U32, size],
            [U16, name.length],
            [U16, 0], // extra length
            [U16, 0], // comment length
            [U16, 0], // disk number
            [U16, 0], // internal attributes
            [U32, (FILE_MODE << SHIFT_MODE) >>> 0],
            [U32, offset],
        ]);
        locals.push(local, name, file.bytes);
        centrals.push(central, name);
        offset += local.length + name.length + size;
    }
    const directory = Buffer.concat(centrals);
    const end = record([
        [U32, SIGNATURE.end],
        [U16, 0], // this disk
        [U16, 0], // directory disk
        [U16, files.length],
        [U16, files.length],
        [U32, directory.length],
        [U32, offset],
        [U16, 0], // comment length
    ]);
    return Buffer.concat([...locals, directory, end]);
}
