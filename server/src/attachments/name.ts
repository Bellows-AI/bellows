/**
 * The display name of an uploaded file: a label shown to people and written into the task prompt,
 * never a path and never part of an object key. Path separators are neutralized, anything that
 * could confuse a terminal or a header is refused.
 */

const MAX_NAME_BYTES = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SEPARATORS = /[/\\]/gu;

export type NameResult = { ok: true; name: string } | { ok: false };

export function normalizeAttachmentName(raw: string): NameResult {
    const normal = raw.normalize('NFC');
    if (CONTROL.test(normal)) return { ok: false };
    const name = normal.replace(SEPARATORS, '_').trim();
    if (name === '' || name === '.' || name === '..') return { ok: false };
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return { ok: false };
    return { ok: true, name };
}
