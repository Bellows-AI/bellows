import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/*
 * Issue #363: the EKS prerequisites live in four places — the docs section that carries them,
 * the sentence that closes the standalone-pod caveat, and the pointers from the chart
 * surfaces an operator actually reads first (the NetworkPolicy template comment, the values
 * comments, the chart README). Each pin below is a fact the issue demands be stated; a docs edit
 * that drops one fails here instead of at an operator's cluster.
 */
const kubernetesDocs = readFileSync(join(ROOT, 'docs/kubernetes.md'), 'utf8');
const netpolTemplate = readFileSync(join(ROOT, 'charts/factory/templates/runner-networkpolicy.yaml'), 'utf8');
const chartValues = readFileSync(join(ROOT, 'charts/factory/values.yaml'), 'utf8');
const agentsDoc = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const chartReadme = readFileSync(join(ROOT, 'charts/factory/README.md'), 'utf8');

describe('the EKS prerequisites record', () => {
    it('states the node and add-on prerequisites in docs/kubernetes.md', () => {
        expect(kubernetesDocs).toContain('EKS prerequisites');
        // The node-level IMDS defence the blockedCidrs rule cannot make on its own.
        expect(kubernetesDocs).toContain('httpPutResponseHopLimit');
        // The VPC CNI add-on flag without which the NetworkPolicy object is inert.
        expect(kubernetesDocs).toContain('enableNetworkPolicy');
        // The metrics API provider absent from EKS by default; vitals degrade to null without it.
        expect(kubernetesDocs).toContain('metrics-server');
        // Fargate is out entirely: no network policy, no metrics API, no node.
        expect(kubernetesDocs).toContain('Fargate');
    });

    it('states the VPC-endpoint answer for the blocked private ranges', () => {
        expect(kubernetesDocs).toContain('VPC endpoint');
        expect(kubernetesDocs).toContain('allowedCidrs');
    });

    // Issue #773: services and gates are sidecars of the runner Job's pod, so no pod is standalone.
    it("records that every runner pod is a Job's, closing the standalone-pod caveat", () => {
        expect(prose(kubernetesDocs)).toContain("Every runner pod is a Job's");
        expect(prose(kubernetesDocs)).toContain('the driver creates no bare pod');
        expect(kubernetesDocs).toContain('standalone');
    });

    it('points the NetworkPolicy surfaces at the EKS enforcement prerequisite', () => {
        // The template header comment, the values comment and the chart README row all name the
        // add-on flag and the doc that carries the rest.
        for (const surface of [netpolTemplate, chartValues, chartReadme]) {
            expect(surface).toContain('enableNetworkPolicy');
            expect(surface).toContain('docs/kubernetes.md');
        }
    });
});

/*
 * Issue #382. The isolation record is split across four documents on purpose — an operator reads
 * kubernetes.md, a reviewer reads security.md, somebody chasing a leaked file reads workspace.md,
 * and somebody deciding whether a green run means anything reads executor-testing.md. Each claim
 * below is one the issue demands be STATED, and each is the kind a later edit drops without
 * noticing, because dropping it makes the document read better rather than worse: the honest
 * limits are the ugly sentences.
 */
const securityDocs = readFileSync(join(ROOT, 'docs/security.md'), 'utf8');
const workspaceDocs = readFileSync(join(ROOT, 'docs/workspace.md'), 'utf8');
const testingDocs = readFileSync(join(ROOT, 'docs/executor-testing.md'), 'utf8');
const jobsDocs = readFileSync(join(ROOT, 'docs/jobs.md'), 'utf8');

/**
 * Prose wraps at 100 columns, so a sentence worth pinning is usually split across a line break and
 * a literal needle that reads fine here fails for a reason that has nothing to do with the claim.
 * Collapsing runs of whitespace means these pins survive a reflow and fail only when the SENTENCE
 * goes — which is the thing they are meant to protect.
 */
const prose = (doc: string): string => doc.replace(/\s+/g, ' ');

