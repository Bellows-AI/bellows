import { createHash } from 'node:crypto';

/**
 * A ustar tar as the board stores a skill bundle (`server/src/skills/skill-bundle.ts`: regular files, mode 0644, mtime 0),
 * plus the hostile shapes the install script must refuse. Built here, byte by byte, because the script is the reader
 * under test: nothing of the board's writer is imported.
 */
const BLOCK = 512;

export interface TarEntry {
    path: string;
    body?: string;
    /** The ustar type flag: `0` file (default), `5` directory, `2` symlink, `x` pax header. */
    type?: string;
    /** Corrupts the checksum field. */
    badChecksum?: boolean;
}

const header = (entry: TarEntry): Buffer => {
    const block = Buffer.alloc(BLOCK);
    const size = Buffer.byteLength(entry.body ?? '');
    const bytes = Buffer.from(entry.path);
    const split = bytes.length > 100 ? entry.path.lastIndexOf('/', 100) : -1;
    block.write(split === -1 ? entry.path : entry.path.slice(split + 1), 0, 100, 'utf8');
    block.write('0000644\0', 100, 'ascii');
    block.write('0000000\0', 108, 'ascii');
    block.write('0000000\0', 116, 'ascii');
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    block.write('00000000000\0', 136, 'ascii');
    block.fill(0x20, 148, 156);
    block.write(entry.type ?? '0', 156, 'ascii');
    block.write('ustar\0', 257, 'ascii');
    block.write('00', 263, 'ascii');
    if (split !== -1) block.write(entry.path.slice(0, split), 345, 155, 'utf8');
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${(entry.badChecksum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return block;
};

export const tarOf = (entries: readonly TarEntry[], { endMarker = true } = {}): Buffer => {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        const body = Buffer.from(entry.body ?? '');
        parts.push(header(entry), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
    }
    if (endMarker) parts.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(parts);
};

export const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** One pinned version: the tar the board would serve, and the pin entry that names it. */
export const skillOf = (
    name: string,
    versionId: string,
    files: Record<string, string> = { 'SKILL.md': `---\nname: ${name}\n---\n${name}\n` },
    source: 'org' | 'workspace' = 'org'
) => {
    const tar = tarOf(Object.entries(files).map(([path, body]) => ({ path, body })));
    return { tar, pin: { name, source, versionId, sha256: sha256Of(tar) } };
};
