// The gitlab phase's member and the fake GitLab's lane door (scripts/lanes/jobs/gitlab.sh, scripts/test-k8s.sh). The fake
// serves https under the lane's own certificate: NODE_EXTRA_CA_CERTS names it, so this process trusts it.
//   node scripts/gitlab-member-client.mjs control <fake url> <path> [json]
//       POST <fake url>/_control/<path>; the answer's body on stdout
//   node scripts/gitlab-member-client.mjs connect <board url> <token> <fake url> <ca file> <group> <project path> <login>
//       connects the org to the fake, activates it as `login` and links the member as `login`, tracks the project
//       (the OAuth round trips are done here, no browser); the connection id on stdout. GITLAB_FAKE_REACH_URL, when
//       set, is where this process reaches the fake (a port-forward) while the board's <fake url> is how the board does.
//   node scripts/gitlab-member-client.mjs summary <calls.jsonl> <project path> [skip calls]
//       what the fake's call log says of the project's git traffic after the first <skip> calls, as lines:
//         calls <n>                      the log's length (the next <skip>)
//         pushes <n>                     the pushes after <skip>
//         push <holder>|<token kind>|<author>|<author email>|<committer>   the last push after <skip>, if any
//         git <token id>:<status>:<holder>   each git call after <skip>, in order
// Exit 1 and stderr on a failure.
import { existsSync, readFileSync } from 'node:fs';

const TIMEOUT_MS = 15_000;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_SEE_OTHER = 303;
const CLIENT_SECRET_BYTES = 12;
const CALLBACK_PATH = '/api/forge-grants/gitlab/callback';
const fail = (message) => {
    console.error(`gitlab-member-client: ${message}`);
    process.exit(1);
};
const call = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

const [mode, ...args] = process.argv.slice(2);

if (mode === 'control') {
    const [fake, path, json = '{}'] = args;
    if (!fake || !path) fail('control needs a fake url and a path');
    const answer = await call(`${fake}/_control/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json,
    });
    if (answer.status !== HTTP_OK) fail(`${path} answered ${answer.status}`);
    process.stdout.write(await answer.text());
} else if (mode === 'summary') {
    const [file, project, skip = '0'] = args;
    if (!file || !project) fail('summary needs a calls file and a project path');
    const calls = existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];
    const fresh = calls.slice(Number(skip));
    const pushes = fresh.filter((call) => call.event === 'push' && call.project === project);
    const last = pushes.at(-1);
    const commit = last?.refs?.[0]?.commits?.[0];
    const git = fresh.filter((call) => call.event !== 'push' && call.path?.startsWith(`/${project}.git/`));
    const lines = [
        `calls ${calls.length}`,
        `pushes ${pushes.length}`,
        `push ${last ? [last.holder, last.tokenKind, commit?.author?.name, commit?.author?.email, commit?.committer?.name].join('|') : ''}`,
        ...git.map((call) => `git ${call.tokenId}:${call.status}:${call.holder}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
} else if (mode === 'connect') {
    const [board, token, fake, caFile, group, project, login] = args;
    if (!login) fail('connect needs a board, token, fake url, ca file, group, project and login');
    const host = new URL(fake).host;
    const reach = process.env.GITLAB_FAKE_REACH_URL ?? fake;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: board };
    const clientId = `lane-app-${login}`;
    const clientSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(CLIENT_SECRET_BYTES))).toString('hex');
    const registered = await call(`${reach}/_control/gitlab/oauth-clients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            clientId,
            clientSecret,
            scopes: ['api', 'read_user'],
            redirectUris: [`${board}${CALLBACK_PATH}`],
        }),
    });
    if (registered.status !== HTTP_OK) fail(`registering the OAuth application answered ${registered.status}`);

    const created = await call(`${board}/api/org/gitlab-connections`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            host,
            clientId,
            clientSecret,
            allowedGroups: [group],
            caBundle: readFileSync(caFile, 'utf8'),
        }),
    });
    if (created.status !== HTTP_CREATED) fail(`creating the connection answered ${created.status}: ${await created.text()}`);
    const { id } = await created.json();

    /** One OAuth round trip: start, authorize as `login` at the fake, hand the code back to the board's callback. */
    const roundTrip = async (path) => {
        const started = await call(`${board}${path}`, { method: 'POST', headers, body: '{}' });
        if (started.status !== HTTP_CREATED) fail(`${path} answered ${started.status}: ${await started.text()}`);
        const url = new URL((await started.json()).authorizeUrl);
        const reachable = new URL(reach);
        url.protocol = reachable.protocol;
        url.host = reachable.host;
        url.searchParams.set('login', login);
        const authorized = await call(url);
        const back = new URL(authorized.headers.get('location') ?? '', board);
        const done = await call(`${board}${CALLBACK_PATH}${back.search}`, { headers });
        const result = new URL(done.headers.get('location') ?? '', board).searchParams.get('result');
        if (done.status !== HTTP_SEE_OTHER || result === null) fail(`${path} ended ${done.status}, result ${result}`);
        return result;
    };
    if ((await roundTrip(`/api/org/gitlab-connections/${id}/activation`)) !== 'activated') fail('activation failed');
    if ((await roundTrip(`/api/forge-grants/gitlab/${id}/link`)) !== 'linked') fail('linking failed');

    const tracked = await call(`${board}/api/org/gitlab-connections/${id}/tracked-repos`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ paths: [project] }),
    });
    if (tracked.status !== HTTP_OK) fail(`tracking the project answered ${tracked.status}: ${await tracked.text()}`);
    process.stdout.write(id);
} else {
    fail('usage: control <fake url> <path> [json] | summary <calls.jsonl> <project> [skip] | connect <board> <token> <fake url> <ca file> <group> <project> <login>');
}
