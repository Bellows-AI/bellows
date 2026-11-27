// Takes one organization's erasure request from intake to a confirmed purge, through the board operator's routes
// (docs/organizations.md): show what will be deleted and ask, suspend the org, queue its purge, wait until the board
// reports the org gone, print a receipt. No database access; the org's data is removed by the board's own purge.
// Usage: FACTORY_URL=https://board.example FACTORY_TOKEN=fat_… node scripts/org-erasure.mjs <org-id> [--yes]
//          [--poll-seconds N] [--timeout-minutes N]
// FACTORY_TOKEN is the operator's personal access token (a GitHub id in the board's OPERATOR_GITHUB_IDS).
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const NOT_FOUND = 404;
const NOT_FOUND_CODE = 'NOT_FOUND';
const DEFAULT_POLL_SECONDS = 10;
const DEFAULT_TIMEOUT_MINUTES = 120;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

/** The retention a receipt promises: Cloud SQL backups and point-in-time logs are kept 7 days. */
export const BACKUP_DAYS = 7;

export const receiptText = ({ orgId, orgName, requestedAt, confirmedAt }) =>
    [
        'Organization erasure receipt',
        `  Organization id:        ${orgId}`,
        `  Organization name:      ${orgName}`,
        `  Requested:              ${requestedAt}`,
        `  Purge confirmed:        ${confirmedAt} (the board no longer has the organization)`,
        '',
        `Copies of the organization's data leave database backups and point-in-time logs within ${BACKUP_DAYS} days of the purge.`,
        '',
        'Manual steps this script does not take:',
        '  - Revoke or uninstall the GitHub App installation for this organization on GitHub (the customer can do this too).',
        '  - Erasing one person’s account across organizations is not covered; it is a separate request.',
    ].join('\n');

/** One authenticated call. Never throws: a failed or malformed answer is `{ status: null }`, which is inconclusive. */
async function call(ctx, method, path) {
    try {
        const res = await ctx.fetch(`${ctx.baseUrl}${path}`, {
            method,
            headers: { authorization: `Bearer ${ctx.token}` },
        });
        let body = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { status: res.status, body };
    } catch {
        return { status: null, body: null };
    }
}

const orgPath = (orgId) => `/api/operator/orgs/${encodeURIComponent(orgId)}`;
const isGone = (r) => r.status === NOT_FOUND && r.body?.code === NOT_FOUND_CODE;
const isOrg = (r) => r.status === 200 && typeof r.body?.org?.id === 'string';

export function summaryText(org) {
    const lines = [
        `Organization ${org.id} (${org.name}), status ${org.status}`,
        `  members: ${org.members}`,
        `  threads: ${org.threads}`,
        `  stored objects (artifact manifests): ${org.objects}`,
    ];
    if (org.purge) lines.push(`  purge already queued at ${org.purge.requestedAt}, step ${org.purge.step}`);
    return lines.join('\n');
}

/**
 * Runs the erasure. `confirm(summary)` answers whether to go on; `yes` skips it. Resolves `{ ok, receipt }` only once
 * a read confirms the org gone; a timeout or a refused step resolves `{ ok: false, reason }`.
 */
export async function eraseOrg({
    baseUrl,
    token,
    orgId,
    yes = false,
    confirm = async () => false,
    out = console.log,
    fetch: fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    pollMs = DEFAULT_POLL_SECONDS * MS_PER_SECOND,
    timeoutMs = DEFAULT_TIMEOUT_MINUTES * MS_PER_MINUTE,
}) {
    const ctx = { baseUrl: baseUrl.replace(/\/+$/, ''), token, fetch: fetchImpl };
    const shown = await call(ctx, 'GET', orgPath(orgId));
    if (isGone(shown)) return { ok: false, reason: `no organization '${orgId}' (already purged, or a wrong id)` };
    if (!isOrg(shown)) return { ok: false, reason: `could not read the organization (status ${shown.status})` };
    const org = shown.body.org;
    out(summaryText(org));
    if (!yes && !(await confirm(summaryText(org)))) return { ok: false, reason: 'not confirmed; nothing was changed' };

    const requestedAt = now().toISOString();
    if (org.status === 'active') {
        const suspended = await call(ctx, 'POST', `${orgPath(orgId)}/suspend`);
        if (suspended.status !== 200) return { ok: false, reason: `suspend failed (status ${suspended.status})` };
        out('suspended');
    }
    const queued = await call(ctx, 'POST', `${orgPath(orgId)}/delete`);
    if (queued.status !== 202) return { ok: false, reason: `delete was not queued (status ${queued.status})` };
    out(queued.body?.requested === false ? 'purge was already queued' : 'purge queued');

    const deadline = now().getTime() + timeoutMs;
    let lastLine = '';
    for (;;) {
        const read = await call(ctx, 'GET', orgPath(orgId));
        if (isGone(read)) break;
        // Anything but a definite "not found" is inconclusive: report it and ask again, never done.
        const purge = isOrg(read) ? read.body.org.purge : undefined;
        const line = !isOrg(read)
            ? `waiting: the read was inconclusive (status ${read.status})`
            : `waiting: step ${purge?.step ?? '(not queued yet)'}, attempts ${purge?.attempts ?? 0}` +
              (purge?.lastError ? `, last_error ${purge.lastError}` : '');
        if (line !== lastLine) out(line);
        lastLine = line;
        if (now().getTime() >= deadline) return { ok: false, reason: `purge not confirmed within the timeout; ${line}` };
        await sleep(pollMs);
    }
    const receipt = receiptText({
        orgId,
        orgName: org.name,
        requestedAt,
        confirmedAt: now().toISOString(),
    });
    out(receipt);
    return { ok: true, receipt };
}

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            yes: { type: 'boolean', default: false },
            'poll-seconds': { type: 'string', default: String(DEFAULT_POLL_SECONDS) },
            'timeout-minutes': { type: 'string', default: String(DEFAULT_TIMEOUT_MINUTES) },
        },
    });
    const { FACTORY_URL: baseUrl, FACTORY_TOKEN: token } = process.env;
    if (positionals.length !== 1 || !baseUrl || !token) {
        console.error('usage: FACTORY_URL=… FACTORY_TOKEN=… node scripts/org-erasure.mjs <org-id> [--yes]');
        process.exit(2);
    }
    const [orgId] = positionals;
    const confirm = async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const answer = await rl.question(`This deletes everything above and cannot be undone. Type ${orgId} to confirm: `);
            return answer.trim() === orgId;
        } finally {
            rl.close();
        }
    };
    const result = await eraseOrg({
        baseUrl,
        token,
        orgId,
        yes: values.yes,
        confirm,
        pollMs: Number(values['poll-seconds']) * MS_PER_SECOND,
        timeoutMs: Number(values['timeout-minutes']) * MS_PER_MINUTE,
    });
    if (!result.ok) {
        console.error(result.reason);
        process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
