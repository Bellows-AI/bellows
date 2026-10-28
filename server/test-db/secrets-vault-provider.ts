/**
 * The Vault the external secret-store suites run against: a dev-mode server (`hashicorp/vault`, pinned in
 * docker-compose.yml and mirrored for CI) with its default KV v2 mount at `secret`, reached at
 * `SECRETS_TEST_VAULT_ADDR` with the root token `SECRETS_TEST_VAULT_TOKEN`. It exists only where that service
 * does, so a laptop without it skips the suites; CI sets `SECRETS_TEST_REQUIRE_VAULT=1`, which turns an
 * unreachable provider into a failure and never a silent skip (the `SECRETS_TEST_REQUIRE_AWS` precedent).
 */
const ADDR = process.env.SECRETS_TEST_VAULT_ADDR?.trim().replace(/\/$/, '') ?? '';
const TOKEN = process.env.SECRETS_TEST_VAULT_TOKEN?.trim() ?? '';
const PROBE_TIMEOUT_MS = 2000;

async function probe(): Promise<boolean> {
    if (!ADDR || !TOKEN) {
        return false;
    }
    try {
        const response = await fetch(`${ADDR}/v1/sys/mounts`, {
            headers: { 'X-Vault-Token': TOKEN },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export const vaultProviderReachable = await probe();
if (!vaultProviderReachable && process.env.SECRETS_TEST_REQUIRE_VAULT) {
    throw new Error(
        ADDR && TOKEN
            ? 'SECRETS_TEST_REQUIRE_VAULT is set but SECRETS_TEST_VAULT_ADDR is unreachable or refuses SECRETS_TEST_VAULT_TOKEN'
            : 'SECRETS_TEST_REQUIRE_VAULT is set but SECRETS_TEST_VAULT_ADDR or SECRETS_TEST_VAULT_TOKEN is not'
    );
}

export const VAULT_TEST_ADDR = ADDR;
export const VAULT_TEST_TOKEN = TOKEN;
export const VAULT_TEST_MOUNT = 'secret';

/** One Vault API call with the root token, answered as parsed JSON (or null for no body) and its status. */
export async function vaultApi<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    token = VAULT_TEST_TOKEN
): Promise<{ status: number; json: T }> {
    const response = await fetch(`${ADDR}/v1/${path}`, {
        method,
        headers: { 'X-Vault-Token': token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 3),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
}

/**
 * A client token limited by `policy` (HCL), for a test of a token Vault refuses on some paths. Each call makes
 * a fresh policy and token, so suites never share one.
 */
export async function limitedToken(policy: string): Promise<string> {
    const name = `fixbel-${crypto.randomUUID()}`;
    const written = await vaultApi('PUT', `sys/policies/acl/${name}`, { policy });
    if (written.status >= 300) {
        throw new Error('could not write the test policy');
    }
    const created = await vaultApi<{ auth: { client_token: string } }>('POST', 'auth/token/create', {
        policies: [name],
        ttl: '1h',
        no_default_policy: true,
    });
    return created.json.auth.client_token;
}

/** Every secret path under `prefix` in the KV v2 mount (a recursive LIST of the metadata tree), sorted. */
export async function listPaths(prefix: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (path: string): Promise<void> => {
        const { status, json } = await vaultApi<{ data: { keys?: string[] } }>(
            'LIST',
            `${VAULT_TEST_MOUNT}/metadata/${path}`
        );
        if (status === 404) {
            return;
        }
        for (const key of json.data.keys ?? []) {
            if (key.endsWith('/')) {
                await walk(`${path}/${key.slice(0, -1)}`);
            } else {
                found.push(`${path}/${key}`);
            }
        }
    };
    await walk(prefix);
    return found.sort();
}
