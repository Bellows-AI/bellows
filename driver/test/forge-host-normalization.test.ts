import { spawn } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateForgeScript } from '../src/container-scripts.js';
import { normalizeForgeHost } from '../src/repo-ref.js';

/*
 * ONE normalization rule for a forge host wherever one is compared or keyed (docs/connections.md): lowercase, a
 * default `:443` dropped, any other port kept, anything that is not a host name refused. The driver's
 * `normalizeForgeHost` is the rule; the copies that cannot import TypeScript — the runner's credential broker, the task
 * supervisor and the forge helper script — each keep their own, and every one must answer this table the same.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const require_ = createRequire(import.meta.url);
const broker = require_('../../docker/executor-common/credential-broker.cjs') as {
    normalizeHost(host: unknown): string | null;
};
const supervisor = require_('../src/scripts/supervisor.cjs') as { normalizeForgeHost(host: unknown): string | null };

const TABLE: [input: string, normalized: string | null][] = [
    ['gitlab.example.com', 'gitlab.example.com'],
    ['GitLab.Example.com', 'gitlab.example.com'],
    ['gitlab.example.com:443', 'gitlab.example.com'],
    ['GITLAB.EXAMPLE.COM:443', 'gitlab.example.com'],
    ['gitlab.example.com:8443', 'gitlab.example.com:8443'],
    ['git-lab.example.com', 'git-lab.example.com'],
    ['gitlab', 'gitlab'],
    ['gitlab.example.com.', null],
    ['.gitlab.example.com', null],
    ['gitlab..example.com', null],
    ['-gitlab.example.com', null],
    ['gitlab-.example.com', null],
    ['', null],
    [' gitlab.example.com', null],
    ['gitlab.example.com ', null],
    ['gitlab example.com', null],
    ['gitlab.example.com\n', null],
    ['a@b', null],
    ['user@gitlab.example.com', null],
    ['gitlab.example.com/x', null],
    ['gitlab.example.com:', null],
    ['gitlab.example.com:https', null],
    ['gitlab.example.com:443:443', null],
    ['gitlab.example.com:123456', null],
    ['[::1]', null],
    ['[::1]:443', null],
    ['::1', null],
    ['fe80::1', null],
];

describe('the driver rule (repo-ref.ts normalizeForgeHost)', () => {
    it.each(TABLE)('%j → %j', (input, normalized) => {
        expect(normalizeForgeHost(input)).toBe(normalized);
    });

    it('refuses a value that is not a string', () => {
        expect(normalizeForgeHost(undefined)).toBeNull();
        expect(normalizeForgeHost(443)).toBeNull();
    });
});

describe('the runner credential broker (credential-broker.cjs normalizeHost)', () => {
    it.each(TABLE)('%j → %j', (input, normalized) => {
        expect(broker.normalizeHost(input)).toBe(normalized);
    });
});

describe('the task supervisor (supervisor.cjs normalizeForgeHost)', () => {
    it.each(TABLE)('%j → %j', (input, normalized) => {
        expect(supervisor.normalizeForgeHost(input)).toBe(normalized);
    });
});

/*
 * The forge helper (`scripts/gate-forge.sh`, also behind `credential-helper-forge.sh`) as git runs it: `get` with the
 * input as the `host=` line. Its allow list names every spelling a looser rule could produce, so only its own rule
 * decides: it asks for exactly the normalized host, or asks nothing. A test-played supervisor answers each ask `none`.
 */
const dir = mkdtempSync(join(tmpdir(), 'forge-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function helperAsks(input: string, listed: string[]): Promise<string[]> {
    const box = mkdtempSync(join(dir, 'box-'));
    for (const name of ['asks', 'answers']) mkdirSync(join(box, name));
    const helper = join(box, 'gate-forge.sh');
    writeFileSync(helper, gateForgeScript);
    chmodSync(helper, 0o700);
    const said: string[] = [];
    const answered = new Set<string>();
    const timer = setInterval(() => {
        for (const n of readdirSync(join(box, 'asks'))) {
            if (n.startsWith('.') || answered.has(n)) continue;
            answered.add(n);
            said.push(readFileSync(join(box, 'asks', n), 'utf8'));
            writeFileSync(join(box, 'answers', `${n}.tmp`), 'none test\n');
            renameSync(join(box, 'answers', `${n}.tmp`), join(box, 'answers', n));
        }
    }, 5);
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn('/bin/sh', [helper, 'get'], {
                env: {
                    PATH: '/usr/bin:/bin',
                    FACTORY_GATE_MODE: 'credential',
                    FACTORY_GATE_RUN: box,
                    FACTORY_GATE_ASK_SECONDS: '5',
                    FACTORY_FORGE_HOSTS: listed.join(','),
                },
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            child.on('error', reject);
            child.on('close', () => resolve());
            child.stdin.end(`protocol=https\nhost=${input}\n\n`);
        });
    } finally {
        clearInterval(timer);
    }
    return said.map((text) => text.replace(/^ask /, '').trimEnd());
}

describe('the forge helper (gate-forge.sh)', () => {
    it.each(TABLE.filter(([input]) => !input.includes('\n')))('%j → %j', async (input, normalized) => {
        const lower = input.toLowerCase();
        const listed = [lower, lower.replace(/:443$/, ''), ...(normalized ? [normalized] : [])].filter(
            (host) => host !== '' && !host.includes(',')
        );
        expect(await helperAsks(input, listed)).toEqual(normalized ? [normalized] : []);
    });
});
