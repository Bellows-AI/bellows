import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { parseClaim } from '../src/board/board-claim.js';
import { RESERVED_ENV_NAMES, runnerClaimEnv } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { supervisorCreateArgs } from '../src/docker/docker-group.js';
import { FORGE_CA_ENV, FORGE_CA_MAX_BYTES, GATE_FORGE_CA_ENV, gateForgeCa } from '../src/forge-ca.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';
import { logRoot } from '../src/log.js';
import { supervisorLiterals } from '../src/supervisor-plan.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { boardJob } from './fixtures/board-job.js';
import { githubRef } from './fixtures/repo-ref.js';

/*
 * A self-managed GitLab behind a private CA (docs/connections.md): the claim carries the connection's CA chain as
 * `forgeCa`, a public certificate chain read as untrusted board input — PEM certificate blocks only, capped, for a
 * GitLab repository — and both executors hand it to the agent (`RUNNER_FORGE_CA`), the supervisor
 * (`SUPERVISOR_FORGE_CA`) and a gate (`FACTORY_FORGE_CA`). The real git against a private-CA remote: forge-ca-git.test.ts.
 */

const BLOCK = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZXhhbXBsZQ==\nAAAA\n-----END CERTIFICATE-----';
const CHAIN = `${BLOCK}\n${BLOCK}\n`;
const GITLAB = { forge: 'gitlab', host: 'GitLab.Example.com', path: 'group/sub/project' } as const;
const WIRE = {
    id: 'job-1',
    command: 'echo hi',
    attempts: 1,
    claimSeq: 1,
    leaseToken: 'token-1',
    ingestToken: 'ingest-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
};
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const USER = '44444444-4444-4444-8444-444444444444';
const config = loadDriverConfig({});

afterEach(() => vi.restoreAllMocks());

/** The claim parsed with the driver's log captured: every line it wrote, by level. */
function parsed(wire: Record<string, unknown>) {
    const lines: string[] = [];
    const record = (line: unknown) => lines.push(String(line));
    vi.spyOn(logRoot, 'child').mockReturnValue({
        warn: record,
        error: record,
        info: record,
    } as unknown as ReturnType<typeof logRoot.child>);
    const result = parseClaim({ ...WIRE, ...wire });
    if (!('claim' in result)) throw new Error(`malformed: ${result.malformed.join(',')}`);
    return { claim: result.claim, lines };
}

describe('the claim’s forgeCa', () => {
    it('keeps a GitLab job’s PEM certificate chain, with no log line', () => {
        const { claim, lines } = parsed({ repo: GITLAB, forgeCa: CHAIN });
        expect(claim.forgeCa).toBe(CHAIN);
        expect(lines).toEqual([]);
    });

    it('reads a CRLF chain into the same chain with LF line ends', () => {
        const { claim } = parsed({ repo: GITLAB, forgeCa: CHAIN.replace(/\n/g, '\r\n') });
        expect(claim.forgeCa).toBe(CHAIN);
    });

    it('keeps a bundle file’s certificate blocks alone, not the comments between them', () => {
        const { claim, lines } = parsed({
            repo: GITLAB,
            forgeCa: `# Issuer: CN=Example Root\n${BLOCK}\n\n# Intermediate\n${BLOCK}`,
        });
        expect(claim.forgeCa).toBe(CHAIN);
        expect(lines).toEqual([]);
    });

    it.each([
        ['a GitHub job', { repo: githubRef('o/n'), forgeCa: CHAIN }],
        ['a repo-less job', { forgeCa: CHAIN }],
        ['a value that is no string', { repo: GITLAB, forgeCa: 7 }],
        ['an empty value', { repo: GITLAB, forgeCa: '' }],
        [
            'a private key beside the certificate',
            { repo: GITLAB, forgeCa: `${CHAIN}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n` },
        ],
        ['a body that is not base64', { repo: GITLAB, forgeCa: BLOCK.replace('AAAA', 'not base64!') }],
        ['an unterminated block', { repo: GITLAB, forgeCa: '-----BEGIN CERTIFICATE-----\nAAAA\n' }],
        [
            'an oversize chain',
            { repo: GITLAB, forgeCa: BLOCK.repeat(Math.ceil(FORGE_CA_MAX_BYTES / BLOCK.length) + 1) },
        ],
    ])('drops it for %s, with a log line that names no PEM, and still runs the claim', (_case, wire) => {
        const { claim, lines } = parsed(wire);
        expect(claim).not.toHaveProperty('forgeCa');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/forge CA/);
        expect(lines.join('\n')).not.toMatch(/BEGIN|END|MIIB|AAAA/);
    });

    it('caps the chain below the kernel’s bound on one env string (MAX_ARG_STRLEN, 128 KiB), name included', () => {
        expect(FORGE_CA_MAX_BYTES + `${SUPERVISOR_ENV.forgeCa}=`.length).toBeLessThan(131_072);
    });
});

