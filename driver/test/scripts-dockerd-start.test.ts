import { describe, expect, it } from 'vitest';
import { dockerdStartArgv, dockerdStartScript } from '../src/container-scripts.js';
import { DOCKER_DATA_ROOT, DOCKER_SOCKET, DOCKER_SOCK_GID, DOCKER_TMP_DIR } from '../src/k8s/k8s-dockerd.js';

/*
 * The `dockerd` sidecar's start script (`scripts/dockerd-start.sh`), pinned by its bytes ONLY: it
 * makes device nodes and starts a daemon, which no test process may do. What it does in a microVM
 * is the GKE run's to show.
 */

/** The script without its comment lines: what the shell runs. */
const code = dockerdStartScript
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The one `exec dockerd …` line, continuations joined. */
const dockerdLine = code.replace(/\\\n\s*/g, ' ').match(/^\s*exec dockerd-entrypoint\.sh dockerd .*$/m)?.[0] ?? '';

describe('the dockerd start script', () => {
    it('is the container command, by content', () => {
        expect(dockerdStartArgv()).toEqual(['sh', '-c', dockerdStartScript, 'dockerd-start']);
    });

    it('is POSIX sh: no bash-only syntax, no shebang to a bash', () => {
        expect(dockerdStartScript).not.toMatch(/^#!.*bash/m);
        expect(code).not.toMatch(/\[\[|\bfunction\b|\$\(<|<<<|\bdeclare\b|\blocal\b|\bpipefail\b/);
        expect(code).toMatch(/^set -eu$/m);
    });

    // The image's own entrypoint, first argument `dockerd`: it adds no --host and no TLS (those
    // defaults apply only to no argument or a leading flag), deletes a stale pid file and wraps the
    // daemon in docker-init and the `dind` script, which delegates cgroup v2 to nested kind nodes.
    it("starts the daemon through the image's dind entrypoint", () => {
        expect(code).toMatch(/^exec dockerd-entrypoint\.sh dockerd /m);
        expect(code.match(/^\s*exec /gm)).toHaveLength(1);
        expect(dockerdLine).not.toBe('');
    });

    // Inside a microVM the daemon owns the guest's network stack: its own iptables NAT the bridge,
    // and the guest kernel's key quota and forwarding are the daemon's to set.
    it("keeps docker's own iptables: no --iptables=false, maxkeys, ip_forward or SNAT", () => {
        expect(code).not.toMatch(/--iptables=false|--ip6tables=false/);
        expect(code).not.toContain('maxkeys');
        expect(code).not.toContain('ip_forward');
        expect(code).not.toContain('SNAT');
        expect(code).not.toContain('POSTROUTING');
    });

    // kind's node containers read /dev/kmsg (the kubelet's OOM watcher), which the guest's /dev
    // may not hold; created only when absent, before the daemon starts.
    it('creates /dev/kmsg before the daemon when absent', () => {
        expect(code).toMatch(/^\[ -e \/dev\/kmsg \] \|\| mknod \/dev\/kmsg c 1 11$/m);
        expect(code.indexOf('mknod /dev/kmsg')).toBeLessThan(code.indexOf('exec dockerd-entrypoint.sh'));
    });

    it('reads the eth0 MTU', () => {
        expect(code).toContain('/sys/class/net/eth0/mtu');
    });

    it('makes the shared temp dir world-writable and sticky', () => {
        expect(code).toContain(`chmod 1777 ${DOCKER_TMP_DIR}`);
    });

    it('starts dockerd at the pod MTU, on two unix sockets for group 1000 and no TCP', () => {
        expect(dockerdLine).toContain('--mtu "$mtu"');
        expect(dockerdLine).toContain(`--data-root ${DOCKER_DATA_ROOT}`);
        expect(dockerdLine).toContain(`-H unix://${DOCKER_SOCKET}`);
        expect(dockerdLine).toContain('-H unix:///var/run/docker.sock');
        expect(dockerdLine).toContain(`--group ${DOCKER_SOCK_GID}`);
        expect(DOCKER_SOCK_GID).toBe(1000);
        expect(dockerdLine).toMatch(/--shutdown-timeout \d+/);
        expect(dockerdStartScript).not.toContain('tcp://');
        expect(dockerdStartScript).not.toMatch(/:2375|:2376/);
    });

    // The mirror list (DOCKERD_MIRRORS: space-separated https:// URLs the driver validated) is a
    // parameter of the script, never spliced into it: each entry becomes its own argv pair, unglobbed,
    // and an unset or empty list adds nothing — the daemon pulls directly.
    it('turns DOCKERD_MIRRORS into one --registry-mirror per entry, and none when unset', () => {
        expect(code).toMatch(/^set -f$/m);
        expect(code).toMatch(
            /^set --\nfor mirror in \$\{DOCKERD_MIRRORS:-\}; do\n\s+set -- "\$@" --registry-mirror "\$mirror"\ndone$/m
        );
        expect(code.indexOf('set -f')).toBeLessThan(code.indexOf('for mirror in'));
        expect(code.indexOf('done')).toBeLessThan(code.indexOf('exec dockerd'));
        expect(dockerdLine).toMatch(/ "\$@"$/);
    });

    it('ships with no trailing whitespace and a final newline', () => {
        expect(dockerdStartScript).not.toMatch(/[ \t]+$/m);
        expect(dockerdStartScript.endsWith('\n')).toBe(true);
    });
});
