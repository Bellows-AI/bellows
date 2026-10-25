import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/*
 * The uid seam of the tool-isolation lane (epic #1025). The lane needs docker and the real CLIs;
 * what is pinned here is the lane's own logic — the scripted-tools endpoint and the verdicts — so a
 * lane failure is never the harness's fault and no control can pass without being able to fail.
 */
interface Step {
    tool: string;
    input: Record<string, unknown>;
}
interface Result {
    id?: string;
    isError: boolean;
    text: string;
}
interface Verdict {
    name: string;
    pass: boolean;
    detail: string;
}
interface Evidence {
    results: Result[];
    skillBases: string[];
    plainSkillBases: string[];
    nodeGit: string;
}
const lane = (await import(pathToFileURL(join(ROOT, 'scripts/tool-seam-lane.mjs')).href)) as {
    seamSteps: (cli: string) => Step[];
    skillOnlySteps: (cli: string) => Step[];
    verdict: (cli: string, evidence: Evidence) => Verdict[];
};
const { createFakeModelEndpoint } = (await import(
    pathToFileURL(join(ROOT, 'scripts/fake-model-endpoint.mjs')).href
)) as {
    createFakeModelEndpoint: (options: object) => {
        listen: (port: number, host: string) => Promise<number>;
        close: () => Promise<void>;
    };
};

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
    for (const endpoint of open.splice(0)) await endpoint.close();
});

describe('the scripted-tools endpoint (--steps)', () => {
    const start = async (steps: Step[]) => {
        const endpoint = createFakeModelEndpoint({ steps });
        open.push(endpoint);
        return `http://127.0.0.1:${await endpoint.listen(0, '127.0.0.1')}`;
    };
    const ask = async (url: string, tools: string[], messages: unknown[] = []) =>
        (await (
            await fetch(`${url}/v1/messages`, {
                method: 'POST',
                body: JSON.stringify({ stream: false, tools: tools.map((name) => ({ name })), messages }),
            })
        ).json()) as { stop_reason: string; content: { name?: string; text?: string; input?: object; id?: string }[] };
    const reported = async (url: string) =>
        (await (await fetch(`${url}/steps`)).json()) as { results: Result[]; skillBases: string[] };

    it('calls the n-th step’s tool on the n-th request, matched by name whatever its case, then says done', async () => {
        const url = await start([
            { tool: 'read', input: { file_path: '/a' } },
            { tool: 'Bash', input: { command: 'true' } },
        ]);
        const first = await ask(url, ['Bash', 'Read']);
        expect(first.stop_reason).toBe('tool_use');
        expect(first.content[0]).toMatchObject({ id: 'toolu_1', name: 'Read', input: { file_path: '/a' } });
        expect((await ask(url, ['Bash', 'Read'])).content[0]).toMatchObject({
            name: 'Bash',
            input: { command: 'true' },
        });
        const last = await ask(url, ['Bash', 'Read']);
        expect(last).toMatchObject({ stop_reason: 'end_turn', content: [{ text: 'done' }] });
    });

    it('says which tool the CLI did not offer, instead of calling something else', async () => {
        const url = await start([{ tool: 'Skill', input: { skill: 'x' } }]);
        const reply = await ask(url, ['Bash']);
        expect(reply.stop_reason).toBe('end_turn');
        expect(reply.content[0]!.text).toBe('missing tool Skill');
    });

    it('reports every result, string or blocks, once, in step order, and the skill base directories', async () => {
        const url = await start([
            { tool: 'Bash', input: {} },
            { tool: 'Read', input: {} },
        ]);
        const history = [
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_2',
                        content: [{ type: 'text', text: 'two' }],
                        is_error: true,
                    },
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'one' },
                    {
                        type: 'text',
                        text: 'Base directory for this skill: /etc/claude-code/.claude/skills/jira\n\n# Jira',
                    },
                ],
            },
        ];
        await ask(url, ['Bash', 'Read'], history);
        await ask(url, ['Bash', 'Read'], history);
        expect(await reported(url)).toEqual({
            results: [
                { id: 'toolu_1', isError: false, text: 'one' },
                { id: 'toolu_2', isError: true, text: 'two' },
            ],
            skillBases: ['/etc/claude-code/.claude/skills/jira'],
            agentRequests: 2,
        });
    });

    it('never raises a Stop', async () => {
        const url = await start([{ tool: 'Bash', input: {} }]);
        await ask(url, ['Bash']);
        await expect((await fetch(`${url}/control`)).json()).resolves.toEqual({ stop: false });
    });
});

