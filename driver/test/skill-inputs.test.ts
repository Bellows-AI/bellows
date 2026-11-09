import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { SkillCorrupt, SkillGone, type ClaimSkill } from '../src/board/board-skills.js';
import { loadDriverConfig } from '../src/config.js';
import { type ControlChannel, createControlChannel } from '../src/control-channel.js';
import { SKILLS_DELIVERY, skillDelivery } from '../src/input-control.js';
import { deliverClaimInputs, deliverSkills, hasClaimInputs, hasSkills } from '../src/skill-inputs.js';
import type { StepSink } from '../src/step-control.js';
import { SUPERVISOR_ENV, type StepRequest } from '../src/supervisor-contract.js';
import { InputsUnconfirmed } from '../src/task-inputs.js';
import { SKILLS_DIR } from '../src/task-volume.js';
import { sha256Of, skillOf, tarOf } from './fixtures/skill-tar.js';

/**
 * Installing the claim's pinned skills before the agent is released: the real `deliverSkills`, control channel,
 * input route and install script, with only the two outer boundaries faked. The board is a map of version -> tar (or
 * a failure), and the supervisor is a sink that runs the step's argv as a child with the control endpoint laid over
 * it (`INPUT_FEED`), its container path `/task/...` mapped to a temp directory.
 */
const run = promisify(execFile);
const ROOT = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'supervisor-token';
const V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const job = (over: Partial<BoardJob> = {}): BoardJob =>
    ({
        id: ROOT,
        rootJobId: ROOT,
        repo: null,
        claimSeq: 4,
        leaseToken: LEASE,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: TOKEN },
        ...over,
    }) as unknown as BoardJob;

describe('hasSkills and hasClaimInputs', () => {
    const PIN: ClaimSkill = { name: 'a', source: 'org', versionId: V1, sha256: 'a'.repeat(64) };
    it('is true for a pin and for a pin nothing could read, false for none', () => {
        expect(hasSkills({ skillPin: [PIN] })).toBe(true);
        expect(hasSkills({ skillPinUnreadable: 'bad' })).toBe(true);
        expect(hasSkills({})).toBe(false);
    });
    it('is true for an empty pin too: the install step is what prunes the skills a run left on the volume', () => {
        expect(hasSkills({ skillPin: [] })).toBe(true);
        expect(hasClaimInputs({ attachments: [], skillPin: [] })).toBe(true);
    });
    it('is true for files or skills', () => {
        expect(hasClaimInputs({ skillPin: [PIN] })).toBe(true);
        expect(hasClaimInputs({ attachments: [{} as never] })).toBe(true);
        expect(hasClaimInputs({ attachments: [] })).toBe(false);
    });
});

