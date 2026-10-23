import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
    SUPERVISOR_ORPHAN_MIN_MS,
    SUPERVISOR_REBIND_GRACE_MS,
    SUPERVISOR_STEP_WAIT_MS,
} from '../src/supervisor-contract.js';
import { REPO_ROOT, readRepoFile } from './fixtures/repo-files.js';

describe('kind lane argument validation', () => {
    it.each([
        ['--cluster', '--phase', 'typo'],
        ['--cluster', '--phase'],
        ['--phase', 'recovery'],
        ['--phase', 'all'],
        ['--netpol', '--phase', 'recovery'],
        ['--netpol', '--cluster'],
        ['--unknown'],
    ])('refuses %j before starting any lane', (...args) => {
        const result = spawnSync('bash', ['scripts/test-k8s.sh', ...args], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 5000,
        });
        expect(result.status).toBe(2);
        expect(result.stdout).not.toContain('# chart');
        expect(result.stderr).toBe('');
    });

    it('offers the supervisor control phase (issue #770)', () => {
        const result = spawnSync('bash', ['scripts/test-k8s.sh', '--help'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 5000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('|recovery|services|takeover|control|acceptance|capacity|drain|bench]');
    });

    it('runs the failure-matrix acceptance phase in the full cluster run, one named check per case (issue #779)', () => {
        const script = readRepoFile('scripts/test-k8s.sh');
        expect(script).toContain('if selected_phase acceptance; then');
        for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(script).toContain(`'acceptance: ${c}. `);
        expect(script).toContain('--grace-period=0 --force');
        expect(script).toContain('the claim listing contains (a)');
    });
});

/*
 * scripts/kind-cluster.sh against stub `docker` and `kind` binaries. Each stub answers from the
 * environment and appends its argv to $STUB_LOG, so a case states the host it stands on and reads
 * back what the script did to it.
 */
const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >>"$STUB_LOG"
case "$1" in
inspect)
    [ -n "$STUB_REGISTRY" ] || exit 1
    case "$*" in *State.Running*) echo "$STUB_REGISTRY" ;; *Networks*) echo "$STUB_NETWORK" ;; esac
    ;;
port) [ -n "$STUB_PORT" ] || exit 1; echo "$STUB_PORT" ;;
ps) [ -z "$STUB_PS_FAIL" ] || exit 1; [ -z "$STUB_REGISTRY" ] || echo 0123abcd ;;
rm) [ -z "$STUB_RM_FAIL" ] || exit 1 ;;
exec)
    case "$*" in
    *"config dump"*) echo "    config_path = $STUB_CONFIG_PATH" ;;
    *"cat /etc/containerd/certs.d/localhost:5001/hosts.toml"*) [ -n "$STUB_HOSTS" ] || exit 1; echo "$STUB_HOSTS" ;;
    *) cat >>"$STUB_LOG" ;;
    esac
    ;;
