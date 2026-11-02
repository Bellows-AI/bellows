import { deflateSync } from 'node:zlib';
import type { Locator } from '@playwright/test';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes: Buffer): number {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A real, decodable gradient PNG: a thumbnail only counts as shown when its `naturalWidth` is > 0. */
export function gradientPng(width = 96, height = 72): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const at = y * (width * 3 + 1);
        for (let x = 0; x < width; x += 1) {
            rows[at + 1 + x * 3] = Math.round((x / width) * 255);
            rows[at + 2 + x * 3] = Math.round((y / height) * 255);
            rows[at + 3 + x * 3] = 160;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Fire one drag event carrying files at `target`, the way the browser does for a file dragged in
 * from the desktop. `type` is dragenter, dragover, dragleave or drop.
 */
export async function dragFiles(
    target: Locator,
    type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
    names: readonly string[]
): Promise<void> {
    await target.evaluate(
        (node, args) => {
            const data = new DataTransfer();
            for (const name of args.names) data.items.add(new File(['x'], name, { type: 'text/plain' }));
            node.dispatchEvent(new DragEvent(args.type, { dataTransfer: data, bubbles: true, cancelable: true }));
        },
        { type, names }
    );
}
