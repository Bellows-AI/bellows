/**
 * No exported driver span names a repository, a branch, prompt text, a token or an email: a gated, published
 * attempt whose job carries a marker in each of them, scanned over every span's name, attributes, events and
 * status message (docs/observability.md).
 */
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import { captureSpans, runGatedPublish } from './fixtures/lifecycle-spans.js';

const spans = captureSpans();

const REPO = 'o-zq/n-zq';
const BRANCH = 'b-zq';
const PROMPT = 'p-zq';
const TOKEN = 't-zq';
const EMAIL = 'e@zq.example';
const MARKERS = [REPO, BRANCH, PROMPT, TOKEN, EMAIL];

/** Every string a span exports. */
const textOf = (span: ReadableSpan): string[] => [
    span.name,
    span.status.message ?? '',
    ...Object.entries(span.attributes).flatMap(([key, value]) => [key, String(value)]),
    ...span.events.flatMap((event) => [
        event.name,
        ...Object.entries(event.attributes ?? {}).flatMap(([key, value]) => [key, String(value)]),
    ]),
];

describe.each(['docker', 'kubernetes'] as const)('the spans of an attempt under %s', (executor) => {
    it.each([false, true])('carry none of the job’s private values (gate lost: %s)', async (gateLost) => {
        await runGatedPublish(executor, {
            gateLost,
            job: {
                repo: REPO,
                baseBranch: BRANCH,
                command: PROMPT,
                rootCommand: PROMPT,
                env: { GITHUB_TOKEN: TOKEN, GIT_AUTHOR_EMAIL: EMAIL },
            },
            publish: {
                ok: true,
                published: true,
                branch: BRANCH,
                prUrl: `https://github.com/${REPO}/pull/9`,
                reason: null,
                cause: null,
                repository: REPO,
                baseBranch: BRANCH,
                prNumber: 9,
            },
        });

        const exported = spans.getFinishedSpans();
        expect(exported.map((span) => span.name)).toContain('settle');
        for (const text of exported.flatMap(textOf)) {
            for (const marker of MARKERS) expect(text, `${marker} in ${text}`).not.toContain(marker);
        }
    });
});
