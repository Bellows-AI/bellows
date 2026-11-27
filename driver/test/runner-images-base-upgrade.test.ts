import { describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';

// The Debian-based runner images pin their node base by digest, so a base-package security fix
// published after the pin reaches them only through an upgrade in their own apt layer. Without it the
// release scan (`--ignore-unfixed`, HIGH and CRITICAL) fails on a fix that exists but is not
// installed — as a linux-pam fix once did for every executor.
const IMAGES = [
    'docker/claude-executor/Dockerfile',
    'docker/opencode-executor/Dockerfile',
    'docker/dev-runner/Dockerfile',
];

describe('the Debian-based runner images', () => {
    for (const path of IMAGES) {
        it(`${path} upgrades the base packages in its apt layer`, () => {
            const apt = read(path)
                .split(/^RUN /m)
                .find((step) => step.includes('apt-get install -y --no-install-recommends ca-certificates'));
            expect(apt, 'the apt layer').toBeDefined();
            expect(apt).toMatch(/apt-get update\s*\\\s*\n\s*&& apt-get upgrade -y --no-install-recommends\s*\\/);
        });
    }
});