describe('the CA reaches every consumer, on both executors', () => {
    const job = {
        ...boardJob(),
        id: '11111111-1111-4111-8111-111111111111',
        leaseToken: '22222222-2222-4222-8222-222222222222',
        masterPrompt:
            'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
        userId: USER,
        workspacePath: `bellows/${USER}`,
        repo: GITLAB,
        forgeCa: CHAIN,
        env: { MEMBER_VAR: 'member', [FORGE_CA_ENV]: 'claimed' },
    } as BoardJob;
    const github = { ...job, repo: githubRef('o/n') } as BoardJob;
    const { forgeCa: _none, ...caless } = job;
    const containerEnv = (of: BoardJob, name: string) =>
        runnerJobSpec(config, of, SESSION).spec.template.spec.containers.find((c) => c.name === name)!.env;
    const dockerEnv = (argv: string[]) =>
        Object.fromEntries(
            argv.flatMap((arg, i) => (argv[i - 1] === '-e' && arg.includes('=') ? [arg.split(/=(.*)/s)] : []))
        ) as Record<string, string>;

    it('the agent: RUNNER_FORGE_CA on docker’s agent and kubernetes’ agent container', () => {
        expect(FORGE_CA_ENV).toBe('RUNNER_FORGE_CA');
        expect(dockerEnv(dockerArgs(config, job, SESSION, { envFile: '/tmp/agent.env' }))[FORGE_CA_ENV]).toBe(CHAIN);
        expect(containerEnv(job, AGENT_CONTAINER)).toContainEqual({ name: FORGE_CA_ENV, value: CHAIN });
        // The opencode plan carries it the same way: both plans share runner-plan.ts.
        const opencode = { ...job, executorType: 'opencode' } as BoardJob;
        const opencodeSession = { id: 'ses_0123456789abcdefABCDEF', resume: true };
        expect(
            dockerEnv(dockerArgs(config, opencode, opencodeSession, { envFile: '/tmp/agent.env' }))[FORGE_CA_ENV]
        ).toBe(CHAIN);
        expect(
            runnerJobSpec(config, opencode, opencodeSession).spec.template.spec.containers.find(
                (c) => c.name === AGENT_CONTAINER
            )!.env
        ).toContainEqual({ name: FORGE_CA_ENV, value: CHAIN });
        for (const none of [github, caless]) {
            expect(dockerArgs(config, none, SESSION, { envFile: '/tmp/agent.env' }).join(' ')).not.toContain(
                FORGE_CA_ENV
            );
            expect(JSON.stringify(containerEnv(none, AGENT_CONTAINER))).not.toContain(FORGE_CA_ENV);
        }
    });

    it('the supervisor: SUPERVISOR_FORGE_CA in the one literal list docker and kubernetes share', () => {
        expect(SUPERVISOR_ENV.forgeCa).toBe('SUPERVISOR_FORGE_CA');
        const group = { exporting: false, agentless: false };
        expect(Object.fromEntries(supervisorLiterals(config, job, group))[SUPERVISOR_ENV.forgeCa]).toBe(CHAIN);
        expect(dockerEnv(supervisorCreateArgs(config, job, group, null))[SUPERVISOR_ENV.forgeCa]).toBe(CHAIN);
        expect(containerEnv(job, SUPERVISOR_CONTAINER)).toContainEqual({ name: SUPERVISOR_ENV.forgeCa, value: CHAIN });
        for (const none of [github, caless]) {
            expect(supervisorLiterals(config, none, group).map(([name]) => name)).not.toContain(SUPERVISOR_ENV.forgeCa);
        }
    });

    it('a gate: FACTORY_FORGE_CA as one line, each PEM line a comma-separated field', () => {
        expect(GATE_FORGE_CA_ENV).toBe('FACTORY_FORGE_CA');
        const line = gateForgeCa(job);
        expect(line).not.toMatch(/\n/);
        expect(line?.split(',').join('\n')).toBe(CHAIN.trimEnd());
        expect(gateForgeCa(github)).toBeNull();
        expect(gateForgeCa(caless)).toBeNull();
    });

    it('is the driver’s alone: a claim value is dropped, and RUNNER_ENV may not forward it', () => {
        expect(RESERVED_ENV_NAMES).toContain(FORGE_CA_ENV);
        expect(runnerClaimEnv(job)).toEqual({ MEMBER_VAR: 'member' });
        expect(() => loadDriverConfig({ RUNNER_ENV: FORGE_CA_ENV })).toThrow(
            /RUNNER_ENV must not name RUNNER_FORGE_CA/
        );
    });
});
