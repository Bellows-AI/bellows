import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3, header-signed, over the headers a request actually carries.
 * Pinned by AWS's own published GET-object vector in `server/test/artifacts.sigv4.test.ts`.
 */

export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string | undefined;
    /** Epoch milliseconds after which the credentials must be refetched; absent for static keys. */
    expiresAt?: number | undefined;
}

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const HEX_RADIX = 16;
const DATE_STAMP_LENGTH = 8;
const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, which `encodeURIComponent` is not quite: it leaves `!'()*` alone. */
const encode = (value: string): string =>
    encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`);

const encodePath = (path: string): string => path.split('/').map(encode).join('/');

/** `20130524T000000Z` */
export const amzDate = (now: Date): string => now.toISOString().replace(/[:-]|\.\d{3}/g, '');

export interface SignInput {
    method: string;
    url: URL;
    /** Extra headers to send and sign (`if-none-match`, `range`, encryption headers). */
    headers?: Record<string, string>;
    payloadHash: string;
    region: string;
    credentials: Credentials;
    now: Date;
}

/** Every header to put on the wire, `authorization` included. */
export function signRequest(input: SignInput): Record<string, string> {
    const { method, url, payloadHash, region, credentials, now } = input;
    const date = amzDate(now);
    const day = date.slice(0, DATE_STAMP_LENGTH);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim();
    headers.host = url.host;
    headers['x-amz-date'] = date;
    headers['x-amz-content-sha256'] = payloadHash;
    if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

    const names = Object.keys(headers).sort();
    const query = [...url.searchParams.entries()]
        .map(([k, v]) => [encode(k), encode(v)] as const)
        .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const canonical = [
        method,
        encodePath(url.pathname),
        query,
        // The block ends with its own newline, so `join` leaves the blank line the spec requires.
        `${names.map((n) => `${n}:${headers[n]}`).join('\n')}\n`,
        names.join(';'),
        payloadHash,
    ].join('\n');

    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return headers;
}
