import { describe, expect, it } from 'vitest';
import { csp } from '../src/app.js';

const directive = (header: string, name: string) =>
    header
        .split('; ')
        .find((part) => part.startsWith(`${name} `))
        ?.split(' ')
        .slice(1);

describe('the page Content-Security-Policy', () => {
    // A chosen image's chip thumbnail is a blob: object URL; without it the preview is a broken image.
    it('lets images load from blob: object URLs, and nothing else may', () => {
        for (const dev of [false, true]) {
            const header = csp(dev);
            expect(directive(header, 'img-src')).toEqual([
                "'self'",
                'data:',
                'blob:',
                'https://avatars.githubusercontent.com',
            ]);
            expect(directive(header, 'script-src')).toEqual(["'self'"]);
            expect(directive(header, 'default-src')).toEqual(["'none'"]);
        }
    });

    // The SPA is embedded nowhere; the consent screen in particular must not be framed (clickjacked approval).
    it('lets no page frame the app', () => {
        for (const dev of [false, true]) expect(directive(csp(dev), 'frame-ancestors')).toEqual(["'none'"]);
    });
});
