/**
 * The AWS-compatible provider the external secret-store suites run against: a moto server
 * (`motoserver/moto`, pinned in docker-compose.yml and mirrored for CI) at `SECRETS_TEST_AWS_ENDPOINT`.
 * It exists only where that service does, so a laptop without it skips the suites; CI sets
 * `SECRETS_TEST_REQUIRE_AWS=1`, which turns an unreachable provider into a failure and never a silent skip
 * (the `ARTIFACTS_TEST_REQUIRE_S3` precedent in `server/test/artifacts-backends.ts`).
 */
const ENDPOINT = process.env.SECRETS_TEST_AWS_ENDPOINT?.trim() ?? '';
const PROBE_TIMEOUT_MS = 2000;

async function probe(): Promise<boolean> {
    if (!ENDPOINT) {
        return false;
    }
    try {
        await fetch(ENDPOINT, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
    } catch {
        return false;
    }
}

export const awsProviderReachable = await probe();
if (!awsProviderReachable && process.env.SECRETS_TEST_REQUIRE_AWS) {
    throw new Error(
        ENDPOINT
            ? 'SECRETS_TEST_REQUIRE_AWS is set but SECRETS_TEST_AWS_ENDPOINT is unreachable'
            : 'SECRETS_TEST_REQUIRE_AWS is set but SECRETS_TEST_AWS_ENDPOINT is not'
    );
}

export const AWS_TEST_ENDPOINT = ENDPOINT;
export const AWS_TEST_REGION = 'us-east-1';
/** Moto accepts any credentials; these are not real. */
export const AWS_TEST_KEYS = { accessKeyId: 'testing', secretAccessKey: 'testing' };
