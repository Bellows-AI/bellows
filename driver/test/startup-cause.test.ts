import { describe, expect, it } from 'vitest';
import { startupCauseOf, StartupRefused, transientStartup } from '../src/startup-cause.js';

describe('the cause a refused group start proves (#824 D11)', () => {
    it('takes the kubelet’s typed reasons at their word, whatever the message', () => {
        expect(startupCauseOf({ waitingReason: 'InvalidImageName', message: '' })).toBe('image');
        expect(startupCauseOf({ waitingReason: 'CreateContainerConfigError', message: 'secret "x" not found' })).toBe(
            'config'
        );
    });

    // The kubelet files a timeout it hit while generating the config under the same reason (Codex r2, class A).
    it('lets an explicit timeout outrank a typed configuration reason', () => {
        expect(
            startupCauseOf({
                waitingReason: 'CreateContainerConfigError',
                message: 'failed to sync secret cache: timed out waiting for the condition',
            })
        ).toBe('transient');
        // A restarted kubelet whose service cache has not synced yet (Codex r3, class A).
        expect(
            startupCauseOf({
                waitingReason: 'CreateContainerConfigError',
                message: 'services have not yet been read at least once, cannot construct envvars',
            })
        ).toBe('transient');
    });

    it('reads a trust failure as permanent, and only a handshake that timed out as transient', () => {
        expect(
            startupCauseOf({
                message: 'tls: failed to verify certificate: x509: certificate signed by unknown authority',
            })
        ).toBe('config');
        expect(startupCauseOf({ message: 'x509: certificate is valid for a.example, not registry.example' })).toBe(
            'config'
        );
        expect(startupCauseOf({ message: 'net/http: TLS handshake timeout' })).toBe('transient');
    });

    // Words that prove neither class are no cause: the path keeps the recovery it had.
    it.each([
        ['nothing at all', ''],
        ['a back-off that names no cause', 'Back-off pulling image "registry.example/claude-executor:latest"'],
        ['a local permission refusal', "EACCES: permission denied, open '/tmp/env'"],
        ['a missing network, not an image', 'Error response from daemon: network factory-svc-1 not found'],
        ['a name conflict', 'Error response from daemon: Conflict. The container name "/x" is already in use'],
        // A NotFound that names no missing image or manifest: a local content digest, a registry with no /v2/.
        [
            'a missing local content digest',
            'rpc error: code = NotFound desc = failed to pull and unpack image "registry.example/agent:latest": failed to copy: content digest sha256:0123abcd not found',
        ],
        [
            'a registry endpoint that answers 404',
            'failed to resolve reference "registry.example/agent:latest": unexpected status from GET request to https://registry.example/v2/: 404 Not Found',
        ],
    ])('reads no cause from %s', (_, message) => {
        expect(startupCauseOf({ message })).toBeNull();
        expect(startupCauseOf({ waitingReason: 'ErrImagePull', message })).toBeNull();
    });

    // Only the platform's own error wording is evidence, never the image reference it quotes: an
    // image, a repository or a host may be named after any keyword (#824 D11, Codex r1 class A).
    const timeoutFor = (ref: string) =>
        `failed to pull and unpack image "${ref}": failed to do request: Head "https://${ref.split(':')[0]}/manifests/latest": dial tcp 10.0.0.1:443: i/o timeout`;
    it.each([
        ['an image named for an auth refusal', timeoutFor('registry.example/unauthorized-agent:latest'), 'transient'],
        ['an image named for a missing manifest', timeoutFor('registry.example/manifest-unknown:1'), 'transient'],
        [
            'an image named for a missing repository',
            timeoutFor('registry.example/repository-does-not-exist:1'),
            'transient',
        ],
        [
            'an image named for a trust failure',
            timeoutFor('registry.example/x509-certificate-signed-by-unknown-authority:1'),
            'transient',
        ],
        [
            'an image named for a timeout, refused a credential',
            'failed to pull and unpack image "registry.example/timed-out-agent:latest": failed to authorize: failed to fetch anonymous token: unexpected status: 401 Unauthorized',
            'auth',
        ],
        [
            'a docker image named for an auth refusal, its registry timing out',
            'Unable to find image \'unauthorized-agent:latest\' locally\nError response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
            'transient',
        ],
        [
            'a registry host named for an auth refusal, its lookup timing out',
            'dial tcp: lookup unauthorized-registry.example on 10.0.0.2:53: i/o timeout',
            'transient',
        ],
        [
            'a docker image named for a missing manifest, refused a credential',
            'Error response from daemon: Head "https://registry.example/v2/manifest-unknown/manifests/latest": unauthorized: authentication required',
            'auth',
        ],
    ])('reads the error, not the reference, for %s', (_, message, cause) => {
        expect(startupCauseOf({ message })).toBe(cause);
    });

    it('carries its cause on the refusal, and only transient is a retry', () => {
        const refused = new StartupRefused('manifest unknown', 'image');
        expect(refused).toBeInstanceOf(Error);
        expect(refused).toMatchObject({ name: 'StartupRefused', message: 'manifest unknown', startupCause: 'image' });
        expect(['transient', 'image', 'auth', 'config'].map((c) => transientStartup(c as never))).toEqual([
            true,
            false,
            false,
            false,
        ]);
    });
});
