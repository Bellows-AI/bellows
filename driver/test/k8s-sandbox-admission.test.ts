import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { readerJobSpec, runnerJobSpec, volumeExportJobSpec } from '../src/k8s/k8s-podspec.js';
import { type CelPolicy, evaluate, parse, refusals } from './fixtures/cel-subset.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/*
 * The sandbox-pool guard (charts/factory/templates/sandbox-admission.yaml): a sandbox node pool's
 * only fence is its taint, so a cluster-wide ValidatingAdmissionPolicy refuses any pod that
 * tolerates a pool's taint without one of that pool's RuntimeClasses, and any pod pinned by
 * `spec.nodeName` (which skips the scheduler, and so every taint) without a sandbox RuntimeClass.
 * Under `failurePolicy: Fail` a CEL error refuses the pod, so a field the policy reads unguarded
 * would refuse every pod in the cluster: the absent-field cases below are the guard against that.
 * The real apiserver's verdicts are the --cluster admission phase (scripts/lanes/k8s/admission.sh).
 */
const TEMPLATE_PATH = join(ROOT, 'charts/factory/templates/sandbox-admission.yaml');
const template = existsSync(TEMPLATE_PATH) ? readFileSync(TEMPLATE_PATH, 'utf8') : '';

const POOL = { key: 'sandbox.example/runtime', value: 'microvm', names: ['vm', 'shared'] };
const OTHER = { key: 'other.example/pool', value: '', names: ['vm-other'] };
const TOLERATION = { key: POOL.key, operator: 'Equal', value: POOL.value, effect: 'NoSchedule' };

/** `needle` replaced by `value`, failing when the template no longer carries it. */
function substitute(source: string, needle: string, value: string): string {
    if (!source.includes(needle)) throw new Error(`sandbox-admission.yaml no longer carries ${needle}`);
    return source.replace(needle, value);
}

interface Rendered extends CelPolicy {
    matchConditions: { name: string; expression: string }[];
    matchConstraints: { resourceRules: { resources: string[]; operations: string[] }[] };
}

/** The policy as helm renders it for these pools (taint key, value, RuntimeClasses) and exempt prefixes. */
function rendered(pools: (typeof POOL)[], prefixes: string[]): Rendered {
    const doc = template.split('\n---\n').find((d) => d.includes('kind: ValidatingAdmissionPolicy\n')) ?? '';
    let out = doc.replace(/[ \t]*\{\{\/\*[\s\S]*?\*\/\}\}\n?/g, '');
    out = substitute(
        out,
        '{{ printf "!%s.exists(p, request.namespace.startsWith(p))" (toJson $prefixes) | quote }}',
        JSON.stringify(`!${JSON.stringify(prefixes)}.exists(p, request.namespace.startsWith(p))`)
    );
    // The chart's shape: every map value a list(string), the key and value one element each.
    const literal = pools.map((p) => ({ key: [p.key], names: p.names, value: [p.value] }));
    out = substitute(out, '{{ toJson $pools | quote }}', JSON.stringify(JSON.stringify(literal)));
    const union = [...new Set(pools.flatMap((p) => p.names))].sort();
    out = substitute(out, '{{ toJson $sandboxRuntimeClasses | quote }}', JSON.stringify(JSON.stringify(union)));
    out = out.replace(/^[ \t]*\{\{[^\n]*\}\}[ \t]*\n/gm, '').replace(/\{\{[^\n]*?\}\}/g, 'x');
    return (parseYaml(out) as { spec: Rendered }).spec;
}

const CREATE = { operation: 'CREATE', namespace: 'tenant' };
const pod = (spec: Record<string, unknown>) => ({ metadata: { name: 'p' }, spec: { containers: [], ...spec } });

