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
        expect(script).toContain('config="$here/kind-cluster${LAYOUT:+-$LAYOUT}.yaml"');
        const drain = readFileSync(new URL('../../scripts/kind-cluster-drain.yaml', import.meta.url), 'utf8');
        expect(drain.match(/role: worker/g)).toHaveLength(3);
        expect(drain).toContain('factory.lane/shared: "true"');
        expect(drain).toContain('config_path = "/etc/containerd/certs.d"');
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
