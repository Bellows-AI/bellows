/**
 * The object key layout (openspec/changes/task-owned-runner/design.md, "artifact store"):
 * `<prefix>/<org>/<member>/<root>/<job>/<claimSeq>/<executor>/<session>/<stream>/<offset:012>`.
 * Ids and integers only, never names, so every segment is a plain ASCII token and a key needs no
 * escaping on any backend.
 */

/** Which stream of which session of which attempt a chunk or manifest belongs to, below the org. */
export interface StreamRef {
    member: string;
    root: string;
    job: string;
    claimSeq: number;
    executor: string;
    session: string;
    stream: string;
}

/** A segment is one path component: no separator, no dot-only name, nothing a backend would rewrite. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OFFSET_DIGITS = 12;
const OFFSET_SEGMENT = new RegExp(`^\\d{${OFFSET_DIGITS}}$`);
const CHUNK_KEY_PARTS = 9;
/** 10^12 − 1 bytes, the largest offset the zero-padded key can order. */
const MAX_OFFSET = 10 ** OFFSET_DIGITS - 1;

/** Whether `value` is a plain key segment — what a caller-named coordinate must be before a key is built from it. */
export const isKeySegment = (value: string): boolean => SEGMENT.test(value);

export class InvalidKeyError extends Error {}

function segment(name: string, value: string): string {
    if (!SEGMENT.test(value)) throw new InvalidKeyError(`${name} is not a valid key segment`);
    return value;
}

function count(name: string, value: number, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new InvalidKeyError(`${name} is out of range`);
    return value;
}

/** Throws `InvalidKeyError` unless every part of the ref is a legal key segment. */
export function checkStreamRef(orgId: string, ref: StreamRef): void {
    segment('org', orgId);
    segment('memberId', ref.member);
    segment('root', ref.root);
    segment('job', ref.job);
    count('claimSeq', ref.claimSeq);
    segment('executor', ref.executor);
    segment('session', ref.session);
    segment('stream', ref.stream);
}

export function streamPrefix(prefix: string, orgId: string, ref: StreamRef): string {
    checkStreamRef(orgId, ref);
    return `${prefix}${orgId}/${ref.member}/${ref.root}/${ref.job}/${ref.claimSeq}/${ref.executor}/${ref.session}/${ref.stream}`;
}

/** `prefix` carries its own trailing slash (`factory/`), or is empty. */
export function chunkKey(prefix: string, orgId: string, ref: StreamRef, offset: number): string {
    count('offset', offset, MAX_OFFSET);
    return `${streamPrefix(prefix, orgId, ref)}/${String(offset).padStart(OFFSET_DIGITS, '0')}`;
}

/** The org a key belongs to, or null when the key is not under `prefix` or is not shaped like a chunk key. */
export function parseChunkKey(prefix: string, key: string): { orgId: string; ref: StreamRef; offset: number } | null {
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split('/');
    const [orgId, member, root, job, claimSeq, executor, session, stream, offset] = parts;
    if (parts.length !== CHUNK_KEY_PARTS || !/^\d+$/.test(claimSeq!) || !OFFSET_SEGMENT.test(offset!)) return null;
    const ref: StreamRef = {
        member: member!,
        root: root!,
        job: job!,
        claimSeq: Number(claimSeq),
        executor: executor!,
        session: session!,
        stream: stream!,
    };
    try {
        checkStreamRef(orgId!, ref);
    } catch {
        return null;
    }
    return { orgId: orgId!, ref, offset: Number(offset) };
}