describe('the sandbox-pool admission policy', () => {
    const policy = () => rendered([POOL, OTHER], ['gke-managed-']);
    const refused = (spec: Record<string, unknown>, request: unknown = CREATE, oldObject: unknown = null) =>
        refusals(policy(), pod(spec), request, oldObject);

    // The apiserver type-checks every expression at install: a literal mixing value types (a string
    // beside a list) fails to compile, and the install with it. Every expression must compile.
    it('compiles every expression, message and match condition', () => {
        const spec = policy();
        const expressions = [
            ...spec.matchConditions.map((m) => m.expression),
            ...spec.variables.map((v) => v.expression),
            ...spec.validations.flatMap((v) => [v.expression, ...(v.messageExpression ? [v.messageExpression] : [])]),
        ];
        for (const expression of expressions) expect(() => parse(expression), expression).not.toThrow();
    });

    it('matches pods on create and update, no subresource', () => {
        expect(template).not.toBe('');
        const rules = policy().matchConstraints.resourceRules;
        expect(rules.map((r) => r.resources)).toEqual([['pods']]);
        expect(rules[0]!.operations).toEqual(['CREATE', 'UPDATE']);
        expect(template).toContain('failurePolicy: Fail');
        expect(template).toContain('validationActions: [Deny]');
    });

    it('refuses a pod that tolerates the pool taint and names no RuntimeClass, naming the taint key', () => {
        expect(refused({ tolerations: [TOLERATION] })).toEqual([
            `a pod that tolerates the sandbox taint ${POOL.key} must run under one of its RuntimeClasses (isolation.sandboxPools)`,
        ]);
    });

    it('refuses a pod that tolerates the pool taint under a RuntimeClass the pool does not list', () => {
        expect(refused({ tolerations: [TOLERATION], runtimeClassName: 'runc' })).toHaveLength(1);
        // Another pool's RuntimeClass is not this pool's.
        expect(refused({ tolerations: [TOLERATION], runtimeClassName: 'vm-other' })).toHaveLength(1);
    });

    it('refuses a keyless Exists toleration, which tolerates every taint, without a RuntimeClass', () => {
        expect(refused({ tolerations: [{ operator: 'Exists' }] })).toHaveLength(1);
        // It tolerates both pools, so only a RuntimeClass both list would do; none does.
        expect(refused({ tolerations: [{ operator: 'Exists' }], runtimeClassName: 'vm' })).toHaveLength(1);
    });

    it('refuses a keyed Exists toleration whatever the value', () => {
        expect(refused({ tolerations: [{ key: POOL.key, operator: 'Exists' }] })).toHaveLength(1);
    });

    it('treats an absent value as the empty value', () => {
        expect(refused({ tolerations: [{ key: OTHER.key, operator: 'Equal' }] })).toHaveLength(1);
        expect(refused({ tolerations: [{ key: OTHER.key }], runtimeClassName: 'vm-other' })).toEqual([]);
    });

    it('admits a pod that tolerates the pool taint under a listed RuntimeClass', () => {
        expect(refused({ tolerations: [TOLERATION], runtimeClassName: 'vm' })).toEqual([]);
        expect(refused({ tolerations: [TOLERATION], runtimeClassName: 'shared' })).toEqual([]);
    });

    it.each([
        ['no tolerations field', {}],
        ['an empty tolerations list', { tolerations: [] }],
        ['a toleration of another key with no operator and no value', { tolerations: [{ key: 'gpu' }] }],
        ['a toleration of the pool key with another value', { tolerations: [{ ...TOLERATION, value: 'runc' }] }],
        ['a toleration with only an effect', { tolerations: [{ effect: 'NoExecute' }] }],
        ['a RuntimeClass and no toleration', { runtimeClassName: 'gvisor' }],
    ])('admits a pod with %s, never erroring on an absent field', (_, spec) => {
        expect(refused(spec)).toEqual([]);
    });

    it('refuses a pod created with spec.nodeName and no sandbox RuntimeClass, naming spec.nodeName', () => {
        const messages = refused({ nodeName: 'node-1' });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('spec.nodeName');
        expect(refused({ nodeName: 'node-1', runtimeClassName: 'runc' })).toHaveLength(1);
    });

    it('admits a pod created with spec.nodeName under any pool RuntimeClass, and an empty nodeName', () => {
        expect(refused({ nodeName: 'node-1', runtimeClassName: 'vm' })).toEqual([]);
        expect(refused({ nodeName: 'node-1', runtimeClassName: 'vm-other' })).toEqual([]);
        expect(refused({ nodeName: '' })).toEqual([]);
    });

    // A scheduler-bound pod gets its nodeName through pods/binding, a subresource the policy does not
    // match; every later update carries it, and must not be refused.
    it('admits an update of a pod whose old object was already bound', () => {
        const bound = pod({ nodeName: 'node-1' });
        expect(refused({ nodeName: 'node-1' }, { operation: 'UPDATE', namespace: 'tenant' }, bound)).toEqual([]);
    });

    it('refuses an update that sets spec.nodeName on a pod the old object had unbound', () => {
        const unbound = pod({});
        expect(refused({ nodeName: 'node-1' }, { operation: 'UPDATE', namespace: 'tenant' }, unbound)).toHaveLength(1);
    });
});

