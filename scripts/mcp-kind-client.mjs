#!/usr/bin/env node
// The MCP client of the `mcp` phase of `scripts/test-k8s.sh --cluster`: one pass against the chart's board
// through the port-forward, as a client behind the ingress would reach it. No identity provider runs on kind, so the
// access token is minted into the database by the lane (the way it mints a personal access token) and this script
// presents it; the OAuth dance itself is exercised by `scripts/mcp-phase-client.mjs` on the docker lane.
//
//   MCP_BOARD=http://127.0.0.1:18080 MCP_PUBLIC_HOST=board.example MCP_TOKEN=mat_… node scripts/mcp-kind-client.mjs
//
// The board answers under its public host only (MCP_ENABLED origin policy), so every request but the wrong-host probe
// names it in X-Forwarded-Host, which is what an ingress controller does. stdout: one `ok\t<check>` or
// `bad\t<check>\t<detail>` line per check, which test-k8s.sh turns into its own.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The SDK is a dependency of the server workspace (server/package.json), not of the repository root: resolve it from there.
const fromServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
    pathToFileURL(fromServer.resolve('@modelcontextprotocol/client')).href
);

const BOARD = process.env.MCP_BOARD ?? '';
const PUBLIC_HOST = process.env.MCP_PUBLIC_HOST ?? '';
const TOKEN = process.env.MCP_TOKEN ?? '';
const MODERN = '2026-07-28';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const forwarded = { 'x-forwarded-host': PUBLIC_HOST };

const line = (kind, name, detail) =>
    console.log([kind, name, ...(detail === undefined ? [] : [String(detail).replace(/\s+/g, ' ')])].join('\t'));
let failed = false;
const check = (name, passed, detail) => {
    if (passed) line('ok', name);
    else {
        failed = true;
        line('bad', name, detail ?? '');
    }
    return passed;
};
const finish = () => process.exit(failed ? 1 : 0);

if (!BOARD || !PUBLIC_HOST || !TOKEN) {
    line('bad', 'mcp: MCP_BOARD, MCP_PUBLIC_HOST and MCP_TOKEN are set');
    process.exit(1);
}

const timed = (init = {}) => ({ signal: AbortSignal.timeout(15000), ...init });
const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 'test-k8s-mcp', version: '1' } },
});
const post = (headers) =>
    fetch(
        `${BOARD}/api/mcp`,
        timed({
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
            body: initialize,
        })
    );

try {
    // Discovery, the documents a client reads from the 401 challenge.
    const resourceDoc = await fetch(`${BOARD}/.well-known/oauth-protected-resource`, timed({ headers: forwarded }));
    const resource = resourceDoc.status === 200 ? await resourceDoc.json() : {};
    check(
        'mcp: the protected-resource document names the MCP endpoint under the public origin',
        resource.resource === `${PUBLIC_ORIGIN}/api/mcp`,
        `status ${resourceDoc.status}, resource ${resource.resource}`
    );
    const serverDoc = await fetch(`${BOARD}/.well-known/oauth-authorization-server`, timed({ headers: forwarded }));
    const authz = serverDoc.status === 200 ? await serverDoc.json() : {};
    check(
        'mcp: the authorization-server document carries the token endpoint',
        typeof authz.token_endpoint === 'string' && authz.token_endpoint.startsWith(PUBLIC_ORIGIN),
        `status ${serverDoc.status}, token_endpoint ${authz.token_endpoint}`
    );

    // The gates, in the order a request meets them: host, then credential.
    const wrongHost = await post({});
    check('mcp: a request under another host is refused 403', wrongHost.status === 403, `got ${wrongHost.status}`);
    const anonymous = await post(forwarded);
    const challenge = anonymous.headers.get('www-authenticate') ?? '';
    check(
        'mcp: an anonymous request is refused 401 with a resource_metadata challenge',
        anonymous.status === 401 && challenge.includes('resource_metadata='),
        `got ${anonymous.status} ${challenge}`
    );

    // One client pass: connect, list, call a read tool.
    const transport = new StreamableHTTPClientTransport(new URL(`${BOARD}/api/mcp`), {
        requestInit: { headers: { ...forwarded, authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client(
        { name: 'test-k8s-mcp', version: '1' },
        { versionNegotiation: { mode: { pin: MODERN } } }
    );
    await client.connect(transport);
    check('mcp: the SDK client connects with the minted token', true);
    const listed = await client.listTools();
    check(
        'mcp: tools/list carries whoami',
        listed.tools.some((tool) => tool.name === 'whoami'),
        `${listed.tools.length} tools`
    );
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    check(
        'mcp: whoami answers as the minted member',
        who.isError !== true && typeof who.structuredContent?.account?.login === 'string',
        JSON.stringify(who).slice(0, 200)
    );
    await client.close();
} catch (error) {
    check('mcp: the pass completes', false, error instanceof Error ? error.message : String(error));
}
finish();
