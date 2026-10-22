import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The kind lane pulls its images from a local registry the node mirrors, and a node reads the
 * mirror only when its cluster was created with containerd's registry `config_path`. So the
 * cluster and its registry are made, and unmade, in one place — scripts/kind-cluster.sh — and the
 * Makefile only calls it. A second `kind create cluster` anywhere makes a cluster the lane refuses.
 */

const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');

/** A recipe: the target line through the last line that is still indented. */
const recipe = (target: string): string => {
    const lines = makefile.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`${target}:`));
    expect(start).toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line !== '' && !line.startsWith('\t')) break;
        body.push(line);
    }
    return body.join('\n');
};

describe('the kind cluster targets', () => {
    it('make cluster creates through the shared script', () => {
        expect(recipe('cluster')).toContain('sh scripts/kind-cluster.sh create $(CLUSTER)');
    });

    // Issue #829: the multi-node drain layout is the same script with another cluster config.
    it('make cluster passes LAYOUT to the script, which reads scripts/kind-cluster-<layout>.yaml', () => {
        expect(recipe('cluster')).toContain('LAYOUT=$(LAYOUT)');
        const script = readFileSync(new URL('../../scripts/kind-cluster.sh', import.meta.url), 'utf8');
        expect(script).toMatch(/config="\$here\/kind-cluster\$\{LAYOUT:\+-\$LAYOUT}\.yaml"/);
        const drain = readFileSync(new URL('../../scripts/kind-cluster-drain.yaml', import.meta.url), 'utf8');
        expect(drain.match(/role: worker/g)).toHaveLength(3);
        // The control plane runs the board that writes the workspaces: it shares the mount with the workers.
        expect(drain.match(/factory\.lane\/shared: "true"/g)).toHaveLength(4);
        expect(drain.match(/containerPath: \/factory-shared/g)).toHaveLength(4);
        expect(drain.match(/hostPath: @SHARED@/g)).toHaveLength(4);
        expect(drain).toContain('config_path = "/etc/containerd/certs.d"');
        // The lane's rebind grace is derived from the kubelet sync (scripts/test-k8s.sh): both layouts sync fast.
        for (const layout of [
            drain,
            readFileSync(new URL('../../scripts/kind-cluster.yaml', import.meta.url), 'utf8'),
        ]) {
            expect(layout).toContain('kind: KubeletConfiguration\n      syncFrequency: 5s');
        }
    });

    it('an unknown LAYOUT is refused, and the shared directory is per cluster and removed with it', () => {
        const script = readFileSync(new URL('../../scripts/kind-cluster.sh', import.meta.url), 'utf8');
        expect(script).toContain("unknown LAYOUT '$LAYOUT'");
        expect(script).toContain('FACTORY_KIND_SHARED:-$HOME/.cache/factory-kind/$name');
        expect(script).toContain('rm -rf "$HOME/.cache/factory-kind/$name"');
        expect(script).not.toContain('/tmp/factory-kind-shared');
    });

    it('start goes through make cluster, and nothing else creates a cluster', () => {
        expect(recipe('start')).toContain('$(MAKE) cluster');
        expect(makefile).not.toContain('kind create cluster');
    });

    it('cleanup removes the registry with the cluster', () => {
        expect(recipe('cleanup')).toContain('sh scripts/kind-cluster.sh delete $(CLUSTER)');
        expect(makefile).not.toContain('kind delete cluster');
    });
});
