import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SetupStepper } from '../src/components/SetupStepper.js';
import { SetupFrame } from '../src/onboarding/SetupFrame.js';
import {
    nextSetupStep,
    reselectHref,
    safeReturnTo,
    setupContext,
    setupPath,
    type SetupState,
} from '../src/onboarding/steps.js';
import { ThemeProvider } from '../src/theme.js';

/**
 * The setup walk's frame: which step comes next, the header context, the
 * return path's same-origin rule, and the stepper's ordered list.
 */

const setup = (over: Partial<SetupState> = {}): SetupState => ({ completed: false, done: [], skipped: [], ...over });

/** The `<li>` of one step, by its visible label. */
const item = (html: string, label: string): string => {
    const found = [...html.matchAll(/<li[^>]*>.*?<\/li>/g)].map((m) => m[0]).find((li) => li.includes(label));
    expect(found, `no step named ${label}`).toBeDefined();
    return found!;
};

describe('nextSetupStep', () => {
    it('walks provider, then tools, then ready, and nothing once completed', () => {
        expect(nextSetupStep(setup())).toBe('provider');
        expect(nextSetupStep(setup({ skipped: ['provider'] }))).toBe('tools');
        expect(nextSetupStep(setup({ done: ['provider'] }))).toBe('tools');
        expect(nextSetupStep(setup({ done: ['provider'], skipped: ['tools'] }))).toBe('ready');
        expect(nextSetupStep(setup({ completed: true }))).toBeNull();
    });
});

describe('the return path', () => {
    it('keeps a same-origin path and falls back to / for anything else', () => {
        expect(safeReturnTo('/tasks?x=1#y')).toBe('/tasks?x=1#y');
        expect(safeReturnTo('//evil.example')).toBe('/');
        expect(safeReturnTo('/\\evil.example')).toBe('/');
        expect(safeReturnTo('https://evil.example/')).toBe('/');
        expect(safeReturnTo('tasks')).toBe('/');
        expect(safeReturnTo(null)).toBe('/');
    });

    it('builds the step path and the reselect round trip with the return path encoded', () => {
        expect(setupPath('provider', '/tasks')).toBe('/onboarding/provider?returnTo=%2Ftasks');
        expect(reselectHref('/onboarding/provider?returnTo=%2Ftasks')).toBe(
            '/api/auth/github?reselect=1&returnTo=%2Fonboarding%2Fprovider%3FreturnTo%3D%252Ftasks'
        );
    });
});

describe('setupContext', () => {
    it('numbers the three steps and names the closing page', () => {
        expect(setupContext('repositories')).toBe('Setup · Step 1 of 3');
        expect(setupContext('provider')).toBe('Setup · Step 2 of 3');
        expect(setupContext('tools')).toBe('Setup · Step 3 of 3');
        expect(setupContext('ready')).toBe('Ready');
    });
});

describe('SetupStepper', () => {
    it('is an ordered list with the current step marked and the steps in order', () => {
        const html = renderToStaticMarkup(
            <SetupStepper current="provider" setup={setup()} here="/onboarding/provider" />
        );
        expect(html).toMatch(/^<ol class="setup-steps" aria-label="Setup progress">/);
        expect(html.match(/<li/g)?.length).toBe(3);
        expect(html.indexOf('Repositories')).toBeLessThan(html.indexOf('Provider'));
        expect(html.indexOf('Provider')).toBeLessThan(html.indexOf('Tools'));
        expect(html.match(/aria-current="step"/g)?.length).toBe(1);
        expect(item(html, 'Provider')).toContain('aria-current="step"');
        expect(item(html, 'Tools')).toContain('>3<');
    });

    it('marks a finished step ✓ and a skipped one –', () => {
        const done = renderToStaticMarkup(
            <SetupStepper current="tools" setup={setup({ done: ['provider'] })} here="/onboarding/tools" />
        );
        expect(item(done, 'Provider')).toContain('✓');
        expect(item(done, 'Provider')).toContain('setup-step-done');
        const skipped = renderToStaticMarkup(
            <SetupStepper current="tools" setup={setup({ skipped: ['provider'] })} here="/onboarding/tools" />
        );
        expect(item(skipped, 'Provider')).toContain('–');
        expect(item(skipped, 'Provider')).toContain('setup-step-skipped');
        expect(item(skipped, 'Tools')).toContain('aria-current="step"');
    });

    it('links Repositories to the reselect round trip back to this step, never to bare /onboarding', () => {
        for (const here of ['/onboarding/provider?returnTo=%2Ftasks', '/onboarding/tools?returnTo=%2F']) {
            const html = renderToStaticMarkup(
                <SetupStepper current={here.includes('provider') ? 'provider' : 'tools'} setup={setup()} here={here} />
            );
            const href = /<a [^>]*href="([^"]*)"[^>]*>Repositories<\/a>/.exec(html)?.[1]?.replaceAll('&amp;', '&');
            expect(href).toBe(reselectHref(here));
            expect(html).not.toContain('href="/onboarding"');
            expect(item(html, 'Repositories')).toContain('✓');
        }
    });

    it('leaves Repositories plain text while it is the current step', () => {
        const html = renderToStaticMarkup(<SetupStepper current="repositories" />);
        expect(item(html, 'Repositories')).toContain('aria-current="step"');
        expect(html).not.toContain('<a ');
    });
});

describe('SetupFrame', () => {
    const frame = (place: 'provider' | 'ready') =>
        renderToStaticMarkup(
            <ThemeProvider>
                <MemoryRouter initialEntries={[`/onboarding/${place}`]}>
                    <SetupFrame place={place} title="A step" purpose="Why it matters.">
                        <p>body</p>
                    </SetupFrame>
                </MemoryRouter>
            </ThemeProvider>
        );

    it('carries the public header, the step context, the stepper and one h1', () => {
        const html = frame('provider');
        expect(html).toContain('public-header');
        expect(html).toContain('Setup · Step 2 of 3');
        expect(html).toContain('theme-select');
        expect(html).toContain('setup-steps');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('class="onboarding"');
    });

    it('reads Ready on the closing page, with no stepper', () => {
        const html = frame('ready');
        expect(html).toContain('<span class="public-context">Ready</span>');
        expect(html).not.toContain('setup-steps');
    });
});
