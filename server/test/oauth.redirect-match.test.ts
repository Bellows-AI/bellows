import { describe, expect, it } from 'vitest';
import { isValidRedirectUri, redirectUriMatches } from '../src/oauth/redirect-match.js';

describe('redirectUriMatches', () => {
    it('matches an https or custom-scheme URI exactly, and nothing near it', () => {
        const registered = ['https://app.example/cb', 'myapp://callback'];
        expect(redirectUriMatches('https://app.example/cb', registered)).toBe(true);
        expect(redirectUriMatches('myapp://callback', registered)).toBe(true);
        expect(redirectUriMatches('https://app.example/cb/', registered)).toBe(false);
        expect(redirectUriMatches('https://app.example/cb?x=1', registered)).toBe(false);
        expect(redirectUriMatches('https://app.example:8443/cb', registered)).toBe(false);
        expect(redirectUriMatches('https://App.example/cb', registered)).toBe(false);
        expect(redirectUriMatches('myapp://callback2', registered)).toBe(false);
    });

    it.each([
        ['http://127.0.0.1/callback', 'http://127.0.0.1:54321/callback'],
        ['http://localhost/callback', 'http://localhost:3118/callback'],
        ['http://[::1]/callback', 'http://[::1]:7777/callback'],
        ['http://127.0.0.1:1111/callback', 'http://127.0.0.1:2222/callback'],
    ])('lets only the port differ on a loopback URI (%s ~ %s)', (registered, requested) => {
        expect(redirectUriMatches(requested, [registered])).toBe(true);
    });

    it.each([
        ['http://127.0.0.1/callback', 'http://localhost:5000/callback'],
        ['http://localhost/callback', 'http://127.0.0.1:5000/callback'],
        ['http://127.0.0.1/callback', 'http://127.0.0.1:5000/other'],
        ['http://127.0.0.1/callback', 'http://127.0.0.1:5000/callback?x=1'],
        ['http://127.0.0.1/callback', 'https://127.0.0.1:5000/callback'],
        ['https://127.0.0.1/callback', 'https://127.0.0.1:5000/callback'],
        ['http://127.0.0.1/callback', 'http://evil.example:5000/callback'],
        ['http://127.0.0.1/callback', 'http://user@127.0.0.1:5000/callback'],
    ])('refuses everything else on a loopback URI (%s !~ %s)', (registered, requested) => {
        expect(redirectUriMatches(requested, [registered])).toBe(false);
    });

    it('refuses a fragment, a malformed URI and an empty list', () => {
        expect(redirectUriMatches('https://app.example/cb#x', ['https://app.example/cb#x'])).toBe(false);
        expect(redirectUriMatches('not a uri', ['not a uri'])).toBe(false);
        expect(redirectUriMatches('https://app.example/cb', [])).toBe(false);
    });
});

describe('isValidRedirectUri', () => {
    it('accepts https, loopback http and custom schemes; refuses fragments, userinfo, plain remote http and script schemes', () => {
        for (const ok of ['https://a.example/cb', 'http://127.0.0.1/cb', 'http://localhost:9/cb', 'myapp://cb'])
            expect(isValidRedirectUri(ok), ok).toBe(true);
        for (const bad of [
            'https://a.example/cb#f',
            'https://u:p@a.example/cb',
            'http://a.example/cb',
            'javascript:alert(1)',
            'data:text/html,x',
            '/relative',
            '',
        ])
            expect(isValidRedirectUri(bad), bad).toBe(false);
    });
});
