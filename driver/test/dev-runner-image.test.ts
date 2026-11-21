import { describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';

// The image this repository's own `.bellows.yaml` gates run in: node, a docker CLI with compose and
// buildx for the lane, helm for the chart suites, and Playwright's chromium libraries. Every
// download is pinned by version and checked by a per-arch sha256, the way the executors pin gh and
// acli, so two builds of one commit install the same bytes.
const DOCKERFILE = 'docker/dev-runner/Dockerfile';

const arg = (text: string, name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(text)?.[1];

describe('the dev runner image', () => {
    it('starts from the executors’ node base, pinned by digest', () => {
        const from = (path: string) => /^FROM (\S+)/m.exec(read(path))?.[1];
        expect(from(DOCKERFILE)).toMatch(/^mirror\.gcr\.io\/library\/node:24-bookworm-slim@sha256:[0-9a-f]{64}$/);
        expect(from(DOCKERFILE)).toBe(from('docker/claude-executor/Dockerfile'));
    });

    it.each([
        ['DOCKER', 'docker CLI'],
        ['COMPOSE', 'compose plugin'],
        ['BUILDX', 'buildx plugin'],
        ['HELM', 'helm'],
    ])('pins the %s download (%s) by version and a sha256 per arch, and checks it', (name) => {
        const text = read(DOCKERFILE);
        expect(arg(text, `${name}_VERSION`)).toMatch(/^v?\d+\.\d+\.\d+$/);
        for (const arch of ['amd64', 'arm64']) expect(arg(text, `${name}_SHA256_${arch}`)).toMatch(/^[0-9a-f]{64}$/);
        const install = text.split(/^RUN /m).find((step) => step.includes(`$${name}_SHA256_amd64`));
        expect(install).toBeDefined();
        expect(install).toContain(`$${name}_SHA256_arm64`);
        expect(install).toContain('sha256sum -c -');
        expect(install).toContain(`\${${name}_VERSION}`);
    });

    it('puts compose and buildx where the docker CLI finds its plugins', () => {
        const text = read(DOCKERFILE);
        expect(text).toContain('/usr/local/lib/docker/cli-plugins/docker-compose');
        expect(text).toContain('/usr/local/lib/docker/cli-plugins/docker-buildx');
    });

    it('installs jq, git, make and a psql client the gates call', () => {
        const apt = read(DOCKERFILE)
            .split(/^RUN /m)
            .find((step) => step.includes('apt-get install'));
        for (const pkg of ['jq', 'git', 'make', 'postgresql-client', 'ca-certificates', 'curl'])
            expect(apt, pkg).toMatch(new RegExp(`\\s${pkg}(\\s|$)`));
    });

    // The ui gate (scripts/gate-ui.sh) finds the browser in place; it stays writable by uid 1000 so the
    // gate's `npx playwright install chromium` can lock it, or add a revision after a Playwright bump.
    it('installs chromium and its system libraries at the Playwright version the repo pins', () => {
        const text = read(DOCKERFILE);
        const pinned = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> })
            .devDependencies['@playwright/test'];
        expect(arg(text, 'PLAYWRIGHT_VERSION')).toBe(pinned);
        expect(text).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright$/m);
        const install = text.split(/^RUN /m).find((step) => step.includes(`playwright@\${PLAYWRIGHT_VERSION}`));
        expect(install).toContain('install --with-deps chromium');
        expect(install).toContain('chown -R 1000:1000 "$PLAYWRIGHT_BROWSERS_PATH"');
    });

    // The sidecar daemon's socket is group 1000; the gate reaches it as that uid's primary group.
    it('runs as uid 1000', () => {
        const users = [...read(DOCKERFILE).matchAll(/^USER (\S+)$/gm)].map((match) => match[1]);
        expect(users.at(-1)).toBe('1000:1000');
    });

    it('installs nothing as `latest`', () => {
        expect(read(DOCKERFILE)).not.toMatch(/latest/);
    });
});
