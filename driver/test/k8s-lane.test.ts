import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
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
        // Only the collector, a pinned upstream image kind skips when the node holds it, is side-loaded.
        expect(load.match(/kind load /g)).toHaveLength(1);
        expect(load).toContain('kind load docker-image "$COLLECTOR_IMAGE" --name "$kind_name"');
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