describe('the sandbox-pool exemptions', () => {
    const condition = (prefixes: string[]) => {
        const match = rendered([POOL], prefixes).matchConditions;
        expect(match.map((m) => m.name)).toEqual(['not-exempt']);
        const node = parse(match[0]!.expression);
        return (namespace: string) => evaluate(node, { request: { namespace } });
    };

    it('exempts a namespace that starts with a prefix, nothing else', () => {
        const applies = condition(['gke-managed-', 'gmp-']);
        expect(applies('gke-managed-foo')).toBe(false);
        expect(applies('gmp-system')).toBe(false);
        expect(applies('gke-manage')).toBe(true);
        expect(applies('default')).toBe(true);
    });

    it('exempts nothing with no prefixes', () => {
        const applies = condition([]);
        for (const namespace of ['default', 'kube-system', 'gke-managed-foo']) expect(applies(namespace)).toBe(true);
    });

    it('takes exact names in the binding namespace selector, omitted when there are none', () => {
        expect(template).toContain('key: kubernetes.io/metadata.name');
        expect(template).toContain('operator: NotIn');
        expect(template).toMatch(/\{\{- with \$exact \}\}\n\s+matchResources:/);
    });
});

describe('every pod the driver specs for a pool class', () => {
    const job = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the failing build',
        attempts: 1,
        claimSeq: 1,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        masterPrompt: 'Factory execution contract',
        resumeSessionId: null,
        followUp: false,
        userId: '44444444-4444-4444-8444-444444444444',
        workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
        runnerClass: 'isolated',
    } as BoardJob;
    const config = loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: 'factory',
        RUNNER_CLASSES: JSON.stringify({ isolated: { runtimeClassName: 'vm', tolerations: [TOLERATION] } }),
        RUNNER_DEFAULT_CLASS: 'isolated',
        RUNNER_SANDBOX_POOLS: JSON.stringify([
            { taint: { key: POOL.key, value: POOL.value }, runtimeClassNames: POOL.names },
        ]),
    });

    it('is admitted, under an allowed RuntimeClass', () => {
        const session = { id: '33333333-3333-4333-8333-333333333333', resume: false };
        const root = '33333333-3333-4333-8333-333333333333';
        const specs = [
            runnerJobSpec(config, job, session).spec.template,
            readerJobSpec(config, job, 'factory-read-0', { argv: ['node'], env: {}, timeoutMs: 1_000 }).spec.template,
            volumeExportJobSpec(config, { name: 'factory-export-0', root, generation: 1, run: 'r' }, [], 60).spec
                .template,
        ];
        for (const spec of specs) {
            expect(spec.spec.tolerations).toEqual([TOLERATION]);
            expect(refusals(rendered([POOL], []), spec, CREATE, null)).toEqual([]);
        }
    });
});