esac
exit 0
`;
const KIND_STUB = `#!/bin/sh
echo "kind $*" >>"$STUB_LOG"
case "$*" in
"get clusters") [ -z "$STUB_CLUSTERS_FAIL" ] || exit 1; [ -z "$STUB_CLUSTERS" ] || printf '%s\\n' $STUB_CLUSTERS ;;
"get nodes --name "*) [ -z "$STUB_NODES_FAIL" ] || exit 1; [ -z "$STUB_NODES" ] || printf '%s\\n' $STUB_NODES ;;
esac
exit 0
`;
const MIRROR = '[host."http://kind-registry:5000"]';
const WIRED = {
    STUB_REGISTRY: 'true',
    STUB_NETWORK: 'kind',
    STUB_PORT: '127.0.0.1:5001',
    STUB_CONFIG_PATH: "'/etc/containerd/certs.d'",
    STUB_HOSTS: MIRROR,
    STUB_CLUSTERS: 'lane',
    STUB_NODES: 'lane-control-plane lane-worker',
};

const stubDirs: string[] = [];
afterEach(() => {
    for (const dir of stubDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = promisify(execFile);

/** Runs the script asynchronously, so a loaded host stalls the case rather than the worker. */
const kindCluster = async (verb: string, host: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'kind-cluster-'));
    stubDirs.push(dir);
    writeFileSync(join(dir, 'docker'), DOCKER_STUB);
    writeFileSync(join(dir, 'kind'), KIND_STUB);
    chmodSync(join(dir, 'docker'), 0o755);
    chmodSync(join(dir, 'kind'), 0o755);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const env = { ...process.env, ...host, STUB_LOG: log, PATH: `${dir}:${process.env.PATH ?? ''}` };
    const result = await run('sh', ['scripts/kind-cluster.sh', verb, 'lane'], { cwd: REPO_ROOT, env }).then(
        ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
            status: error.code ?? -1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
        })
    );
    return { ...result, calls: readFileSync(log, 'utf8') };
};

describe('kind cluster registry check', () => {
    it('refuses when the local registry is absent, naming make cluster for that cluster', async () => {
        const result = await kindCluster('check', { ...WIRED, STUB_REGISTRY: '' });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
        expect(result.stdout).not.toContain('make cleanup');
    });

    it.each([
        ['stopped', { STUB_REGISTRY: 'false' }],
        ['off the kind network', { STUB_NETWORK: '' }],
        ['published elsewhere', { STUB_PORT: '0.0.0.0:5001' }],
        ['published beyond loopback too', { STUB_PORT: '127.0.0.1:5001\n0.0.0.0:5001' }],
        ['with a hosts.toml pointing elsewhere', { STUB_HOSTS: '[host."http://elsewhere:5000"]' }],
        ['with no hosts.toml', { STUB_HOSTS: '' }],
        ['behind a failing node listing', { STUB_NODES_FAIL: '1' }],
    ])('refuses a registry or mirror %s, naming make cluster', async (_, broken) => {
        const result = await kindCluster('check', { ...WIRED, ...broken });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
        expect(result.stdout).not.toContain('make cleanup');
    });

    it('refuses a node created without the mirror config_path, naming make cleanup then make cluster', async () => {
        const result = await kindCluster('check', { ...WIRED, STUB_CONFIG_PATH: "''" });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cleanup CLUSTER=lane');
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
    });

    it('refuses a cluster that does not exist', async () => {
        const result = await kindCluster('check', { ...WIRED, STUB_NODES: '' });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
    });

    it('passes a cluster wired by make cluster, changing nothing', async () => {
        const result = await kindCluster('check', WIRED);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.calls).not.toMatch(/docker (run|start|network connect|rm)|kind (create|delete)/);
    });
});

describe('kind cluster create and delete', () => {
    it('creates an absent cluster from the checked-in config and wires the registry into every node', async () => {
        const result = await kindCluster('create', {
            ...WIRED,
            STUB_CLUSTERS: '',
            STUB_REGISTRY: '',
            STUB_NETWORK: '',
        });
        expect(result.status).toBe(0);
        expect(result.calls).toMatch(/kind create cluster --name lane --config \S*scripts\/kind-cluster\.yaml/);
        expect(result.calls).toContain('docker run -d --restart=always -p 127.0.0.1:5001:5000 --name kind-registry');
        expect(result.calls).toContain('docker network connect kind kind-registry');
        for (const node of ['lane-control-plane', 'lane-worker']) {
            expect(result.calls).toContain(`docker exec -i ${node} sh -c`);
        }
        expect(result.calls.split(MIRROR)).toHaveLength(3);
    });

    it.each([
        ['fails', { STUB_NODES_FAIL: '1' }],
        ['comes back empty', { STUB_NODES: '' }],
    ])('refuses, wiring nothing, when the node listing %s', async (_, broken) => {
        const result = await kindCluster('create', { ...WIRED, ...broken });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
        expect(result.calls).not.toMatch(/docker (run|start|network connect)|docker exec -i/);
    });

    it('restarts a stopped registry instead of running a second one', async () => {
        const result = await kindCluster('create', { ...WIRED, STUB_REGISTRY: 'false' });
        expect(result.status).toBe(0);
        expect(result.calls).toContain('docker start kind-registry');
        expect(result.calls).not.toContain('docker run');
        expect(result.calls).not.toContain('kind create');
    });

    it('refuses an existing cluster created without the mirror config_path, touching nothing', async () => {
        const result = await kindCluster('create', { ...WIRED, STUB_CONFIG_PATH: "''" });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('make cleanup CLUSTER=lane');
        expect(result.calls).not.toMatch(/docker (run|start|network connect)|docker exec -i/);
    });

    it('refuses a registry published anywhere but loopback 5001, naming how to replace it', async () => {
        const result = await kindCluster('create', { ...WIRED, STUB_PORT: '0.0.0.0:5001' });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('docker rm -f kind-registry');
        expect(result.stdout).toContain('make cluster CLUSTER=lane');
        expect(result.calls).not.toContain('docker exec -i');
    });

    it('keeps the registry while another kind cluster still uses it', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: 'other' });
        expect(result.status).toBe(0);
        expect(result.calls).toContain('kind delete cluster --name lane');
        expect(result.calls).not.toContain('docker rm');
    });

    it('fails when the registry it should remove cannot be removed', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: '', STUB_RM_FAIL: '1' });
        expect(result.status).not.toBe(0);
        expect(result.calls).toContain('docker rm -f -v kind-registry');
    });

    it('fails, removing nothing, when it cannot tell whether the registry exists', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: '', STUB_PS_FAIL: '1' });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('docker rm');
    });

    it('has nothing to remove when the registry is already gone', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: '', STUB_REGISTRY: '' });
        expect(result.status).toBe(0);
        expect(result.calls).not.toContain('docker rm');
    });

    it('keeps the registry when the cluster listing fails', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: '', STUB_CLUSTERS_FAIL: '1' });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('docker rm');
    });

    it('removes the registry and its volume with the last kind cluster', async () => {
        const result = await kindCluster('delete', { ...WIRED, STUB_CLUSTERS: '' });
        expect(result.status).toBe(0);
        expect(result.calls).toContain('docker rm -f -v kind-registry');
    });
});

describe('kind lane image load', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const load = script.slice(script.indexOf('begin_phase image-load'), script.indexOf('begin_phase deploy'));

    it('pushes the rebuilt images to the cluster registry under a per-run tag', () => {
        expect(script).toContain('LANE_REGISTRY=localhost:5001');
        expect(readRepoFile('scripts/kind-cluster.sh')).toContain('REGISTRY_HOST=localhost:5001');
        expect(script).toContain('DASH_REF="$DASH_REPO:$RELEASE"');
        expect(script).toContain('DRIVER_REF="$DRIVER_REPO:$RELEASE"');
        expect(script).toContain('STUB_REF="$LANE_REGISTRY/echo-executor:$RELEASE"');
        // One repository per role, never derived from an override: two overrides sharing a name
        // must not push over each other.
        expect(script).toContain('DASH_REPO="$LANE_REGISTRY/factory-ai"');
        expect(script).toContain('DRIVER_REPO="$LANE_REGISTRY/factory-driver"');
        for (const [image, ref] of [
            ['DASH_IMAGE', 'DASH_REF'],
            ['DRIVER_IMAGE', 'DRIVER_REF'],
            ['STUB_IMAGE', 'STUB_REF'],
        ]) {
            expect(load).toContain(`push_ref "$${image}" "$${ref}"`);
        }
        expect(load).toContain('docker push');
    });

    it('mirrors the pinned upstream images through the registry instead of side-loading them', () => {
        // kind load imports a whole copy into every node; the registry hands a node only what it lacks.
        expect(load).not.toContain('kind load');
        expect(script).toContain('COLLECTOR_REF="$LANE_REGISTRY/$COLLECTOR_IMAGE"');
        expect(script).toContain('POSTGRES_REF="$LANE_REGISTRY/$POSTGRES_IMAGE"');
        // Two thirds of the Debian image: a fresh node unpacks fewer bytes before the database starts.
        expect(script).toContain('POSTGRES_IMAGE=postgres:17-alpine');
        expect(load).toContain('push_ref "$COLLECTOR_IMAGE" "$COLLECTOR_REF"');
        expect(load).toContain('push_ref "$POSTGRES_IMAGE" "$POSTGRES_REF"');
        expect(script).toContain(`--set "collector.image.repository=$LANE_REGISTRY/$\{COLLECTOR_IMAGE%:*}"`);
        expect(script).toContain('--set "postgres.image=$POSTGRES_REF"');
        expect(script).toContain('--set "database.waitImage=$POSTGRES_REF"');
    });

    it('refuses a cluster without the registry before building anything', () => {
        const check = 'sh scripts/kind-cluster.sh check "$kind_name" || exit 1';
        expect(script).toContain(check);
        expect(script.indexOf(check)).toBeLessThan(script.indexOf('begin_phase images'));
    });

    it('deploys the pushed refs, never a bare side-loaded name', () => {
        expect(script).toContain('--set "dashboard.image.repository=$DASH_REPO"');
        expect(script).toContain('--set-string "dashboard.image.tag=$RELEASE"');
        expect(script).toContain('--set "driver.image.repository=$DRIVER_REPO"');
        expect(script).toContain('--set-string "driver.image.tag=$RELEASE"');
    });
});

describe('kind lane pod timeline', () => {
    const SINCE = '2026-01-01T00:00:00Z';
    const event = (name: string, reason: string, at: string, message = '') => ({
        involvedObject: { kind: 'Pod', name },
        reason,
        message,
        firstTimestamp: at,
    });
    const timeline = async (items: unknown[], pattern = '^(rel-|factory-runner-)') => {
        const child = execFile('node', ['scripts/k8s-pod-timeline.mjs', SINCE, pattern], { cwd: REPO_ROOT });
        child.stdin?.end(JSON.stringify({ items }));
        let stdout = '';
        child.stdout?.on('data', (d: Buffer) => {
            stdout += d.toString();
        });
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        expect(code).toBe(0);
        return stdout
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => line.split('\t'));
    };

    it("reads kubelet's own pull time, and an image already on the node as present", async () => {
        const rows = await timeline([
            event('rel-factory-abc', 'Scheduled', '2026-01-01T00:00:10Z'),
            event(
                'rel-factory-abc',
                'Pulled',
                '2026-01-01T00:01:20Z',
                'Successfully pulled image "localhost:5001/factory-ai:rel" in 1m2.5s (1m2.5s including waiting). Image size: 1 bytes.'
            ),
            event('rel-factory-abc', 'Started', '2026-01-01T00:01:22Z'),
            event(
                'factory-runner-1',
                'Pulled',
                '2026-01-01T00:02:00Z',
                'Container image "localhost:5001/echo-executor:rel" already present on machine'
            ),
            event('factory-runner-1', 'Scheduled', '2026-01-01T00:01:59Z'),
        ]);
        expect(rows).toEqual([
            ['pod', 'image', 'scheduled', 'pulled_at', 'pull_seconds', 'started'],
            ['rel-factory-abc', 'localhost:5001/factory-ai:rel', '10', '80', '62.5', '82'],
            ['factory-runner-1', 'localhost:5001/echo-executor:rel', '119', '120', 'present', ''],
        ]);
    });

    it('keeps only pods the run started: matching names, at or after the start', async () => {
        const rows = await timeline([
            event('rel-early', 'Scheduled', '2025-12-31T23:59:59Z'),
            event('dev-factory-xyz', 'Scheduled', '2026-01-01T00:00:05Z'),
            {
                ...event('rel-job', 'Scheduled', '2026-01-01T00:00:05Z'),
                involvedObject: { kind: 'Job', name: 'rel-job' },
            },
            { ...event('rel-new', 'Scheduled', ''), firstTimestamp: null, eventTime: '2026-01-01T00:00:07.500000Z' },
        ]);
        expect(rows.map((row) => row[0])).toEqual(['pod', 'rel-new']);
        expect(rows[1]?.[2]).toBe('8');
    });
});

describe('kind lane timing evidence', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));

    it('records every check with the seconds since the one before it', () => {
        // Regexes, not literals: the shell expansion reads as a template placeholder to noTemplateCurlyInString.
        expect(script).toMatch(/CHECKS_FILE="\$\{TIMINGS_FILE%\.tsv}\.checks\.tsv"/);
        for (const helper of ['ok() {', 'bad() {']) {
            const body = script.slice(script.indexOf(helper), script.indexOf('\n}\n', script.indexOf(helper)));
            expect(body).toContain('check_timing');
        }
    });

    it('writes the pod timeline from events before cleanup uninstalls anything', () => {
        expect(script).toMatch(/PODS_FILE="\$\{TIMINGS_FILE%\.tsv}\.pods\.tsv"/);
        const dump = cleanup.indexOf('node scripts/k8s-pod-timeline.mjs "$deploy_started_at"');
        // Not every factory- pod: the release name itself starts factory-, and so would a neighbour's.
        expect(cleanup).toContain('"^($RELEASE-|factory-(runner|reclaim|gate|orphan)-)"');
        expect(cleanup).toContain('kubectl get events -n "$NAMESPACE" -o json --request-timeout=20s');
        expect(dump).toBeGreaterThan(-1);
        expect(dump).toBeLessThan(cleanup.indexOf('helm uninstall'));
        expect(script.indexOf('deploy_started_at="$(date -u')).toBeGreaterThan(script.indexOf('begin_phase deploy'));
    });

    it('keeps the smoke driver log before recovery replaces the driver', () => {
        expect(script).toMatch(/--all-containers --timestamps --prefix --tail=-1/);
        const driver = script.indexOf(
            'save_logs "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=driver" "$DRIVER_LOG"'
        );
        expect(driver).toBeGreaterThan(script.indexOf("ok 'the reaper removes the orphan Service'"));
        expect(driver).toBeLessThan(script.indexOf('begin_phase admission'));
    });

    it('streams the first smoke runner while it runs, since the driver reaps it once finished', () => {
        const stream = script.indexOf(
            'kubectl logs -f "$smoke_pod" -n "$NAMESPACE" --all-containers --timestamps --prefix >"$RUNNER_LOG"'
        );
        expect(stream).toBeGreaterThan(script.indexOf('smoke_pod="$(await_runner_pod "$id")"'));
        expect(stream).toBeLessThan(script.indexOf('release_stub "$smoke_release"'));
        // Stopped at the end of smoke and, on any early exit, by cleanup.
        expect(script.slice(script.indexOf('save_logs "app.kubernetes.io/instance'))).toMatch(
            /kill "\$runner_log_pid"/
        );
        expect(cleanup).toMatch(/kill "\$runner_log_pid"/);
    });
});

describe('kind lane takeover and drain phases (issue #829)', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));
    const takeover = script.slice(
        script.indexOf('if selected_phase takeover; then'),
        script.indexOf('if selected_phase control; then')
    );
    const drain = script.slice(script.indexOf('if [ "$PHASE" = drain ]; then'));

    it('runs takeover in all, between services and control, and drain only when asked for', () => {
        expect(script.indexOf('if selected_phase takeover; then')).toBeGreaterThan(
            script.indexOf('if selected_phase services; then')
        );
        expect(script.indexOf('if selected_phase takeover; then')).toBeLessThan(
            script.indexOf('if selected_phase control; then')
        );
        expect(script).not.toMatch(/selected_phase drain/);
        expect(script).toMatch(
            /all\|smoke\|admission\|workspace\|recovery\|services\|takeover\|control\|acceptance\|capacity\|drain\|bench\)/
        );
    });

    it('kills the driver pod at setup, agent, gates and publish, counting from outside the pods', () => {
        expect(script).toContain('.lane-kill');
        for (const step of ['t1', 't2', 't4', 't5']) {
            expect(takeover).toContain(`-${step}"`);
        }
        expect(script).toContain('kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force');
        expect(takeover).toContain('tk_kill');
        expect(script).toContain('expired="$(expire_claim_one "$1")"');
        expect(takeover).toContain('factory-stub-commit');
        expect(takeover).toContain('lane-gh-hold');
        // Barriers sit on the job's own task volume, reached through its pods, never the dashboard's claim.
        expect(script).toContain('TK_D="/task/.lane-kill-"');
        expect(takeover).toContain('tk_use "$t5"');
        expect(script).not.toContain('/workspaces/$member_path');
        expect(takeover).toContain('supervisor: rebound to claim 2');
        expect(takeover).toContain("resumed gates from claim 1's checkpoint");
        // A group whose agent exited while its supervisor serves is taken over, never waited out (#829).
        for (const step of ['t4', 't5']) {
            expect(takeover).toContain(`"$(driver_logs)" "job $${step}: $TOOK_OVER"`);
            expect(takeover).toContain(`expect_not_contains '${step}: the finished runner was not waited out'`);
        }
        expect(takeover).toContain("commit_plan takeover-restore ''");
    });

    it('reads nothing unconfirmed as empty, and leaves nothing of a settled job', () => {
        expect(script).toMatch(/tk_count\(\) \{[^}]*printf '\?'/);
        expect(script).toMatch(
            /kubectl get jobs,pods -l "factory\.job=\$1,app\.kubernetes\.io\/instance=\$RELEASE"[^\n]*--request-timeout=10s/
        );
    });

    it('drains the driver node and the runner node, times them, and uncordons', () => {
        expect(drain).toContain('kubectl drain');
        expect(drain).toContain('--ignore-daemonsets');
        expect(drain).toContain('.recovery.tsv');
        expect(drain).toContain('uncordon');
        expect(drain).toContain('make cleanup CLUSTER=');
        expect(cleanup).toContain('uncordon');
    });

    it('keeps the shared node label as the drain-layout marker and provisions no shared volume', () => {
        expect(script).toContain('factory.lane/shared');
        for (const gone of ['factory-lane-shared', 'shared_pv', 'SHARED_SETS']) {
            expect(script).not.toContain(gone);
        }
        expect(script).not.toMatch(/kubectl delete pv\b(?!c)/);
    });
});

