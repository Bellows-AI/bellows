/**
 * TEST-ONLY: an in-process Google Cloud Secret Manager that answers the adapter's `fetch` seam with the REST
 * shapes the service documents (resource names carry the project NUMBER, errors are `{error:{code,status,message}}`),
 * so the real request, response and error mapping code runs and no cloud, port or compose service is needed.
 * It records every request, and with `fence` it enforces the production IAM condition: any call on a secret whose
 * name does not start with the prefix, and every list, is refused with PERMISSION_DENIED, as the service refuses
 * a principal without those rights. Secret creation is checked on the project, so it is never fenced.
 */

export const GCP_TEST_PROJECT = 'test-project';
export const GCP_TEST_PROJECT_NUMBER = '123456789';
export const GCP_TEST_ENDPOINT = 'https://secretmanager.test';

const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/;
const HTTP_OK = 200;

interface StoredSecret {
    replication: unknown;
    /** Version number 1 is `versions[0]`; null once destroyed. */
    versions: (Buffer | null)[];
}

export interface RecordedRequest {
    method: string;
    path: string;
    secretId: string | null;
    body: unknown;
}

const error = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code: status, status: code, message } }), { status });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: HTTP_OK });

export interface GcpEmulator {
    fetch: typeof fetch;
    requests: RecordedRequest[];
    /** Secret ids stored under a prefix. */
    names(prefix: string): string[];
    /** The bytes of a secret's first version, or null. */
    first(secretId: string): Buffer | null;
    /** Puts a secret straight into the store, bypassing the REST surface and the record. */
    seed(secretId: string, versions: (Buffer | null)[]): void;
    drop(secretId: string): void;
}

export function createGcpEmulator(options: { fence?: string } = {}): GcpEmulator {
    const secrets = new Map<string, StoredSecret>();
    const requests: RecordedRequest[] = [];
    const parent = `projects/${GCP_TEST_PROJECT_NUMBER}`;
    const secretName = (id: string) => `${parent}/secrets/${id}`;
    const denied = () => error(403, 'PERMISSION_DENIED', 'Permission denied on resource.');
    const missing = (id: string) => error(404, 'NOT_FOUND', `Secret [${secretName(id)}] not found or has no versions.`);

    async function handle(url: URL, init: RequestInit): Promise<Response> {
        const method = init.method ?? 'GET';
        const path = url.pathname;
        const root = `/v1/projects/${GCP_TEST_PROJECT}/secrets`;
        let body: unknown = null;
        if (typeof init.body === 'string') {
            body = JSON.parse(init.body);
        }
        const rest = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
        const [, rawId = '', action = ''] = /^([^:/]*)(.*)$/.exec(rest ?? '') ?? [];
        const secretId = rest === null ? null : decodeURIComponent(rawId);
        requests.push({ method, path: `${path}${url.search}`, secretId, body });

        const fenced = (id: string) => options.fence !== undefined && !id.startsWith(options.fence);
        if (!init.headers || !(init.headers as Record<string, string>).authorization?.startsWith('Bearer ')) {
            return error(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
        }
        if (path === root && method === 'POST') {
            const id = url.searchParams.get('secretId') ?? '';
            if (!SECRET_ID.test(id)) {
                return error(400, 'INVALID_ARGUMENT', 'Secret ID is invalid.');
            }
            if (secrets.has(id)) {
                return error(409, 'ALREADY_EXISTS', `Secret [${secretName(id)}] already exists.`);
            }
            secrets.set(id, { replication: (body as { replication: unknown }).replication, versions: [] });
            return ok({ name: secretName(id), replication: (body as { replication: unknown }).replication });
        }
        if (secretId === null || path === root) {
            return denied();
        }
        if (fenced(secretId)) {
            return denied();
        }
        const secret = secrets.get(secretId);
        if (method === 'POST' && action === ':addVersion') {
            if (!secret) {
                return missing(secretId);
            }
            const data = Buffer.from((body as { payload: { data: string } }).payload.data, 'base64');
            secret.versions.push(data);
            return ok({ name: `${secretName(secretId)}/versions/${secret.versions.length}`, state: 'ENABLED' });
        }
        if (method === 'GET' && action.startsWith('/versions/') && action.endsWith(':access')) {
            const number = Number(action.slice('/versions/'.length, -':access'.length));
            if (!secret) {
                return missing(secretId);
            }
            const data = secret.versions[number - 1];
            if (data === undefined) {
                return error(
                    404,
                    'NOT_FOUND',
                    `Secret Version [${secretName(secretId)}/versions/${number}] not found.`
                );
            }
            if (data === null) {
                return error(400, 'FAILED_PRECONDITION', 'Secret Version is in DESTROYED state.');
            }
            return ok({
                name: `${secretName(secretId)}/versions/${number}`,
                payload: { data: data.toString('base64') },
            });
        }
        if (method === 'DELETE' && action === '') {
            if (!secret) {
                return missing(secretId);
            }
            secrets.delete(secretId);
            return ok({});
        }
        return error(400, 'INVALID_ARGUMENT', 'Unsupported request.');
    }

    return {
        fetch: (async (url: string | URL, init?: RequestInit) =>
            handle(new URL(String(url)), init ?? {})) as typeof fetch,
        requests,
        names: (prefix) => [...secrets.keys()].filter((id) => id.startsWith(prefix)).sort(),
        first: (id) => secrets.get(id)?.versions[0] ?? null,
        seed: (id, versions) => {
            secrets.set(id, { replication: null, versions });
        },
        drop: (id) => {
            secrets.delete(id);
        },
    };
}

/** The emulator the conformance harness shares across replicas and reopened stores. */
export const sharedGcpEmulator = createGcpEmulator();
