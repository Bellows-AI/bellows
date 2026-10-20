import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { AGENT_LAUNCH_CAPS, GATE_UID, REVIEWER_UID, TOOL_UID, workspacePath } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { runnerJobSpec, secretName } from '../src/k8s-podspec.js';
import { reclaimGroupSpec } from '../src/k8s-group.js';
import { WORKSPACE_PATH } from '../src/publish.js';
import { SERVICE_ADDRESS } from '../src/services.js';
import { REVIEWER_HOME_VOLUME } from '../src/k8s-podfields.js';
import {
    AGENT_CONTAINER,
    GATE_CONTAINER,
    MAILBOXES,
    REVIEWER_CONTAINER,
    serviceContainerOf,
} from '../src/supervisor-contract.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

const SESSION = '33333333-3333-4333-8333-333333333333';

/*
 * The chart's admission policy (charts/factory/templates/driver-admission.yaml) admits a pod spec
 * only when every Secret it references matches one pattern, and admits a Secret create/delete only
 * under it. A new per-attempt Secret builder whose names miss the pattern would pass every offline
 * suite and then have every pod that references it refused by a real apiserver — so each builder is
 * pinned against the pattern read from the template itself, never a copy of it.
 */
const template = readFileSync(join(ROOT, 'charts/factory/templates/driver-admission.yaml'), 'utf8');
const pattern = new RegExp(/\$secretName := "([^"]+)"/.exec(template)![1]!);
/** One of the template's policies, by its name suffix: the document between two `---`. */
const policy = (suffix: string): string =>
    template
        .split('\n---\n')
        .find((doc) => doc.includes(`kind: ValidatingAdmissionPolicy\n`) && doc.includes(`-${suffix}\n`)) ?? '';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: null,
    resumeSessionId: null,
    followUp: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
} as BoardJob;

describe('the admission policy Secret pattern', () => {
    it('admits the runner claim env Secret name', () => {
        expect(secretName(job)).toMatch(pattern);
    });

    // Issue #771: the sync, the publish steps and the helpers run in the task supervisor and hold
    // no Secret of their own, and neither do the gates (issue #773): their env rides each request.
    // A Secret by one of these names is a driver doing something the design forbids, and admission
    // refuses it.
    it.each(['sync', 'publish', 'helper', 'gate'])('refuses a retired %s env Secret name', (kind) => {
        expect(`factory-${kind}-0123456789abcdef-env`).not.toMatch(pattern);
    });

    it('refuses the chart-created Secrets the driver must never reach', () => {
        expect('dev-factory-dashboard').not.toMatch(pattern);
        expect('factory-dashboard').not.toMatch(pattern);
        expect('dev-factory-runner-credentials').not.toMatch(pattern);
    });
});

/*
 * Every mount of the workspaces claim must carry a subPath of the WORKSPACE_PATH shape, so a pod
 * the driver's identity submits cannot mount the claim root. The template's pattern is a copy of
 * WORKSPACE_PATH (CEL has no case-insensitive flag), so the two are held to the same verdicts.
 */
const subPathPattern = new RegExp(/\$workspaceSubPath := "([^"]+)"/.exec(template)?.[1] ?? '(?!)');

describe('the admission policy workspace subPath pattern', () => {
    it('admits the subPath every driver workspace mount uses', () => {
        expect(workspacePath(job)).toMatch(subPathPattern);
    });

    it.each([
        'bellows/44444444-4444-4444-8444-444444444444',
        'Bellows_Org-1/ABCDEF01-2345-6789-ABCD-EF0123456789',
        `a${'b'.repeat(38)}/44444444-4444-4444-8444-444444444444`,
        `a${'b'.repeat(39)}/44444444-4444-4444-8444-444444444444`,
        '',
        'bellows',
        '/',
        '../bellows/44444444-4444-4444-8444-444444444444',
        'bellows/44444444-4444-4444-8444-444444444444/.worktrees/x',
        '-bellows/44444444-4444-4444-8444-444444444444',
        'bellows/not-a-uuid',
    ])('agrees with WORKSPACE_PATH on %j', (candidate) => {
        expect(subPathPattern.test(candidate)).toBe(WORKSPACE_PATH.test(candidate));
    });
});

/*
 * Issue #361: the scheduling knobs the driver forwards onto every pod it specs
 * (RUNNER_NODE_SELECTOR / RUNNER_TOLERATIONS / RUNNER_AFFINITY) must be ADMISSION-NEUTRAL — the
 * policy pins placement to the scheduler by refusing `nodeName` and stays silent about everything
 * else scheduling-shaped, which is what makes a tainted runner node group addable in values alone.
 * A future policy edit that reaches for these fields would silently break that, so the absence is
 * pinned against the template itself, never a copy of it.
 */