describe('kind lane compressed timers and stall evidence (issue #829)', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const install = script.slice(script.indexOf(`helm install "$RELEASE" charts/factory "$\{LOCAL_SETS[@]}"`));
    const installCall = install.slice(0, install.indexOf('>/dev/null'));

    it('installs the driver with a short lease, a short handover and a short rebind grace', () => {
        expect(script).toContain('LANE_LEASE_S=15');
        expect(installCall).toContain('--set-string driver.leaseSeconds="$LANE_LEASE_S"');
        // The chart derives DRIVER_HANDOVER_MS as the grace period less a minute: 70 s hands over after 10 s.
        expect(installCall).toContain('driver.terminationGracePeriodSeconds=70');
        // A rebind reaches the supervisor through the kubelet's Secret refresh (64 s measured on the kind
        // nodes, docs/kubernetes.md): the grace must outlast it, or the group ends before it can follow.
        expect(script).toContain(`LANE_REBIND_GRACE_S=$((2 * $\{KUBELET_SYNC_S:-60} + 10))`);
        expect(installCall).toContain('--set-string driver.rebindGraceMs="$((LANE_REBIND_GRACE_S * 1000))"');
    });

    // #950: the 15 s lease needs an orphan bound of 10 s (L >= orphan + L/3), under the 30 s production floor
    // and over a long poll the floor outlasts by 5 s. All three derive from the lease, and the driver refuses a mismatch.
    it('derives the orphan floor and the step long poll from the lease, and installs both', () => {
        expect(script).toContain('LANE_ORPHAN_S=$((LANE_LEASE_S - LANE_LEASE_S / 3))');
        expect(script).toContain('LANE_STEP_WAIT_MS=$((LANE_ORPHAN_S * 200))');
        expect(installCall).toContain('--set-string driver.orphanMinMs="$((LANE_ORPHAN_S * 1000))"');
        expect(installCall).toContain('--set-string driver.stepWaitMs="$LANE_STEP_WAIT_MS"');
        expect(script).not.toContain('LANE_ORPHAN_S=30');
    });

    it('renders DRIVER_ORPHAN_MIN_MS and DRIVER_STEP_WAIT_MS from chart values whose defaults are the production ones', () => {
        const values = readRepoFile('charts/factory/values.yaml');
        const template = readRepoFile('charts/factory/templates/driver-deployment.yaml');
        expect(template).toContain('- name: DRIVER_ORPHAN_MIN_MS');
        expect(template).toContain('value: {{ $.Values.driver.orphanMinMs | quote }}');
        expect(template).toContain('- name: DRIVER_STEP_WAIT_MS');
        expect(template).toContain('value: {{ $.Values.driver.stepWaitMs | quote }}');
        expect(values).toContain(`    orphanMinMs: '${SUPERVISOR_ORPHAN_MIN_MS}'`);
        expect(values).toContain(`    stepWaitMs: '${SUPERVISOR_STEP_WAIT_MS}'`);
        expect(script).toContain(`'value: "${SUPERVISOR_ORPHAN_MIN_MS}"'`);
        expect(script).toContain(`'value: "${SUPERVISOR_STEP_WAIT_MS}"'`);
    });

    it('waits out a handed-over runner for the takeover bound (lease plus rebind grace), and expects the takeover', () => {
        expect(script).toContain('HANDOVER_S=$((LANE_LEASE_S + LANE_REBIND_GRACE_S + LANE_MARGIN_S))');
        expect(script).toContain('ORPHANED_S=$((LANE_ORPHAN_S + HANDOVER_S))');
        expect(script).toContain('await_job_complete "$hard_job" "$ORPHANED_S"');
        expect(script).toContain('await_job_complete "$drained_job" "$HANDOVER_S"');
        expect(script).toContain('"job $hard: $TOOK_OVER"');
        // The hard kill's Job may be deleted by the adopter before Complete is seen: gone plus a succeeded row is the end.
        expect(script).toContain('case "$(await_brief "$hard" \'succeeded*\' 60)" in succeeded*)');
        expect(script).toContain('"job $drained: $ADOPTED"');
    });

    it('renders DRIVER_REBIND_GRACE_MS from a chart value whose default is the driver default', () => {
        const values = readRepoFile('charts/factory/values.yaml');
        const template = readRepoFile('charts/factory/templates/driver-deployment.yaml');
        expect(template).toContain('- name: DRIVER_REBIND_GRACE_MS');
        expect(template).toContain('value: {{ $.Values.driver.rebindGraceMs | quote }}');
        expect(values).toContain(`    rebindGraceMs: '${SUPERVISOR_REBIND_GRACE_MS}'`);
        expect(script).toContain(`'value: "${SUPERVISOR_REBIND_GRACE_MS}"'`);
    });

    it('dumps a job that never settled: pods and Jobs, a describe and every container log, each bounded', () => {
        const dump = script.slice(script.indexOf('kind_dump_stall() {'), script.indexOf('\nawait_brief() {'));
        expect(dump).toContain('sel="factory.job=$1,app.kubernetes.io/instance=$RELEASE"');
        expect(dump).toContain('kubectl get pods,jobs -l "$sel"');
        expect(dump).toContain('-o wide');
        expect(dump).toContain('kubectl describe pods');
        expect(dump).toContain('kubectl logs --all-containers --tail=40 -l "$sel"');
        for (const call of dump.split('\n').filter((l) => /^\s+kubectl /.test(l))) {
            expect(call).toContain('--request-timeout=10s');
        }
        expect(dump).toContain(`$\{TIMINGS_FILE%.tsv}.stall-$1.log`);
        const brief = script.slice(script.indexOf('\nawait_brief() {'), script.indexOf('\nDRIVER_DEPLOY='));
        expect(brief).toMatch(/done\n {4}kind_dump_stall "\$1"\n/);
    });
});