describe('the executor isolation record (#382)', () => {
    // The claim the issue forbids, in the one document most likely to drift into making it.
    it('refuses to claim kernel or VM isolation from ordinary pod hardening', () => {
        expect(securityDocs).toContain('not kernel isolation and it is not VM isolation');
        expect(securityDocs).toContain('shares one host kernel');
        // And it says what WOULD give one, so the limit is actionable rather than just a warning.
        expect(securityDocs).toMatch(/gVisor|Kata|Firecracker/);
    });

    it('states the controls and that they are required, not merely set', () => {
        for (const needle of ['capabilities.drop', 'allowPrivilegeEscalation', 'RuntimeDefault', '--cap-drop']) {
            expect(securityDocs, needle).toContain(needle);
        }
        expect(securityDocs).toContain('required by admission');
    });

    // Issue #773: a declared service is a sidecar beside the agent, so the capability row has no
    // exception left — the table states it for every container, and the opt-out is gone.
    it('states the capability row for every container, with no exception', () => {
        const table = prose(securityDocs);
        expect(table).toContain('| No capabilities | `capabilities.drop: [ALL]` on every container');
        expect(table).toContain('`--cap-drop ALL` on every container |');
        expect(table).not.toContain('unless `unhardened: true`');
    });

    it('states that no service or gate image opts out, and what a stock image declares instead', () => {
        // The limit an author hits as a crash-looping service or a failing gate rather than as a
        // security message.
        expect(prose(securityDocs)).toContain('no opt-out for a declared service or a GATE image');
        expect(securityDocs).toContain('user: "uid:gid"');
    });

    // The workspace claim the issue is most explicit about: do NOT advertise task isolation.
    it('states that same-member tasks SHARE the workspace subtree', () => {
        expect(workspaceDocs).toContain('not a task boundary');
        expect(workspaceDocs).toContain('same member shares that subtree');
        // And that the narrower mount is a design, not a parameter — the issue's own instruction.
        expect(workspaceDocs).toContain('deliberately does not touch mount code');
    });

    it('states the deployment assumptions, each of which is silent when absent', () => {
        expect(kubernetesDocs).toContain('A CNI that enforces NetworkPolicy');
        // 1.33: the first release with the `pods/resize` subresource the gate sidecar is resized
        // through, beside native sidecars and ValidatingAdmissionPolicy (issue #773, checked on kind
        // v1.33.4).
        expect(kubernetesDocs).toContain(
            'ValidatingAdmissionPolicy, native sidecars and `pods/resize`, Kubernetes ≥ 1.33'
        );
        expect(kubernetesDocs).toContain('httpPutResponseHopLimit');
        // The IP family: documented as a limit, since only IPv4 rules exist. The IPv4 rules still
        // cover IPv4 on a dual-stack cluster; what is missing there is the IPv6 half.
        expect(kubernetesDocs).toContain('IPv6 egress is not covered');
    });

    it('names each residual rather than leaving it to be discovered', () => {
        // The portless driver egress — the hole the port scoping did not close.
        expect(kubernetesDocs).toContain('reach the driver pod on any port');
        // Issue #773: no runner ingress, and service names on the pod's loopback, never DNS.
        expect(prose(kubernetesDocs)).toContain('one attempt cannot reach another');
        expect(prose(kubernetesDocs)).toContain(
            'resolves to `127.0.0.1` through `hostAliases`, never through DNS (#296)'
        );
        // The blockedCidrs hole: a public apiserver or node address is not covered.
        expect(kubernetesDocs).toContain('PUBLIC is not covered');
        // The control a NetworkPolicy cannot be, stated where someone might assume otherwise.
        expect(kubernetesDocs).toContain('says nothing about HTTP routes');
    });

    // The AUTHOR-facing half. security.md and kubernetes.md are read by operators; the person who
    // writes `services:` reads jobs.md, and the hardening breaks their stock postgres. Documenting
    // the fix only where operators look would leave that to be diagnosed from a crash loop.
    it('tells a .bellows.yaml author about the hardening and its one fix', () => {
        // The symptom they will actually see, named.
        expect(prose(jobsDocs)).toContain('chowns its data directory as root');
        expect(jobsDocs).toContain('user: "uid:gid"');
        // Issue #773: the opt-out is gone, and the board says so at parse.
        expect(prose(jobsDocs)).toContain('the board refuses `unhardened`');
    });

    // Issue #773: what a service sidecar needs of its image, and docker's weaker service network.
    it('states the service image needs and the docker service reachability as limits', () => {
        expect(prose(kubernetesDocs)).toContain(
            'Stated limit: a declared service image needs `sh`, `cat` and a writable `/tmp`'
        );
        expect(prose(kubernetesDocs)).toContain(
            'on docker (development only) service listeners are reachable by IP on the compose network'
        );
    });

    // Issue #792: a runner that outlived its driver is adopted only once it finished; the running
    // case is redone, and the bound on a finished one is the Job's TTL.
    it('states that only a finished runner is adopted, and for how long', () => {
        expect(kubernetesDocs).toContain('Stated limit: a runner still RUNNING when its driver is lost');
        expect(prose(kubernetesDocs)).toContain(
            'the job redone in its session and tree, an interruption inside the budget'
        );
        expect(kubernetesDocs).toContain(
            'Stated limit: why a driver ended a run is recorded on the attempt only where'
        );
        expect(kubernetesDocs).toContain(
            'deletes the Job, its record, its Secrets and its claim before `end` reaches the board'
        );
        expect(kubernetesDocs).toContain('`ttlSecondsAfterFinished`');
    });

    // Issue #824 (D13): a runner whose agent exited is waited out and adopted, never swept; the claim
    // fences the checkout, not the steps a lost driver still alive sends, which the group's bound ends.
    it('states that a finalizing runner is waited out, and what the takeover does not fence', () => {
        expect(prose(kubernetesDocs)).toContain(
            'one whose agent exited is waited out (`SUPERVISOR_WINDDOWN_MS`) and adopted with its logged report'
        );
        expect(prose(kubernetesDocs)).toContain(
            "a lost driver still alive steps into it until its lease or the group's orphan bound ends"
        );
    });

    // Issue #829: a rebind is a Secret patch the kubelet delivers on its own sync, not a push.
    it('states how late a rebind reaches a live supervisor', () => {
        expect(prose(kubernetesDocs)).toContain(
            "Stated limit: a rebind reaches a live supervisor only once the kubelet refreshes the attempt Secret's volume — up to its sync period (default one minute) plus its cache delay; docker's write is seen on the supervisor's next control poll."
        );
    });

    // Issue #821 (D1): a board that takes neither the staged conclusion nor the verdict for a whole
    // lease leaves the group to adoption, which keeps the agent's outcome but not the rest.
    it('states what an outage past the lease costs a finished attempt', () => {
        expect(kubernetesDocs).toContain('Stated limit: a verdict neither staged nor completed within one lease');
        expect(prose(kubernetesDocs)).toContain(
            'its agent outcome is adopted, but the gates and the post-processing run again'
        );
        expect(prose(kubernetesDocs)).toContain('can retire `dead` before it is adopted');
    });

    // Issue #533: the question relay lands on both executors, but only docker has the real-agent
    // round trip; the kubernetes half is a stated limit, never a silent skip.
    it('states that the kubernetes question round trip is not run on a cluster, and what pins the relay', () => {
        expect(kubernetesDocs).toContain('Stated limit: the kubernetes question round trip');
        expect(kubernetesDocs).toContain('is not run on a kind cluster');
        expect(kubernetesDocs).toContain('The relay is pinned offline');
        expect(kubernetesDocs).toContain('activeDeadlineSeconds');
    });

    it('records which test lane proves what, and that a non-enforcing CNI passes vacuously', () => {
        expect(testingDocs).toContain('vacuously');
        expect(testingDocs).toContain('--netpol');
        // The control that makes the lane evidence: EVERY denial target is proved reachable
        // before the policy lands, so an address nothing listens on cannot report a pass.
        expect(prose(testingDocs)).toContain('honest-probe control on every denial target');
        // And the one target that has no honest probe, named rather than quietly asserted.
        expect(prose(testingDocs)).toContain('169.254.169.254) is not probed');
        // The gaps no lane covers, listed rather than implied by their absence.
        expect(testingDocs).toContain('What no lane covers');
    });

    // Issue #796: node disruption is proven on real infrastructure in both lanes, not only offline.
    it('records the node-disruption acceptance both end-to-end lanes run', () => {
        expect(prose(testingDocs)).toContain('kills (`kill -9`) and drains (`DRIVER_HANDOVER_MS`) a driver mid-run');
        expect(prose(testingDocs)).toContain('a runner pod deleted mid-run each end succeeded with one attempt');
        expect(prose(testingDocs)).toContain('never reaped unread');
        // Issue #822: a driver lost together with its runner, and an expiry at the last attempt.
        expect(prose(testingDocs)).toContain(
            'a driver lost together with its runner is redone by a replacement runner'
        );
        expect(prose(testingDocs)).toContain(
            'a driver pod and its runner Job deleted together end succeeded in the lost session'
        );
    });

    // Issue #869: a read nobody confirmed is inconclusive on both executors; the lint plugin and the
    // read-fault suites are the enforcement, so the sentences naming them are pinned.
    it('states that an unconfirmed read is inconclusive and names its enforcement', () => {
        expect(prose(agentsDoc)).toContain('An unconfirmed read never licenses a delete or a negative verdict.');
        expect(prose(agentsDoc)).toContain('`lint/no-silent-empty-read.grit`, `driver/test/k8s-read-faults.test.ts`');
        expect(prose(kubernetesDocs)).toContain('**An unconfirmed read is inconclusive, never empty**');
        expect(prose(kubernetesDocs)).toContain(
            '`lint/no-silent-empty-read.grit`, `driver/test/k8s-read-faults.test.ts`'
        );
        expect(prose(kubernetesDocs)).toContain('a `k8s-*.ts` importing from `docker*.ts` belongs in a neutral file');
    });
});