describe('the seam lane’s verdicts', () => {
    const CLIS = ['claude', 'opencode'] as const;
    const base = (cli: string) =>
        cli === 'claude' ? '/etc/claude-code/.claude/skills/jira' : '/home/node/.config/opencode/skills/jira';
    /** What a healthy runner answers, step by step, in the order of `seamSteps`. */
    const healthy = (cli: string): Evidence => {
        const ok = (text: string): Result => ({ isError: false, text });
        const denied = (): Result => ({ isError: true, text: 'EACCES: permission denied' });
        return {
            results: [
                ok('SETUP tmpdir=/tmp/factory-tmp\n'),
                ok('SEAM_FILE'),
                ok('SEAM_INNER'),
                denied(),
                denied(),
                ok('wrote'),
                ok('DELETED=yes'),
                ok('wrote'),
                ok('DELETED=no'),
                ok(
                    'CACHE_ENV=/home/factory-tool/.cache/node-compile-cache\nCACHE_DIR=/home/factory-tool/.cache/node-compile-cache/v24-x64\nCACHE_FILES=3\nCACHE_OWNER=1001\nCTRL_DIR=none\nCLI_CACHE=readonly'
                ),
                ok('TOOL_ON_CLI_REPO=ok\nCLONE=0\nINIT=0\nTOOL_ON_CTL=ok\nINIT_CTL=0'),
                ok('Launching skill: jira'),
                ok('SKILL_READ=ok\nPRIVATE=denied'),
                ok('COMMIT=0\nAUTHOR=factory-ai factory-ai@users.noreply.github.com'),
                ok('GATE_URL=http://gate.invalid:9\nGATE_TOKEN=set'),
            ],
            skillBases: [base(cli)],
            plainSkillBases: [base(cli)],
            nodeGit: 'NODE_ON_TOOL_REPO=refused\nNODE_ON_CLONE=refused\nNODE_ON_TOOL_CTL=refused',
        };
    };
    const failing = (cli: string, evidence: Evidence) =>
        lane
            .verdict(cli, evidence)
            .filter((entry) => !entry.pass)
            .map((entry) => entry.name.replace(`${cli}: `, ''));

    it.each(CLIS)('passes every case of a healthy %s run, twelve of them', (cli) => {
        const verdicts = lane.verdict(cli, healthy(cli));
        expect(verdicts.filter((entry) => !entry.pass)).toEqual([]);
        expect(verdicts).toHaveLength(12);
    });

    it('has one scripted step per result the verdicts read, and a skill-only run of the skill step', () => {
        for (const cli of CLIS) {
            expect(lane.seamSteps(cli)).toHaveLength(healthy(cli).results.length);
            expect(lane.skillOnlySteps(cli)).toEqual([lane.seamSteps(cli)[11]]);
        }
    });

    // The controls: each is a case that fails when the thing it guards is gone.
    it('fails #1016 when the CLI cannot read what the tool made, and when the control file opens too', () => {
        const unreadable = healthy('claude');
        unreadable.results[1] = { isError: true, text: 'EACCES: permission denied, open' };
        expect(failing('claude', unreadable)).toEqual([expect.stringContaining('reads a 0600 mktemp file')]);

        const widened = healthy('claude');
        widened.results[3] = { isError: false, text: 'SEAM_HOME' };
        expect(failing('claude', widened)).toEqual([expect.stringContaining('the control: a private file')]);
        const everywhere = healthy('opencode');
        everywhere.results[4] = { isError: false, text: 'SEAM_OUTSIDE' };
        expect(failing('opencode', everywhere)).toEqual([expect.stringContaining('the control: a private file')]);
    });

    it('fails #1016 when the tool cannot remove the CLI’s file in its TMPDIR, or can in the sticky /tmp', () => {
        const stuck = healthy('claude');
        stuck.results[6] = { isError: false, text: 'DELETED=no' };
        expect(failing('claude', stuck)).toEqual([expect.stringContaining('removes a file the CLI made')]);
        const loose = healthy('claude');
        loose.results[8] = { isError: false, text: 'DELETED=yes' };
        expect(failing('claude', loose)).toEqual([expect.stringContaining('the stated limit')]);
    });

    it('fails #1021 when the tool has no cache, an empty one, or the CLI’s own', () => {
        const none = healthy('claude');
        none.results[9] = {
            isError: false,
            text: 'CACHE_ENV=\nCACHE_DIR=none\nCACHE_FILES=0\nCTRL_DIR=none\nCLI_CACHE=readonly',
        };
        expect(failing('claude', none)).toEqual([expect.stringContaining('uses a compile cache and fills it')]);
        const shared = healthy('claude');
        shared.results[9] = {
            isError: false,
            text: 'CACHE_ENV=/tmp/node-compile-cache\nCACHE_DIR=/tmp/node-compile-cache/v24\nCACHE_FILES=2\nCTRL_DIR=/tmp/node-compile-cache\nCLI_CACHE=writable',
        };
        expect(failing('claude', shared)).toEqual([expect.stringContaining('the control: pointed at the CLI’s cache')]);
    });

    it('fails #1023 when the tool is refused, and when the CLI’s uid trusts what the tool wrote', () => {
        const noWorktree = healthy('claude');
        noWorktree.results[10] = {
            isError: false,
            text: 'TOOL_ON_CLI_REPO=ok\nCLONE=128\nINIT=0\nTOOL_ON_CTL=ok\nINIT_CTL=0',
        };
        expect(failing('claude', noWorktree)).toEqual([expect.stringContaining('the tool uses any repository')]);
        const trustsWorktree = {
            ...healthy('claude'),
            nodeGit: 'NODE_ON_TOOL_REPO=refused\nNODE_ON_CLONE=ok\nNODE_ON_TOOL_CTL=refused',
        };
        expect(failing('claude', trustsWorktree)).toEqual([
            expect.stringContaining('the stated limit: the CLI’s uid refuses'),
        ]);
        const trustAll = {
            ...healthy('claude'),
            nodeGit: 'NODE_ON_TOOL_REPO=ok\nNODE_ON_CLONE=ok\nNODE_ON_TOOL_CTL=ok',
        };
        expect(failing('claude', trustAll)).toEqual([
            expect.stringContaining('the stated limit: the CLI’s uid refuses'),
        ]);
        const noGitAnywhere = { ...healthy('claude'), nodeGit: '' };
        expect(failing('claude', noGitAnywhere)).toEqual([
            expect.stringContaining('the stated limit: the CLI’s uid refuses'),
        ]);
    });

    it('fails #1024 when the two runs load a skill from different paths, or the tool cannot read it', () => {
        const moved = { ...healthy('claude'), skillBases: ['/workspace/.factory/t/skills/jira'] };
        expect(failing('claude', moved)).toEqual([expect.stringContaining('loaded from the one baked path')]);
        const missing = { ...healthy('opencode'), plainSkillBases: [] };
        expect(failing('opencode', missing)).toEqual([expect.stringContaining('loaded from the one baked path')]);
        const closed = healthy('claude');
        closed.results[12] = { isError: false, text: 'SKILL_READ=denied\nPRIVATE=denied' };
        expect(failing('claude', closed)).toEqual([expect.stringContaining('the tool reads the skill')]);
        const open = healthy('claude');
        open.results[12] = { isError: false, text: 'SKILL_READ=ok\nPRIVATE=open' };
        expect(failing('claude', open)).toEqual([expect.stringContaining('the tool reads the skill')]);
    });

    it('fails #1017 when the tool cannot commit, or commits as someone else', () => {
        const refused = healthy('claude');
        refused.results[13] = { isError: false, text: 'COMMIT=128\nAUTHOR=' };
        expect(failing('claude', refused)).toEqual([expect.stringContaining('commits with the runner')]);
        const invented = healthy('opencode');
        invented.results[13] = { isError: false, text: 'COMMIT=0\nAUTHOR=agent noreply@example.com' };
        expect(failing('opencode', invented)).toEqual([expect.stringContaining('commits with the runner')]);
    });

    it('fails #1018 when the tool sees no gate URL or no token', () => {
        const noUrl = healthy('claude');
        noUrl.results[14] = { isError: false, text: 'GATE_URL=unset\nGATE_TOKEN=set' };
        expect(failing('claude', noUrl)).toEqual([expect.stringContaining('gate pair')]);
        const noToken = healthy('opencode');
        noToken.results[14] = { isError: false, text: 'GATE_URL=http://gate.invalid:9\nGATE_TOKEN=' };
        expect(failing('opencode', noToken)).toEqual([expect.stringContaining('gate pair')]);
    });

    it('fails every case of a run that produced no results', () => {
        const nothing = { ...healthy('claude'), results: [], skillBases: [], plainSkillBases: [], nodeGit: '' };
        expect(failing('claude', nothing)).toHaveLength(12);
    });
});

describe('the seam lane’s wiring', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');
    it('drives both real CLIs through the scripted-tools endpoint and the verdicts of this module', () => {
        expect(script).toContain('fake-model-endpoint.mjs --steps');
        expect(script).toContain('scripts/tool-seam-lane.mjs verdict');
    });
});
