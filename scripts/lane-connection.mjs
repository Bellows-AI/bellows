// The provider-connection step every lane runs before it stores an executor (every executor selects one).
//   connection <board base> <baseUrl> [org|personal]  -> ensures an anthropic connection aimed at <baseUrl> with the
//                                                        scripted model's key and prints its id; one connection per
//                                                        (baseUrl, scope), reused by every call and retry; exit 1 and a
//                                                        reason on stderr otherwise
//   executors <connection id> [opencode [config json]] -> prints the PUT /api/workspace/executors body: a claude-code
//                                                        executor, plus an opencode one when asked, each selecting the connection
// The token comes from AUTH_HEADER (a full header value) or FACTORY_TOKEN (a bearer), whichever the lane sets.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SCRIPTED_KEY = 'fake-key';

const PROVIDER_CONNECTIONS = '/api/provider-connections';
const HTTP_CREATED = 201;
const HTTP_CONFLICT = 409;

/** The name one (endpoint, scope) pair always gets, so a retry finds its connection instead of filling the scope's cap. */
export const connectionName = (baseUrl, scope = 'org') =>
    `lane-${createHash('sha256').update(`${scope}\n${baseUrl}`).digest('hex').slice(0, 12)}`;

/** The POST /api/provider-connections body: an anthropic connection whose endpoint is the scripted model. */
export const connectionBody = (baseUrl, scope = 'org') => ({
    scope,
    name: connectionName(baseUrl, scope),
    provider: 'anthropic',
    key: SCRIPTED_KEY,
    baseUrl,
});

/**
 * The id of the connection for (baseUrl, scope): the listed one whose name and baseUrl match, else a new one. A name
 * conflict on create means a concurrent call made it, so the list is read again. `request(path, init)` answers a fetch
 * Response (the caller adds its own origin, credentials and timeout); throws a reason when no id comes out.
 */
export async function ensureConnectionId(request, baseUrl, scope = 'org') {
    const body = connectionBody(baseUrl, scope);
    const find = async () => {
        const listed = await request(PROVIDER_CONNECTIONS);
        if (listed.status !== 200) throw new Error(`GET ${PROVIDER_CONNECTIONS} answered ${listed.status}`);
        const rows = (await listed.json().catch(() => ({}))).connections ?? [];
        return rows.find((row) => row.name === body.name && row.baseUrl === baseUrl)?.id ?? '';
    };
    const existing = await find();
    if (existing !== '') return existing;
    const created = await request(PROVIDER_CONNECTIONS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await created.text();
    if (created.status === HTTP_CREATED) {
        let id = '';
        try {
            id = String(JSON.parse(text).id ?? '');
        } catch {}
        if (id !== '') return id;
    } else if (created.status === HTTP_CONFLICT) {
        const raced = await find();
        if (raced !== '') return raced;
    }
    throw new Error(`POST ${PROVIDER_CONNECTIONS} answered ${created.status}: ${text.slice(0, 200)}`);
}

/** The PUT /api/workspace/executors body: claude-code, plus opencode (with its config) when asked, each selecting the connection. */
export const executorsBody = (providerConnectionId, withOpencode = false, config = {}) => ({
    executors: [
        { name: 'claude', type: 'claude-code', config: {}, providerConnectionId },
        ...(withOpencode ? [{ name: 'opencode', type: 'opencode', config, providerConnectionId }] : []),
    ],
});

const main = async () => {
    const [mode, ...args] = process.argv.slice(2);
    const auth = process.env.AUTH_HEADER || (process.env.FACTORY_TOKEN ? `Bearer ${process.env.FACTORY_TOKEN}` : '');
    const fail = (reason) => {
        process.stderr.write(`${reason}\n`);
        process.exit(1);
    };
    if (mode === 'connection') {
        const [base, baseUrl, scope] = args;
        const request = (path, init = {}) =>
            fetch(`${base}${path}`, {
                ...init,
                signal: AbortSignal.timeout(10000),
                headers: { ...init.headers, ...(auth ? { authorization: auth } : {}) },
            });
        process.stdout.write(await ensureConnectionId(request, baseUrl, scope).catch((e) => fail(e.message)));
    } else if (mode === 'executors') {
        const [id, withOpencode, config] = args;
        process.stdout.write(JSON.stringify(executorsBody(id, withOpencode === 'opencode', config ? JSON.parse(config) : {})));
    } else {
        fail(`lane-connection: unknown mode ${mode}`);
    }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
