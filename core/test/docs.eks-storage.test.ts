import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The task volume's platform prerequisites, pinned to the documents that state them. The chart has
 * no shared workspaces claim: every task owns a `ReadWriteOnce`-class volume the driver creates, so
 * the only storage an operator provides is a StorageClass, named through `taskVolume.storageClass`.
 * On EKS that is an EBS class with `WaitForFirstConsumer`; a document that loses it leaves a claim
 * that never binds, with no UI to say so.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const kubernetes = read('../../docs/kubernetes.md');
const runbook = read('../../docs/eks-runbook.md');
const chartReadme = read('../../charts/factory/README.md');
const values = read('../../charts/factory/values.yaml');
const valuesLocal = read('../../charts/factory/values-local.yaml');

const templateFiles = (dir: string): string[] => readdirSync(here(dir)).map((name) => here(`${dir}/${name}`));

/**
 * Every pod spec this release writes that carries a pod-level `securityContext`: the three chart
 * Deployments, plus the driver module that specs every pod mounting a task volume. An `fsGroup` can
 * only land in one of these, so these are what the document's claim is checked against.
 */
const podSpecSources = [
    '../../charts/factory/templates/deployment.yaml',
    '../../charts/factory/templates/driver-deployment.yaml',
    '../../charts/factory/templates/collector.yaml',
    '../../driver/src/k8s/k8s-podspec.ts',
];

describe('the task volume storage prerequisites', () => {
    it('renders no shared workspaces claim', () => {
        expect(existsSync(here('../../charts/factory/templates/pvc.yaml'))).toBe(false);
        for (const file of [
            ...templateFiles('../../charts/factory/templates'),
            ...templateFiles('../../charts/factory-local-state/templates'),
        ]) {
            const text = readFileSync(file, 'utf8');
            expect(text, file).not.toContain('Values.workspaces');
            expect(text, file).not.toContain('workspaceClaim');
        }
        expect(values).not.toMatch(/^workspaces:/m);
        expect(valuesLocal).not.toMatch(/^workspaces:/m);
    });

    it('names the EBS class requirements in docs/kubernetes.md', () => {
        expect(kubernetes).toContain('ebs.csi.aws.com');
        expect(kubernetes).toContain('WaitForFirstConsumer');
        expect(kubernetes).toContain('taskVolume.storageClass');
        expect(kubernetes).not.toContain('efs-ap');
    });

    it('points an operator at taskVolume.storageClass from the runbook and the chart README', () => {
        expect(runbook).toContain('taskVolume.storageClass');
        expect(chartReadme).toContain('taskVolume.storageClass');
        expect(runbook).not.toContain('efs-ap');
        expect(chartReadme).not.toContain('efs-ap');
    });

    /**
     * The one claim in the prose that a code change can falsify. Everything else the document says
     * about this repository is structural; this is a fact about four files, so it is asserted
     * against those four files rather than against the sentence that reports them: only the
     * driver's pod specs set `fsGroup` (the task volume's), the chart's own pods never do.
     */
    it('is telling the truth that only the driver pod specs set fsGroup', () => {
        for (const source of podSpecSources) {
            if (source.endsWith('driver/src/k8s/k8s-podspec.ts')) {
                expect(read(source), source).toContain('fsGroup');
            } else {
                expect(read(source), source).not.toContain('fsGroup');
            }
        }
    });
});
