/**
 * The few bytes of the POSIX tar format (pax interchange, `ustar` headers) an organization export needs: regular
 * files only, each a header block and its body padded to a block. A path past the 100-byte name field travels in a
 * pax `path` record, which GNU tar, bsdtar and every tar library read. No dependency carries this.
 */

const BLOCK = 512;
const OCTAL = 8;
const MS_PER_SECOND = 1000;
const FILE_MODE = 0o644;
const PAX_HEADER = 'x';
const REGULAR_FILE = '0';

/** The header fields this writer fills: byte offset and width. The rest stay zero. */
const NAME_AT = 0;
const NAME_BYTES = 100;
const MODE_AT = 100;
const UID_AT = 108;
const GID_AT = 116;
const ID_WIDTH = 8;
const SIZE_AT = 124;
const TIME_AT = 136;
const LONG_WIDTH = 12;
const CHECKSUM_AT = 148;
const CHECKSUM_DIGITS = 6;
const TYPE_AT = 156;
const MAGIC_AT = 257;

const encoder = new TextEncoder();

/** `value` as zero-padded octal filling `width - 1` bytes plus a NUL, the numeric field form. */
function octal(header: Uint8Array, offset: number, width: number, value: number): void {
    header.set(encoder.encode(`${value.toString(OCTAL).padStart(width - 1, '0')}\0`), offset);
}

function header(name: string, size: number, type: string, mtime: number): Uint8Array {
    const block = new Uint8Array(BLOCK);
    block.set(encoder.encode(name).subarray(0, NAME_BYTES), NAME_AT);
    octal(block, MODE_AT, ID_WIDTH, FILE_MODE);
    octal(block, UID_AT, ID_WIDTH, 0);
    octal(block, GID_AT, ID_WIDTH, 0);
    octal(block, SIZE_AT, LONG_WIDTH, size);
    octal(block, TIME_AT, LONG_WIDTH, mtime);
    // The checksum is summed with its own field read as spaces, then written as six digits, a NUL and a space.
    block.set(encoder.encode(' '.repeat(ID_WIDTH)), CHECKSUM_AT);
    block.set(encoder.encode(type), TYPE_AT);
    block.set(encoder.encode('ustar\x0000'), MAGIC_AT);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.set(encoder.encode(`${sum.toString(OCTAL).padStart(CHECKSUM_DIGITS, '0')}\0 `), CHECKSUM_AT);
    return block;
}

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** One pax record, `<length> <key>=<value>\n`, where the length counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array {
    const body = ` ${key}=${value}\n`;
    const bodyBytes = encoder.encode(body).length;
    let length = bodyBytes + 1;
    while (String(length).length + bodyBytes !== length) length += 1;
    return encoder.encode(`${length}${body}`);
}

/** The blocks of one regular file: a pax header first when the path does not fit the name field. */
export function tarFile(path: string, body: Uint8Array, mtime: Date): Uint8Array[] {
    const seconds = Math.floor(mtime.getTime() / MS_PER_SECOND);
    const blocks: Uint8Array[] = [];
    if (encoder.encode(path).length > NAME_BYTES) {
        const record = paxRecord('path', path);
        blocks.push(header('PaxHeader', record.length, PAX_HEADER, seconds), record, padding(record.length));
    }
    blocks.push(header(path, body.length, REGULAR_FILE, seconds), body, padding(body.length));
    return blocks;
}

/** The end of an archive: two zero blocks. A stream that stops before them is not a complete archive. */
export const TAR_END = new Uint8Array(BLOCK * 2);