describe('kind lane capacity phase (issue #831)', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));
    const capacity = script.slice(
        script.indexOf('if selected_phase capacity; then'),
        script.indexOf('if [ "$PHASE" = bench ]; then')
    );

    it('runs in all, after control, and is not the drain phase', () => {
        expect(script.indexOf('if selected_phase capacity; then')).toBeGreaterThan(
            script.indexOf('if selected_phase control; then')
        );
        expect(script).not.toMatch(/selected_phase drain/);
    });

    it('runs two driver replicas under one shared budget, kills one and samples the rows', () => {
        expect(capacity).toContain('ADMISSION_MAX_RUNNING=2');
        expect(capacity).toContain('--replicas=2');
        expect(capacity).toContain('kill_driver_pods');
        expect(capacity).toContain('expire_claim_one');
        expect(capacity).toContain('claimed_by');
        expect(capacity).toContain('admission_slot_global');
        expect(capacity).toContain('.capacity.tsv');
        expect(capacity).toContain('--request-timeout');
        expect(capacity).toContain('job $h1: $TOOK_OVER');
    });

    it('restores the budget, the board connection and the driver replica count on every path', () => {
        expect(capacity).toContain('ADMISSION_MAX_RUNNING=');
        expect(capacity).toMatch(/ADMISSION_MAX_RUNNING= /);
        expect(capacity).toContain('--replicas=1');
        expect(capacity).toContain('start_port_forward');
        expect(cleanup).toMatch(/kill "\$capacity_sampler_pid"/);
    });
});

