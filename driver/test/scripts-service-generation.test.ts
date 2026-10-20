import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    serviceGenerationBumpScript,
    serviceGenerationProbeScript,
    serviceProbeArgv,
    serviceRestartArgv,
} from '../src/container-scripts.js';
import { SERVICE_GENERATIONS, SERVICE_NOT_ACKED_EXIT } from '../src/supervisor-contract.js';

/**
 * A declared service's restart under kubernetes (issue #773 D9, R2-4): the supervisor bumps the
 * service's generation file, the sidecar's liveness probe sees the bump and fails, and the kubelet
 * restarts the container with a fresh writable layer, where the probe records the new generation and
 * acknowledges it. Both scripts hold no kill, so they run here for real, against temp directories:
 * the probe's record file is an argument for exactly that reason.
 */
const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), 'service-generation-'));
    const generations = join(root, 'generations');
    const acks = join(root, 'acks');
    mkdirSync(generations);
    for (const name of ['db', 's3']) mkdirSync(join(acks, name), { recursive: true });
    return { root, generations, acks };
};

const sh = (argv: string[]) => {
    const [, , script, ...rest] = argv;
    return spawnSync('sh', ['-c', script!, ...rest], { encoding: 'utf8', timeout: 10_000 });
};

/** One probe run of `name`'s container, its writable layer standing at `record`. */
const probe = (box: ReturnType<typeof sandbox>, name: string, record: string) => {
    const [exe, flag, script, arg0, generations, service, ack] = serviceProbeArgv(name);
    expect([exe, flag, script, arg0, generations, service, ack]).toEqual([
        'sh',
        '-c',
        serviceGenerationProbeScript,
        'service-probe',
        SERVICE_GENERATIONS.path,
        name,
        SERVICE_GENERATIONS.ackPath,
    ]);
    return spawnSync(
        'sh',
        ['-c', serviceGenerationProbeScript, 'service-probe', box.generations, name, join(box.acks, name), record],
        {
            encoding: 'utf8',
            timeout: 10_000,
        }
    );
};

const restart = (box: ReturnType<typeof sandbox>, mode: 'acked' | 'bump', names: string[]) => {
    const argv = serviceRestartArgv(mode, names);
    expect(argv.slice(0, 7)).toEqual([
        'sh',
        '-c',
        serviceGenerationBumpScript,
        'service-generation',
        mode,
        SERVICE_GENERATIONS.path,
        SERVICE_GENERATIONS.ackRoot,
    ]);
    return sh([
        'sh',
        '-c',
        serviceGenerationBumpScript,
        'service-generation',
        mode,
        box.generations,
        box.acks,
        ...names,
    ]);
};

const read = (path: string): string => readFileSync(path, 'utf8').trim();

describe('the service generation probe', () => {
    it('records the generation on its first run in a fresh layer, and acknowledges it', () => {
        const box = sandbox();
        const record = join(box.root, 'layer-1');
        expect(probe(box, 'db', record).status).toBe(0);
        // No generation was ever bumped: the first one is 0.
        expect(read(record)).toBe('0');
        expect(read(join(box.acks, 'db', 'ack'))).toBe('0');
        expect(probe(box, 'db', record).status).toBe(0);
    });

    it('fails once the generation moved past the one its layer recorded, and a fresh layer acknowledges the new one', () => {
        const box = sandbox();
        const record = join(box.root, 'layer-1');
        expect(probe(box, 'db', record).status).toBe(0);
        writeFileSync(join(box.generations, 'db'), '1\n');
        expect(probe(box, 'db', record).status).not.toBe(0);
        // The restarted container: a new writable layer, so no record yet.
        const fresh = join(box.root, 'layer-2');
        expect(probe(box, 'db', fresh).status).toBe(0);
        expect(read(fresh)).toBe('1');
        expect(read(join(box.acks, 'db', 'ack'))).toBe('1');
    });

    it('fails when its layer cannot be written, so an image without a writable /tmp never reads alive', () => {
        const box = sandbox();
        expect(probe(box, 'db', join(box.root, 'missing-dir', 'record')).status).not.toBe(0);
    });
});

describe('the service generation bump', () => {
    it('answers which services have not acknowledged their generation', () => {
        const box = sandbox();
        expect(probe(box, 'db', join(box.root, 'db-layer')).status).toBe(0);
        const acked = restart(box, 'acked', ['db', 's3']);
        expect(acked.status).toBe(SERVICE_NOT_ACKED_EXIT);
        expect(acked.stdout.trim().split('\n')).toEqual(['s3']);
        expect(probe(box, 's3', join(box.root, 's3-layer')).status).toBe(0);
        expect(restart(box, 'acked', ['db', 's3']).status).toBe(0);
    });

    // R2-4: a restart asked before a probe ever acknowledged waits for it — the bump changes nothing.
    it('bumps nothing while any service has not acknowledged its current generation', () => {
        const box = sandbox();
        expect(probe(box, 'db', join(box.root, 'db-layer')).status).toBe(0);
        const refused = restart(box, 'bump', ['db', 's3']);
        expect(refused.status).toBe(SERVICE_NOT_ACKED_EXIT);
        expect(readdirSync(box.generations)).toEqual([]);
    });

    it('bumps every named service by one, atomically, leaving no staging file behind', () => {
        const box = sandbox();
        for (const name of ['db', 's3']) expect(probe(box, name, join(box.root, `${name}-layer`)).status).toBe(0);
        expect(restart(box, 'bump', ['db', 's3']).status).toBe(0);
        expect(readdirSync(box.generations).sort()).toEqual(['db', 's3']);
        expect(read(join(box.generations, 'db'))).toBe('1');
        // The old layers now fail their probe; the bumped generation waits for a new acknowledgement.
        expect(probe(box, 'db', join(box.root, 'db-layer')).status).not.toBe(0);
        expect(restart(box, 'acked', ['db', 's3']).status).toBe(SERVICE_NOT_ACKED_EXIT);
        expect(probe(box, 'db', join(box.root, 'db-layer-2')).status).toBe(0);
        expect(probe(box, 's3', join(box.root, 's3-layer-2')).status).toBe(0);
        expect(restart(box, 'acked', ['db', 's3']).status).toBe(0);
        expect(restart(box, 'bump', ['db', 's3']).status).toBe(0);
        expect(read(join(box.generations, 's3'))).toBe('2');
    });

    it('refuses a service name that is not a plain DNS label', () => {
        const box = sandbox();
        for (const name of ['../db', 'db x', '']) {
            expect(restart(box, 'bump', [name]).status, JSON.stringify(name)).toBe(2);
        }
        expect(readdirSync(box.generations)).toEqual([]);
    });
});
