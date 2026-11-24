import { formatRepoRef, parseRepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { formatRepoRef as cliFormat, parseRepoRef as cliParse } from '../../cli/src/repo-ref.js';

/** The CLI imports nothing, so its repo ref parser is a copy; this pins it to core's. */
const TEXTS = [
    'acme/web',
    'acme/Web.js',
    'github:github.com/o/n',
    'github:GitHub.com/o/n',
    'gitlab:gl.example/g/sub/p',
    'gitlab:GL.Example:8443/g/sub/p',
    'gitlab:gl.example/p',
    'github:ghe.example/a/b/c',
    'a/b/c',
    'bad',
    '',
    'svn:h/a/b',
    'gitlab:../a/b',
    'gitlab:gl.example/a b',
    '/acme/web',
];

describe('the CLI copy of the repo ref parser', () => {
    it.each(TEXTS)('parses %j as core does', (text) => {
        expect(cliParse(text)).toEqual(parseRepoRef(text));
    });

    it.each(TEXTS.filter((text) => parseRepoRef(text) !== null))('formats %j as core does', (text) => {
        const ref = parseRepoRef(text)!;
        expect(cliFormat(ref)).toBe(formatRepoRef(ref));
    });
});