describe('kind lane services restart case (issue #926)', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const fnStart = script.indexOf('\nend_postgres_sidecar() {');
    const fn = script.slice(fnStart, script.indexOf('\n}\n', fnStart) + 3);

    // A faked `kubectl` on PATH: pg_isready fails STUB_NOT_READY times, then succeeds; every call is logged.
    const KUBECTL_STUB = `#!/bin/sh
echo "$*" >>"$STUB_LOG"
case "$*" in
*pg_isready*)
    n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0)
    echo $((n + 1)) >"$STUB_COUNT"
    [ "$n" -ge "$STUB_NOT_READY" ] || exit 1
    ;;
esac
`;
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const endSidecar = (notReady: number, env: Record<string, string> = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'k8s-lane-pg-'));
        dirs.push(dir);
        writeFileSync(join(dir, 'kubectl'), KUBECTL_STUB);
        chmodSync(join(dir, 'kubectl'), 0o755);
        const harness = `NAMESPACE=ns\nbad() { echo "BAD $1"; }\n${fn}\nend_postgres_sidecar pod-x; echo "rc=$?"\n`;
        const result = spawnSync('bash', ['-c', harness], {
            encoding: 'utf8',
            timeout: 30000,
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH ?? ''}`,
                STUB_LOG: join(dir, 'log'),
                STUB_COUNT: join(dir, 'count'),
                STUB_NOT_READY: String(notReady),
                ...env,
            },
        });
        const calls = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
        return { out: result.stdout, calls };
    };

    it('extracts the wait from the lane script', () => {
        expect(fnStart).toBeGreaterThan(-1);
        expect(fn).toContain('pg_isready -q -h 127.0.0.1');
    });

    // `kill 1` is dropped by the postgres image while its entrypoint (pid 1, no SIGTERM handler) still
    // initialises the data directory, so a kill sent before the server is ready restarts nothing.
    it('ends the postgres sidecar only after pg_isready has succeeded', () => {
        const { out, calls } = endSidecar(2);
        expect(out).toContain('rc=0');
        const kills = calls.flatMap((c, i) => (c.includes('kill 1') ? [i] : []));
        expect(kills).toEqual([3]);
        expect(calls.slice(0, 3).every((c) => c.includes('pg_isready'))).toBe(true);
    });

    it('fails the case and never ends the sidecar when postgres is not ready by the deadline', () => {
        const { out, calls } = endSidecar(1000, { PG_READY_SECONDS: '2' });
        expect(out).toContain('BAD the postgres sidecar accepts connections before it is ended');
        expect(out).toContain('rc=1');
        expect(calls.some((c) => c.includes('kill 1'))).toBe(false);
    });

    it('bounds the wait well inside the stub agent lifetime and the request timeout', () => {
        const stub = readRepoFile('scripts/k8s-stub.sh');
        const lifetime = Number(/FACTORY_STUB_TIMEOUT_SECONDS:-(\d+)/.exec(stub)?.[1]);
        const deadline = Number(/PG_READY_SECONDS:-(\d+)/.exec(fn)?.[1]);
        const request = Number(/--request-timeout=(\d+)s/.exec(fn)?.[1]);
        expect(deadline + request + 1).toBeLessThanOrEqual(lifetime / 2);
    });
});

describe('kind lane bench phase (issue #831)', () => {
    const script = readRepoFile('scripts/test-k8s.sh');
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));
    const bench = script.slice(
        script.indexOf('if [ "$PHASE" = bench ]; then'),
        script.lastIndexOf("printf '\\n%d passed")
    );

    it('runs only when asked for, after capacity, and never through selected_phase', () => {
        expect(bench.length).toBeGreaterThan(0);
        expect(script.indexOf('if [ "$PHASE" = bench ]; then')).toBeGreaterThan(
            script.indexOf('if selected_phase capacity; then')
        );
        expect(script).not.toMatch(/selected_phase bench/);
    });

    it('offers the phase in --help and says it is left out of all', () => {
        const result = spawnSync('bash', ['scripts/test-k8s.sh', '--help'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 5000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('|drain|bench]');
        expect(result.stdout).toMatch(/leaves out drain .* and bench/);
    });

    it('measures the cells the issue asks for at the chart production pace', () => {
        expect(bench).toContain('for bench_n in 1 4 8 16');
        expect(bench).toContain('for bench_r in 1 2');
        expect(bench).toContain('for bench_n in 1 8; do bench_cell recovery');
        expect(bench).toContain('helm upgrade "$RELEASE" charts/factory --reuse-values');
        expect(bench).toContain('driver.replicas=$1');
        for (const key of ['pollMs', 'leaseSeconds', 'reapIntervalMs', 'reapGraceMs']) {
            expect(bench).toContain(`bench_default ${key}`);
        }
        expect(bench).toContain('factory-stub-sleep-$task_s');
        expect(bench).toContain('.bench.tsv');
        expect(bench).toContain('scripts/bench-summary.mjs');
    });

    it('keeps the board token out of every argv and reads it inside the pod', () => {
        expect(bench).toContain('process.env.JOB_BOARD_TOKEN');
        expect(bench).not.toMatch(/JOB_BOARD_TOKEN=|\$JOB_BOARD_TOKEN|\$\{JOB_BOARD_TOKEN/);
    });

    it('bounds every cluster call and every wait, and reads a failed read as another poll', () => {
        const calls = bench
            .split('\n')
            .filter((l) => /\bkubectl (exec|get|rollout)\b/.test(l) && !l.trim().startsWith('#'));
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call, call).toMatch(/bounded |\| node|--request-timeout/);
        expect(bench).toContain('--request-timeout');
        for (const wait of bench.split('\n').filter((l) => /^\s*while \[/.test(l))) {
            expect(wait, wait).toMatch(/date \+%s/);
        }
    });

    it('stops the sampler at the cell and in cleanup, and never reads a failed sample as a count', () => {
        expect(cleanup).toMatch(/kill "\$bench_sampler_pid"/);
        expect(bench).toContain('bench_stop_sampler');
        expect(bench).toContain("row='?'");
        expect(bench).toContain('bench_sample "$BENCH_DIR/$cell.sampler.tsv" "$deadline"');
    });

    it('fails a recovery cell on a task that does not succeed, and reads the kill from the claim rows', () => {
        expect(bench).toContain("status = 'succeeded'");
        expect(bench).toContain('kill_driver_pods');
        expect(bench).toContain('j.claim_seq > v.seq');
        expect(bench).toContain('held_s');
        expect(bench).toContain('settled_s');
    });

    // Codex round 1 on S6: evidence from an earlier run or an unconfirmed kill is never evidence.
    it('starts from a fresh directory and drops every destination file before a scrape', () => {
        expect(bench).toContain('rm -rf -- "${BENCH_DIR:?}" "${BENCH_TSV:?}"');
        expect(bench.indexOf('rm -rf -- "${BENCH_DIR:?}"')).toBeLessThan(bench.indexOf('mkdir -p "$BENCH_DIR"'));
        const scrape = bench.slice(bench.indexOf('bench_scrape() {'), bench.indexOf('bench_count() {'));
        expect(scrape.indexOf('rm -f -- "${list:?}"')).toBeLessThan(scrape.indexOf('bench_pods "$comp"'));
        expect(scrape.indexOf('rm -f -- "${file:?}.prom" "${file:?}.at"')).toBeLessThan(scrape.indexOf('kubectl exec'));
        expect(scrape).toContain('date +%s >"$file.at"');
    });

    it('records each pod answer time and no shared window', () => {
        expect(bench).not.toMatch(/bench_meta "\$cell" [ab]_at/);
    });

    it('ends a recovery cell whose driver kill is not confirmed', () => {
        expect(bench).toContain('bench_meta "$cell" kill_confirmed yes');
        const refused = bench.slice(bench.indexOf('bench_meta "$cell" kill_confirmed no'));
        expect(refused.slice(0, 600)).toContain('return 1');
        expect(bench).toMatch(/kill_driver_pods; \}/);
    });

    it('moves the pod timeline into place only when it was read', () => {
        expect(bench).toContain('mv "$BENCH_DIR/$cell.pods.tsv.tmp" "$BENCH_DIR/$cell.pods.tsv"');
    });

    it('times a recovery cell from the last finish in the database, not from the end of a wait', () => {
        expect(bench).toContain('select floor(extract(epoch from max(finished_at))) from job');
        expect(bench).not.toContain('settled_s "$(($(date +%s) - a_at))"');
        expect(bench).toContain('settled_s "$((last - a_at))"');
    });
});
