import { describe, expect, it } from 'vitest';
import { createGcsStore } from '../src/artifacts/gcs-store.js';
import { createS3Store } from '../src/artifacts/s3-store.js';

/**
 * A listing is what licenses an org purge to call a prefix empty (`org-purge.ts`), so only a well-formed answer
 * counts: a 200 whose body is not a complete listing rejects, and never reads as an empty one (AGENTS.md).
 */

const answering = (body: string) => (async () => new Response(body, { status: 200 })) as typeof fetch;

const s3 = (body: string) =>
    createS3Store({
        bucket: 'bkt',
        region: 'us-east-1',
        endpoint: 'http://s3.test',
        forcePathStyle: true,
        kmsKeyId: '',
        credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
        fetch: answering(body),
    });

const gcs = (body: string) =>
    createGcsStore({ bucket: 'bkt', kmsKey: '', token: async () => 'tok', fetch: answering(body) });

const listing = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>bkt</Name><Prefix>p/</Prefix>${inner}<MaxKeys>1000</MaxKeys></ListBucketResult>`;

describe('S3 list answers', () => {
    it('reads every key of a complete listing, entities decoded', async () => {
        const body = listing(
            '<KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>' +
                '<Contents><Key>p/a</Key><Size>1</Size></Contents><Contents><Key>p/b&amp;c</Key></Contents>'
        );
        expect(await s3(body).list('p/')).toEqual(['p/a', 'p/b&c']);
    });

    it('reads a complete empty listing as empty', async () => {
        expect(await s3(listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated>')).list('p/')).toEqual([]);
    });

    it.each([
        ['a cut-off body', '<ListBucketResult><Contents>'],
        [
            'no closing element',
            listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated>').replace('</ListBucketResult>', ''),
        ],
        ['no KeyCount', listing('<IsTruncated>false</IsTruncated>')],
        ['no IsTruncated', listing('<KeyCount>0</KeyCount>')],
        [
            'a KeyCount the keys do not match',
            listing('<KeyCount>2</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>p/a</Key></Contents>'),
        ],
        [
            'an entry without a key',
            listing('<KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Size>1</Size></Contents>'),
        ],
        ['an unclosed entry', listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated><Contents>')],
        ['a truncated page with no keys', listing('<KeyCount>0</KeyCount><IsTruncated>true</IsTruncated>')],
        ['an error document', '<Error><Code>InternalError</Code></Error>'],
        ['not XML at all', '{}'],
        ['an empty body', ''],
        ['a self-closed entry', listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated><Contents/>')],
        [
            'an entry tag with a space',
            listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated><Contents ><Key>p/a</Key></Contents>'),
        ],
        ['an unclosed spaced entry', listing('<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated><Contents >')],
        [
            'an entry with attributes',
            listing('<KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents x="1"><Key>p/a</Key></Contents>'),
        ],
        [
            'an empty key',
            listing('<KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key></Key></Contents>'),
        ],
        [
            'a self-closed key',
            listing('<KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key/></Contents>'),
        ],
        ['two KeyCounts', listing('<KeyCount>0</KeyCount><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated>')],
        [
            'grouped prefixes it never asked for',
            listing(
                '<KeyCount>0</KeyCount><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>p/a/</Prefix></CommonPrefixes>'
            ),
        ],
    ])('rejects %s', async (_name, body) => {
        await expect(s3(body).list('p/')).rejects.toThrow();
    });
});

describe('GCS list answers', () => {
    it('reads every name of a listing, and asks for the fields that prove it complete', async () => {
        const calls: string[] = [];
        const store = createGcsStore({
            bucket: 'bkt',
            kmsKey: '',
            token: async () => 'tok',
            fetch: (async (url: string) => {
                calls.push(String(url));
                return Response.json({ kind: 'storage#objects', items: [{ name: 'p/a' }] });
            }) as typeof fetch,
        });
        expect(await store.list('p/')).toEqual(['p/a']);
        expect(new URL(calls[0]!).searchParams.get('fields')).toBe('kind,nextPageToken,items(name)');
    });

    it('reads a listing with no items as empty', async () => {
        expect(await gcs(JSON.stringify({ kind: 'storage#objects' })).list('p/')).toEqual([]);
    });

    it.each([
        ['a top-level array', '[]'],
        ['null', 'null'],
        ['an object with no kind', '{}'],
        ['another kind', JSON.stringify({ kind: 'storage#object' })],
        ['items that are not a list', JSON.stringify({ kind: 'storage#objects', items: {} })],
        ['an item with no name', JSON.stringify({ kind: 'storage#objects', items: [{}] })],
        ['a next page with no items', JSON.stringify({ kind: 'storage#objects', nextPageToken: 't' })],
        ['not JSON', '<html>'],
        ['a field it never asked for', JSON.stringify({ kind: 'storage#objects', prefixes: ['p/a/'] })],
        [
            'an item with more than a name',
            JSON.stringify({ kind: 'storage#objects', items: [{ name: 'p/a', size: '1' }] }),
        ],
        ['an empty name', JSON.stringify({ kind: 'storage#objects', items: [{ name: '' }] })],
        [
            'a page token that is not a string',
            JSON.stringify({ kind: 'storage#objects', items: [{ name: 'p/a' }], nextPageToken: 1 }),
        ],
    ])('rejects %s', async (_name, body) => {
        await expect(gcs(body).list('p/')).rejects.toThrow();
    });
});
