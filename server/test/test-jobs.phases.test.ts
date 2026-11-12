import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * One file per phase behind the lane scripts (scripts/lanes/<lane>/<phase>.sh): the script sources them in
 * lane order and each guards itself with selected_phase. These pins are the dispatcher: every phase the
 * lane lists in --help has its file, every file is sourced exactly once in the order it was written, and no
 * phase picks its board port from the ones a stopped board used.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const sourced = (script: string, lane: string): string[] =>
    [...read(script).matchAll(new RegExp(`^\\. "\\$REPO/scripts/lanes/${lane}/([^"]+)\\.sh"$`, 'gm'))].map(
        (match) => match[1] as string
    );
const files = (lane: string): string[] =>
    readdirSync(join(ROOT, 'scripts/lanes', lane))
        .map((name) => name.replace(/\.sh$/, ''))
        .sort();

// What `scripts/test-jobs.sh --help` listed before the phases moved into files.
const JOBS_PHASES = [
    'board',
    'driver',
    'github-credential',
    'services',
    'orphan-reaper',
    'node-disruption',
    'run-deadline',
    'review',
    'workflows',
    'acceptance',
    'compose-driver',
    'auth',
    'cooperative-stop',
    'tool-isolation',
    'image-checks',
    'ask-user-question',
    'question-round-trip',
    'pinned-skills',
    'repo-skills',
    'driver-kill',
    'capacity',
    'mcp',
];
// What `scripts/test-k8s.sh --help` lists after `smoke`; smoke is the lane's own prerequisites, not a file.
const K8S_PHASES = [
    'admission',
    'workspace',
    'recovery',
    'services',
    'takeover',
    'control',
    'acceptance',
    'capacity',
    'mcp',
    'drain',
    'bench',
];
const GUARD = /^if (selected_phase |\[ "\$PHASE" = )/m;

describe('the lane phase files', () => {
    it('test-jobs: --help lists exactly the phases that were listed before, and each has its file', () => {
        const help = spawnSync('bash', ['scripts/test-jobs.sh', '--help'], { cwd: ROOT, encoding: 'utf8' }).stdout;
        const listed = help
            .slice(help.indexOf('Phases:'), help.indexOf('A comma list'))
            .replace('Phases: all (default),', '')
            .split(/[\s,]+/)
            .filter(Boolean)
            .sort();
        expect(listed).toEqual([...JOBS_PHASES].sort());
        for (const phase of JOBS_PHASES) expect(files('jobs'), phase).toContain(phase);
    });

    it('test-jobs: every file is sourced exactly once, and each holds its own selected_phase guard', () => {
        expect(sourced('scripts/test-jobs.sh', 'jobs').sort()).toEqual(files('jobs'));
        for (const file of files('jobs')) {
            expect(read(`scripts/lanes/jobs/${file}.sh`), file).toMatch(GUARD);
        }
    });

    it('test-k8s: every phase its --phase accepts has its file, each sourced once with its own guard', () => {
        const help = spawnSync('bash', ['scripts/test-k8s.sh', '--help'], { cwd: ROOT, encoding: 'utf8' }).stdout;
        const listed = /--phase all\|smoke\|([a-z|-]+)\]/.exec(help)?.[1]?.split('|') ?? [];
        expect(listed.sort()).toEqual([...K8S_PHASES].sort());
        for (const phase of K8S_PHASES) expect(files('k8s'), phase).toContain(phase);
        expect(sourced('scripts/test-k8s.sh', 'k8s').sort()).toEqual(files('k8s'));
        for (const file of files('k8s')) {
            expect(read(`scripts/lanes/k8s/${file}.sh`), file).toMatch(GUARD);
        }
    });

    it('sources the test-jobs phases in lane order: the order of the phases test-jobs-changed.mjs lists', () => {
        const order = sourced('scripts/test-jobs.sh', 'jobs');
        const mapped = [...read('scripts/test-jobs-changed.mjs').matchAll(/^ {4}'([a-z-]+)',$/gm)].map((m) => m[1]);
        const common = mapped.filter((phase) => order.includes(phase as string));
        expect(order.filter((phase) => common.includes(phase))).toEqual(common);
    });

    it('test-jobs: every board a phase starts has a port of its own inside the ten-port slice', () => {
        const script = read('scripts/test-jobs.sh');
        const offsets = [...script.matchAll(/^[A-Z_]+_PORT=\$\(\(PORT \+ (\d+)\)\)$/gm)].map((m) => Number(m[1]));
        expect(offsets.length).toBeGreaterThanOrEqual(5);
        expect(new Set(offsets).size).toBe(offsets.length);
        expect(Math.max(...offsets)).toBeLessThan(10);
        for (const file of files('jobs')) {
            expect(read(`scripts/lanes/jobs/${file}.sh`), file).not.toMatch(/\bPORT \+ \d/);
        }
    });
});