describe('the admission policy stays silent on forwarded scheduling fields', () => {
    it('still pins placement to the scheduler by refusing nodeName', () => {
        expect(template).toContain('variables.spec.nodeName');
    });

    it.each(['nodeSelector', 'tolerations', 'affinity'])('never constrains %s', (field) => {
        expect(template).not.toContain(`variables.spec.${field}`);
    });
});

/*
 * Issue #382. The policy already FORBIDS the dangerous shapes — `privileged`, added capabilities —
 * which is a different thing from REQUIRING the safe ones: a driver that silently stopped setting
 * `capabilities.drop` would be admitted by every expression above it. These three validations close
 * that, and they are the half that can fail closed: `failurePolicy: Fail` means a CEL expression
 * that does not compile refuses every pod this driver creates, so the assertions below come in
 * pairs — the expression is in the template, AND the driver's own output satisfies the field it
 * names. The second half is what turns "the policy is stricter than the driver" into an offline
 * failure instead of a cluster-wide outage.
 */
describe('the admission policy requires the pod hardening (#382)', () => {
    it.each([
        ['the seccomp profile', 'seccompProfile'],
        // The full expression fragment, never the bare field name: that also appears in the
        // template's own header comment, so a bare needle passes with the validation deleted.
        ['the escalation bit', 'c.securityContext.allowPrivilegeEscalation == false'],
        ['the capability drop', "'ALL' in c.securityContext.capabilities.drop"],
        // A CONTAINER-level seccomp profile overrides the pod-level one, so pinning only the pod
        // leaves `Unconfined` on a container admitted — the policy would require the invariant and
        // permit its exact negation one field deeper. The needle names `variables.containers`
        // explicitly: `c.securityContext.seccompProfile` alone is a SUBSTRING of the pod-level
        // expression's `variables.spec.securityContext.seccompProfile`, so it passes against a
        // template that never looks at a container at all.
        ['the container-level seccomp override', 'has(c.securityContext.seccompProfile)'],
    ])('names %s', (_label, needle) => {
        expect(template).toContain(needle);
    });

    // Issue #773: a service is a sidecar of the task pod, beside the agent, so no container has a
    // way out of the capability drop — the policy reads no label that could exempt a pod.
    it('requires the capability drop of every container, with no exemption', () => {
        expect(template).not.toContain('factory.unhardened');
        expect(template).not.toContain('podLabels');
    });

    // The honest half. Every spec the driver builds must satisfy the fields the expressions name;
    // a template tightened past the driver fails here rather than at a real apiserver.
    it('is satisfied by every pod spec the driver builds', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' });
        // The file's shared fixture carries no master prompt, which `runnerJobSpec` refuses; only
        // the pod's security fields matter here, so the cheapest legal one is enough.
        const promptedJob: BoardJob = { ...job, masterPrompt: 'Factory execution contract' };
        const pods = [
            runnerJobSpec(config, promptedJob, { id: SESSION, resume: false }).spec.template.spec,
            // The supervisor-only group of an agentless attempt and of a reclaim: no agent container.
            runnerJobSpec(config, { ...promptedJob, agent: false }, null).spec.template.spec,
            reclaimGroupSpec(config, { ...job, repo: 'Bellows-AI/factory' }, job.leaseToken).spec.template.spec,
            // A run with a gate and a declared service: their sidecars are init containers (#773).
            runnerJobSpec(
                config,
                {
                    ...promptedJob,
                    repo: 'Bellows-AI/factory',
                    gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
                    services: [{ name: 'cache', image: 'redis', environment: [], user: { uid: 999, gid: 999 } }],
                },
                { id: SESSION, resume: false }
            ).spec.template.spec,
        ];
        for (const pod of pods) {
            expect(pod.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
            const containers = [...pod.containers, ...(('initContainers' in pod && pod.initContainers) || [])];
            for (const container of containers) {
                const context = container.securityContext;
                expect(context?.allowPrivilegeEscalation, container.name).toBe(false);
                expect(context?.capabilities?.drop, container.name).toContain('ALL');
                const added = (context?.capabilities as { add?: string[] } | undefined)?.add ?? [];
                if (container.name !== AGENT_CONTAINER) expect(added, container.name).toEqual([]);
                expect(added.every((cap) => (AGENT_LAUNCH_CAPS as readonly string[]).includes(cap))).toBe(true);
            }
        }
    });

    // Issue #814: the agent's launch pair is the one capability add the policy admits, named in it as
    // the driver states it, on the container the driver names.
    it('admits the agent launch pair on the agent container alone', () => {
        expect(template).toContain(`c.name == '${AGENT_CONTAINER}'`);
        expect(template).toContain(`a in [${AGENT_LAUNCH_CAPS.map((cap) => `'${cap}'`).join(', ')}]`);
        expect(template).toContain("request.kind.kind == 'Job' && c.name ==");
    });
});

