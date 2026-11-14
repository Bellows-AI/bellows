import { describe, expect, it } from 'vitest';
import { dockerdStartArgv, dockerdStartScript } from '../src/container-scripts.js';
import { DOCKER_DATA_ROOT, DOCKER_SOCKET, DOCKER_SOCK_GID, DOCKER_TMP_DIR } from '../src/k8s/k8s-dockerd.js';

/*
 * The `dockerd` sidecar's start script (`scripts/dockerd-start.sh`), pinned by its bytes ONLY: it
 * writes kernel settings and the pod's NAT table, which no test process may touch. What it does in
 * a sandbox is the GKE run's to show.
 */

/** The script without its comment lines: what the shell runs. */
const code = dockerdStartScript
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The one `exec dockerd …` line, continuations joined. */
const dockerdLine = code.replace(/\\\n\s*/g, ' ').match(/^\s*exec dockerd .*$/m)?.[0] ?? '';

describe('the dockerd start script', () => {
    it('is the container command, by content', () => {
        expect(dockerdStartArgv()).toEqual(['sh', '-c', dockerdStartScript, 'dockerd-start']);
    });

    it('is POSIX sh: no bash-only syntax, no shebang to a bash', () => {
        expect(dockerdStartScript).not.toMatch(/^#!.*bash/m);
        expect(code).not.toMatch(/\[\[|\bfunction\b|\$\(<|<<<|\bdeclare\b|\blocal\b|\bpipefail\b/);
        expect(code).toMatch(/^set -eu$/m);
    });

    it('raises the key quota, then turns forwarding on, before it starts the daemon', () => {
        const maxkeys = code.indexOf('/proc/sys/kernel/keys/maxkeys');
        const forward = code.indexOf('/proc/sys/net/ipv4/ip_forward');
        const exec = code.indexOf('exec dockerd');
        expect(maxkeys).toBeGreaterThan(-1);
        expect(forward).toBeGreaterThan(-1);
        expect(maxkeys).toBeLessThan(exec);
        expect(forward).toBeLessThan(exec);
    });

    it('SNATs the bridge traffic out of eth0 to the pod address, and reads the eth0 MTU', () => {
        expect(code).toMatch(/-t nat -A POSTROUTING -o eth0 .*-j SNAT --to-source "\$addr"/);
        expect(code).toContain('/sys/class/net/eth0/mtu');
    });

    it('makes the shared temp dir world-writable and sticky', () => {
        expect(code).toContain(`chmod 1777 ${DOCKER_TMP_DIR}`);
    });

    it('starts dockerd without its own iptables, at the pod MTU, on two unix sockets for group 1000 and no TCP', () => {
        expect(dockerdLine).toContain('--iptables=false --ip6tables=false --mtu "$mtu"');
        expect(dockerdLine).toContain(`--data-root ${DOCKER_DATA_ROOT}`);
        expect(dockerdLine).toContain(`-H unix://${DOCKER_SOCKET}`);
        expect(dockerdLine).toContain('-H unix:///var/run/docker.sock');
        expect(dockerdLine).toContain(`--group ${DOCKER_SOCK_GID}`);
        expect(DOCKER_SOCK_GID).toBe(1000);
        expect(dockerdLine).toMatch(/--shutdown-timeout \d+/);
        expect(dockerdStartScript).not.toContain('tcp://');
        expect(dockerdStartScript).not.toMatch(/:2375|:2376/);
    });

    it('ships with no trailing whitespace and a final newline', () => {
        expect(dockerdStartScript).not.toMatch(/[ \t]+$/m);
        expect(dockerdStartScript.endsWith('\n')).toBe(true);
    });
});
