import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARG_STRLEN_MAX, nodeEvalArgv, supervisorScript } from '../src/container-scripts.js';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const scriptsDir = new URL('../src/scripts/', import.meta.url);

describe('a container script passed by content', () => {
    it('reaches node -e in argv strings Linux accepts, however long the script', () => {
        const big = `${'// pad\n'.repeat(30_000)}console.log(typeof require, __filename, process.argv.length);`;
        expect(bytes(big)).toBeGreaterThan(ARG_STRLEN_MAX);
        const argv = nodeEvalArgv(big);
        for (const part of argv) expect(bytes(part)).toBeLessThan(ARG_STRLEN_MAX);
        const run = spawnSync(process.execPath, argv, { encoding: 'utf8' });
        expect(run.stderr).toBe('');
        // What a plain `node -e` would see: the module scope and an argv of node alone.
        expect(run.stdout.trim()).toBe('function [eval] 1');
    });

    it('keeps a character that spans chunk boundaries whole', () => {
        const text = '€😀'.repeat(40_000);
        // Three alignments of the 3-unit pattern: one puts a surrogate pair across the first boundary.
        for (const pad of ['', ' ', '  ']) {
            const run = spawnSync(
                process.execPath,
                nodeEvalArgv(`${pad}process.stdout.write(${JSON.stringify(text)})`),
                { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
            );
            expect(run.stdout).toBe(text);
        }
    });

    it('fits the supervisor into Linux argv strings', () => {
        for (const part of nodeEvalArgv(supervisorScript)) expect(bytes(part)).toBeLessThan(ARG_STRLEN_MAX);
    });

    it('leaves every other shipped script small enough to pass whole', () => {
        const oversized = readdirSync(scriptsDir)
            .filter((name) => name !== 'supervisor.cjs')
            .filter((name) => bytes(readFileSync(new URL(name, scriptsDir), 'utf8')) >= ARG_STRLEN_MAX);
        expect(oversized).toEqual([]);
    });
});