/*
 * Issue #773. The driver creates no bare pod and no Service: services and the gate are sidecars of
 * the runner Job's pod, reached on its loopback through `hostAliases`. The policy fences that shape
 * — template pins paired with the driver's own output, as above.
 */
describe('the admission policy fences the task pod shape (#773)', () => {
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' });
    const pod = runnerJobSpec(
        config,
        {
            ...job,
            masterPrompt: 'Factory execution contract',
            repo: 'Bellows-AI/factory',
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            services: [
                { name: 'cache', image: 'redis', environment: [], user: { uid: 999, gid: 999 } },
                { name: 'db', image: 'postgres:17', environment: [], user: { uid: 999, gid: 999 } },
            ],
        },
        { id: SESSION, resume: false }
    ).spec.template.spec;

    it('matches runner Jobs only: no bare pod create, no pod-only spec branch', () => {
        const pods = policy('pods');
        expect(pods).toContain("resources: ['jobs']");
        expect(pods).not.toContain("resources: ['pods']");
        expect(pods).toContain('expression: "object.spec.template.spec"');
    });

    it('creates no Service and no pod, and deletes pods only for the fence sweep', () => {
        const objects = policy('objects');
        expect(objects).not.toContain('services');
        expect(objects).not.toContain("'Service'");
        expect(objects).toContain("resources: ['secrets', 'configmaps']");
        expect(objects).toMatch(/operations: \['DELETE'\]\n\s+resources: \['pods'\]/);
    });

    it(`maps hostAliases only to ${SERVICE_ADDRESS}, which is all the driver writes there`, () => {
        expect(policy('pods')).toContain(`variables.spec.hostAliases.all(h, h.ip == '${SERVICE_ADDRESS}')`);
        expect(pod.hostAliases?.length).toBeGreaterThan(0);
        expect(pod.hostAliases?.every((alias) => alias.ip === SERVICE_ADDRESS)).toBe(true);
    });

    it(`admits a ${serviceContainerOf('')} container only as a restartable init container, beside the ${GATE_CONTAINER}`, () => {
        const pods = policy('pods');
        expect(pods).toContain(`variables.spec.containers.all(c, !c.name.startsWith('${serviceContainerOf('')}'))`);
        expect(pods).toContain(
            `c.name == '${GATE_CONTAINER}' || c.name == '${REVIEWER_CONTAINER}' || c.name.startsWith('${serviceContainerOf('')}')`
        );
        const restartable = (pod.initContainers ?? []).filter((c) => c.restartPolicy === 'Always').map((c) => c.name);
        expect(restartable).toEqual([GATE_CONTAINER, serviceContainerOf('cache'), serviceContainerOf('db')]);
        expect(pod.containers.some((c) => c.name.startsWith(serviceContainerOf('')))).toBe(false);
    });

    // Issue #774: the reviewer is the one other restartable init container name, and the resize may
    // name it, or the gate, alone.
    it(`admits the ${REVIEWER_CONTAINER} as the one other restartable init container name`, () => {
        const pods = policy('pods');
        expect(pods).toContain(
            `c.name == '${GATE_CONTAINER}' || c.name == '${REVIEWER_CONTAINER}' || c.name.startsWith('${serviceContainerOf('')}')`
        );
        const reviewing = runnerJobSpec(
            config,
            {
                ...job,
                masterPrompt: 'Factory execution contract',
                repo: 'Bellows-AI/factory',
                reviewerProfiles: ['security'],
            },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const restartable = (reviewing.initContainers ?? []).filter((c) => c.restartPolicy === 'Always');
        expect(restartable.map((c) => c.name)).toEqual([REVIEWER_CONTAINER]);
    });

    it('lets a resize patch name the gate or the reviewer alone', () => {
        const resize = policy('resize');
        expect(resize).toContain(`size(variables.changed) <= 1`);
        expect(resize).toContain(`c.name == '${GATE_CONTAINER}' || c.name == '${REVIEWER_CONTAINER}'`);
        expect(resize).toContain('a driver resize changes the gate or the reviewer container alone');
    });

    it('refuses a reviewer that runs as the tool or the gate uid, or mounts anything but its own', () => {
        const pods = policy('pods');
        expect(pods).toContain(`c.name != '${REVIEWER_CONTAINER}'`);
        expect(pods).toContain(`c.securityContext.runAsUser == ${REVIEWER_UID}`);
        expect(pods).toContain('a driver-specced reviewer runs as its own uid');
        expect(pods).toContain(
            'a driver-specced reviewer mounts its workspace read-only, its review mailbox and its home'
        );
        expect(pods).toContain(MAILBOXES.review.name);
        expect(pods).toContain(REVIEWER_HOME_VOLUME);
        expect(REVIEWER_UID).not.toBe(TOOL_UID);
        expect(REVIEWER_UID).not.toBe(GATE_UID);
    });
});