describe('deliverSkills', () => {
    let channel: ControlChannel;
    let server: Server;
    let base: string;
    let root: string;
    /** What the board holds per version: the tar it serves, or a failure it answers with. */
    let board: Map<string, Buffer | Error>;
    let reads: string[];
    let steps: StepRequest[];
    let sink: StepSink;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'skill-inputs-'));
        board = new Map();
        reads = [];
        steps = [];
        channel = createControlChannel();
        server = createServer((request, reply) => {
            const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
            void channel
                .serve(request, reply, auth)
                .then((handled) => {
                    if (!handled) reply.writeHead(404).end();
                })
                .catch(() => reply.destroy());
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        // The supervisor: the step's argv as a child, the control endpoint laid over it, /task mapped to `root`.
        sink = {
            submit: async (_token: string, step: StepRequest) => {
                steps.push(step);
                try {
                    const { stdout } = await run(step.argv[0]!, step.argv.slice(1), {
                        env: {
                            PATH: process.env.PATH ?? '',
                            ...step.env,
                            TARGET_DIR: step.env.TARGET_DIR!.replace('/task', root),
                            ...(step.env.CHECKOUT_DIR
                                ? { CHECKOUT_DIR: step.env.CHECKOUT_DIR.replace('/task', root) }
                                : {}),
                            RESTORE_URL: base,
                            RESTORE_TOKEN: TOKEN,
                        },
                    });
                    return { exitCode: 0, stdout, stderr: '', timedOut: false };
                } catch (e) {
                    const failed = e as { code: number; stdout: string; stderr: string };
                    return { exitCode: failed.code, stdout: failed.stdout, stderr: failed.stderr, timedOut: false };
                }
            },
        } as unknown as StepSink;
    });
    afterEach(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(root, { recursive: true, force: true });
    });

    const host = () => ({ config: loadDriverConfig({}), sink });
    const skillsDir = () => SKILLS_DIR.replace('/task', root);

    /** A pinned skill the board holds. */
    const hold = (name: string, versionId: string, files?: Record<string, string>): ClaimSkill => {
        const { tar, pin } = skillOf(name, versionId, files);
        board.set(versionId, tar);
        return pin;
    };
    const open = (row: BoardJob) => {
        channel.open(TOKEN);
        channel.attachInputs(
            TOKEN,
            SKILLS_DELIVERY,
            skillDelivery(
                {
                    skillContent: async (_row, versionId) => {
                        reads.push(versionId);
                        const held = board.get(versionId);
                        if (held instanceof Error) throw held;
                        return held ? { bytes: held, sha256: sha256Of(held) } : null;
                    },
                },
                { id: row.id, leaseToken: row.leaseToken },
                row.skillPin ?? []
            )
        );
        return row;
    };
    const deliver = (over: Partial<BoardJob> = {}, seq = 4) => {
        const row = open(job({ claimSeq: seq, ...over }));
        return deliverSkills(host(), row);
    };

    it('fetches, verifies and installs every pinned skill, as one sync step with the control feed', async () => {
        const pin = [hold('org-style', V1, { 'SKILL.md': 'a\n', 'scripts/x.sh': 'x\n' }), hold('mine', V2)];
        expect(await deliver({ skillPin: pin })).toEqual({ ok: true, reason: null });
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
            kind: 'sync',
            env: { INPUT_FEED: '1', INPUT_DELIVERY: 'skills', TARGET_DIR: SKILLS_DIR, STAGING_SEQ: '4' },
        });
        expect(steps[0]?.id).toMatch(/-skills$/);
        expect(readFileSync(join(skillsDir(), 'org-style', 'scripts', 'x.sh'), 'utf8')).toBe('x\n');
        expect(existsSync(join(skillsDir(), 'mine', 'SKILL.md'))).toBe(true);
        expect(reads.sort()).toEqual([V1, V2]);
    });

    it('leaves a pinned org skill to the checkout that holds it, and still installs a workspace skill (BEL-286)', async () => {
        mkdirSync(join(root, 'widgets', '.claude', 'skills', 'org-style'), { recursive: true });
        writeFileSync(join(root, 'widgets', '.claude', 'skills', 'org-style', 'SKILL.md'), 'repo copy\n');
        const { tar, pin: mine } = skillOf('mine', V2, undefined, 'workspace');
        board.set(V2, tar);
        const pin = [hold('org-style', V1), mine];
        expect(await deliver({ skillPin: pin, repo: 'acme/widgets' })).toEqual({ ok: true, reason: null });
        expect(steps[0]?.env).toMatchObject({ CHECKOUT_DIR: '/task/widgets' });
        expect(existsSync(join(skillsDir(), 'org-style'))).toBe(false);
        expect(existsSync(join(skillsDir(), 'mine', 'SKILL.md'))).toBe(true);
        expect(reads).toEqual([V2]);
    });

    it('submits no step for a row that carries no pin field at all', async () => {
        expect(await deliver({})).toEqual({ ok: true, reason: null });
        expect(steps).toEqual([]);
    });

    it('runs the installer for an explicit empty pin, which prunes every skill an earlier run installed', async () => {
        const pin = [hold('org-style', V1), hold('mine', V2)];
        await deliver({ skillPin: pin });
        expect(existsSync(join(skillsDir(), 'org-style', 'SKILL.md'))).toBe(true);
        steps = [];
        expect(await deliver({ skillPin: [] }, 5)).toEqual({ ok: true, reason: null });
        expect(steps).toHaveLength(1);
        expect(existsSync(join(skillsDir(), 'org-style'))).toBe(false);
        expect(existsSync(join(skillsDir(), 'mine'))).toBe(false);
    });

    it('refuses with skill_unavailable and the reason when the served bytes are not the pinned ones', async () => {
        const pin = hold('org-style', V1);
        board.set(V1, tarOf([{ path: 'SKILL.md', body: 'tampered' }]));
        const verdict = await deliver({ skillPin: [pin] });
        expect(verdict).toMatchObject({ ok: false, kind: 'skill_unavailable' });
        expect(verdict.reason).toMatch(/org-style.*sha256/);
        expect(existsSync(join(skillsDir(), 'org-style'))).toBe(false);
    });

    it.each([
        ['a gone bundle', new SkillGone('gone')],
        ['a corrupt one', new SkillCorrupt('corrupt')],
    ])('refuses with skill_unavailable for %s on the board', async (_name, failure) => {
        const pin = hold('org-style', V1);
        board.set(V1, failure);
        expect(await deliver({ skillPin: [pin] })).toMatchObject({ ok: false, kind: 'skill_unavailable' });
    });

    it('refuses a bundle that is not a safe skill, writing nothing outside the target', async () => {
        const evil = tarOf([
            { path: 'SKILL.md', body: 'x' },
            { path: '../../escape.txt', body: 'x' },
        ]);
        board.set(V1, evil);
        const pin: ClaimSkill = { name: 'org-style', source: 'org', versionId: V1, sha256: sha256Of(evil) };
        expect(await deliver({ skillPin: [pin] })).toMatchObject({ ok: false, kind: 'skill_unavailable' });
        expect(existsSync(join(root, '.factory', 'escape.txt'))).toBe(false);
        expect(existsSync(join(root, 'escape.txt'))).toBe(false);
    });

    it('throws InputsUnconfirmed, never a refusal, when the board fails or cannot be reached', async () => {
        const pin = hold('org-style', V1);
        board.set(V1, new Error('board 503'));
        await expect(deliver({ skillPin: [pin] })).rejects.toBeInstanceOf(InputsUnconfirmed);
        board.delete(V1); // the board answers 404 for a version it no longer lists in the pin
        await expect(deliver({ skillPin: [pin] }, 5)).rejects.toBeInstanceOf(InputsUnconfirmed);
    });

    it('throws InputsUnconfirmed before any step for a pin the claim carried but nothing could read', async () => {
        await expect(
            deliverSkills(host(), job({ skillPinUnreadable: 'the claim carries a skillPin that is not a list' }))
        ).rejects.toThrow(/not a list/);
        expect(steps).toEqual([]);
    });

    it('throws InputsUnconfirmed before any step for a skillHidden the claim carried but nothing could read', async () => {
        await expect(
            deliverSkills(host(), job({ skillHiddenUnreadable: 'the claim carries no skillHidden' }))
        ).rejects.toBeInstanceOf(InputsUnconfirmed);
        expect(steps).toEqual([]);
        expect(hasSkills({ skillHiddenUnreadable: 'bad' })).toBe(true);
    });

    it('resumes after a kill mid-install: the half-written staging is discarded and nothing partial is installed', async () => {
        const a = hold('org-style', V1);
        const b = hold('mine', V2);
        board.set(V2, new Error('board lost mid-install'));
        await expect(deliver({ skillPin: [a, b] }, 4)).rejects.toBeInstanceOf(InputsUnconfirmed);
        expect(existsSync(join(skillsDir(), 'org-style'))).toBe(false);
        // The killed claim's staging, and a half skill in it, are still on the volume.
        mkdirSync(join(skillsDir(), '.staging-4', 'mine'), { recursive: true });
        writeFileSync(join(skillsDir(), '.staging-4', 'mine', 'SKILL.md'), 'half');

        board.set(V2, skillOf('mine', V2).tar);
        expect(await deliver({ skillPin: [a, b] }, 5)).toEqual({ ok: true, reason: null });
        expect(readdirSync(skillsDir()).sort()).toEqual(['.factory-skills.json', 'mine', 'org-style']);
        expect(readFileSync(join(skillsDir(), 'mine', 'SKILL.md'), 'utf8')).toContain('mine');
    });

    it('skips a skill already installed at the pinned sha256, prunes one the pin dropped, keeps an agent-made one', async () => {
        const a = hold('org-style', V1);
        const b = hold('mine', V2);
        await deliver({ skillPin: [a, b] }, 4);
        mkdirSync(join(skillsDir(), 'agent-made'));
        writeFileSync(join(skillsDir(), 'agent-made', 'SKILL.md'), 'mine');
        reads.length = 0;

        expect(await deliver({ skillPin: [a] }, 5)).toEqual({ ok: true, reason: null });

        expect(reads).toEqual([]);
        expect(existsSync(join(skillsDir(), 'mine'))).toBe(false);
        expect(readFileSync(join(skillsDir(), 'agent-made', 'SKILL.md'), 'utf8')).toBe('mine');
        expect(existsSync(join(skillsDir(), 'org-style', 'SKILL.md'))).toBe(true);
    });

    it('overwrites a same-name directory the agent made earlier with the pinned skill', async () => {
        mkdirSync(join(skillsDir(), 'org-style'), { recursive: true });
        writeFileSync(join(skillsDir(), 'org-style', 'SKILL.md'), 'agent copy');
        const a = hold('org-style', V1, { 'SKILL.md': 'pinned\n' });
        await deliver({ skillPin: [a] });
        expect(readFileSync(join(skillsDir(), 'org-style', 'SKILL.md'), 'utf8')).toBe('pinned\n');
    });

    describe('deliverClaimInputs', () => {
        const FILE = {
            id: V2,
            name: 'a.txt',
            mediaType: 'text/plain',
            size: 1,
            sha256: 'a'.repeat(64),
            originJobId: ROOT,
        };
        /** The attachment step answers `inputs`; every other step runs for real through the supervisor stand-in. */
        const withInputs = (inputs: string): { config: ReturnType<typeof loadDriverConfig>; sink: StepSink } => ({
            config: loadDriverConfig({}),
            sink: {
                submit: async (token: string, step: StepRequest, signal?: AbortSignal) => {
                    if (!step.id.endsWith('-inputs')) return sink.submit(token, step, signal);
                    steps.push(step);
                    return { exitCode: 0, stderr: '', timedOut: false, stdout: inputs };
                },
            } as unknown as StepSink,
        });
        const last = (list: StepRequest[]) => list.map((step) => step.id.split('-').at(-1));

        it('delivers the attachments, then installs the skills', async () => {
            const row = open(job({ skillPin: [hold('org-style', V1)], attachments: [FILE] }));
            expect(await deliverClaimInputs(withInputs('{"ok":true}'), row)).toEqual({ ok: true, reason: null });
            expect(last(steps)).toEqual(['inputs', 'skills']);
            expect(existsSync(join(skillsDir(), 'org-style', 'SKILL.md'))).toBe(true);
        });

        it('stops at an attachment refusal: the skills step does not run', async () => {
            const row = open(job({ skillPin: [hold('org-style', V1)], attachments: [FILE] }));
            const refused = '{"ok":false,"reason":"gone","kind":"attachment_unavailable"}';
            expect(await deliverClaimInputs(withInputs(refused), row)).toMatchObject({
                ok: false,
                kind: 'attachment_unavailable',
            });
            expect(last(steps)).toEqual(['inputs']);
        });
    });
});
