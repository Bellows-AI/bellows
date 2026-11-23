import { describe, expect, it } from 'vitest';
import {
    formatRepoRef,
    GITHUB_REPO_PATH_PATTERN,
    githubRepo,
    parseRepoRef,
    REPO_PATH_PATTERN,
    type RepoRef,
    repoKey,
    sameRepo,
} from '../src/repo-ref.js';

const gl = (host: string, path: string): RepoRef => ({ forge: 'gitlab', host, path });

describe('parseRepoRef', () => {
    it.each<[string, RepoRef]>([
        ['acme/web', { forge: 'github', host: 'github.com', path: 'acme/web' }],
        ['gitlab:gl.example/g/sub/p', gl('gl.example', 'g/sub/p')],
        ['gitlab:GL.Example/g/p', gl('gl.example', 'g/p')],
        ['github:github.com/a/b', { forge: 'github', host: 'github.com', path: 'a/b' }],
    ])('reads %s', (text, ref) => {
        expect(parseRepoRef(text)).toEqual(ref);
    });

    it.each([
        'acme',
        'acme/',
        '/web',
        'a//b',
        '',
        'github:github.com/a/b/c',
        'gitlab:gl.example/p',
        'svn:h/a/b',
        'gitlab:/a/b',
    ])('rejects %j', (text) => {
        expect(parseRepoRef(text)).toBeNull();
    });
});

describe('formatRepoRef', () => {
    it.each(['acme/web', 'gitlab:gl.example/g/sub/p', 'gitlab:gl.example/g/P'])('round-trips %s', (text) => {
        expect(formatRepoRef(parseRepoRef(text)!)).toBe(text);
    });

    it('spells a GitHub ref on github.com as the bare owner/name', () => {
        expect(formatRepoRef(githubRepo('acme/web'))).toBe('acme/web');
    });

    it('keeps the forge prefix for GitHub on another host', () => {
        expect(formatRepoRef({ forge: 'github', host: 'ghe.example', path: 'a/b' })).toBe('github:ghe.example/a/b');
    });
});

describe('sameRepo and repoKey', () => {
    it.each<[string, RepoRef, RepoRef, boolean]>([
        ['github folds case', githubRepo('acme/Web'), githubRepo('acme/web'), true],
        ['gitlab keeps case', gl('gl.example', 'g/P'), gl('gl.example', 'g/p'), false],
        ['two hosts stay distinct', gl('gl.a', 'g/p'), gl('gl.b', 'g/p'), false],
        ['two forges stay distinct', githubRepo('a/b'), gl('github.com', 'a/b'), false],
        ['host compare folds case', gl('GL.Example', 'g/p'), gl('gl.example', 'g/p'), true],
    ])('%s', (_name, a, b, same) => {
        expect(sameRepo(a, b)).toBe(same);
        expect(repoKey(a) === repoKey(b)).toBe(same);
    });
});

describe('path patterns', () => {
    it('keeps the GitHub pattern source of the batch plan schema', () => {
        expect(GITHUB_REPO_PATH_PATTERN.source).toBe('^[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+$');
    });

    it.each([
        ['a/b', true],
        ['g/sub/p', true],
        ['g/sub/deep/p', true],
        ['a', false],
        ['a//b', false],
        ['a/b/', false],
        ['a/b c', false],
    ])('REPO_PATH_PATTERN %j → %s', (path, ok) => {
        expect(REPO_PATH_PATTERN.test(path)).toBe(ok);
    });
});
