// The provider-connection step every lane runs before it stores an executor (every executor selects one).
//   connection <board base> <baseUrl> [org|personal]  -> creates an anthropic connection aimed at <baseUrl> with the
//                                                        scripted model's key, prints its id; exit 1 and a reason on stderr otherwise
//   executors <connection id> [opencode [config json]] -> prints the PUT /api/workspace/executors body: a claude-code
//                                                        executor, plus an opencode one when asked, each selecting the connection
// The token comes from AUTH_HEADER (a full header value) or FACTORY_TOKEN (a bearer), whichever the lane sets.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SCRIPTED_KEY = 'fake-key';

/** The POST /api/provider-connections body: an anthropic connection whose endpoint is the scripted model. */
export const connectionBody = (baseUrl, scope = 'org') => ({
    scope,
    name: `lane-scripted-${randomUUID().slice(0, 8)}`,
    provider: 'anthropic',
    key: SCRIPTED_KEY,
    baseUrl,
});

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
        const response = await fetch(`${base}/api/provider-connections`, {
            method: 'POST',
            signal: AbortSignal.timeout(10000),
            headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
            body: JSON.stringify(connectionBody(baseUrl, scope)),
        }).catch((e) => fail(`POST /api/provider-connections never answered: ${e.message}`));
        const text = await response.text();
        let id = '';
        try {
            id = String(JSON.parse(text).id ?? '');
        } catch {}
        if (response.status !== 201 || id === '') {
            fail(`POST /api/provider-connections answered ${response.status}: ${text.slice(0, 200)}`);
        }
        process.stdout.write(id);
    } else if (mode === 'executors') {
        const [id, withOpencode, config] = args;
        process.stdout.write(JSON.stringify(executorsBody(id, withOpencode === 'opencode', config ? JSON.parse(config) : {})));
    } else {
        fail(`lane-connection: unknown mode ${mode}`);
    }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
