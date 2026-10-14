import { describe, expect, it } from 'vitest';
import { STILL_ACTIVE_AFTER_MS, formatAge, timeoutNote } from '../src/timeout-note.js';
import type { GateRunNote, TimeoutActivity } from '../src/timeout-note.js';

/**
 * The kill note a timed-out run leaves in the output tail. It must let a reader tell — without
 * raw SQL against three sources (issue #339) — a run that hung from one that was still working
 * when the wall clock ran out: the age of the last output, the ad-hoc gates' latest verdicts,
 * and the agent's last activity line.
 */

describe('formatAge', () => {
    it.each([
        ['seconds under a minute', 34_500, '34s'],
        ['seconds under a minute', 2_000, '2s'],
        ['whole minutes under an hour', 34 * 60_000 + 12_000, '34m'],
        ['hours with zero-padded minutes', 7_410_000, '2h03m'],
    ])('reports %s (%i -> %s)', (_label, ms, expected) => {
        expect(formatAge(ms)).toBe(expected);
    });
});

describe('timeoutNote', () => {
    const TWO_HOURS = 7_200_000;
    const NOW = Date.parse('2026-09-22T22:46:16.000Z');
    const RECENT = Date.parse('2026-09-22T22:46:14.000Z');

    it.each<[string, TimeoutActivity, GateRunNote[], string]>([
        [
            'says the run was still active, with the last gate verdicts and activity line',
            { lastOutputAt: RECENT, activity: 'Now the two wording fixes:' },
            [
                { name: 'test', exitCode: 0, at: '2026-09-22T22:45:02.000Z' },
                { name: 'lint', exitCode: 0, at: '2026-09-22T22:44:10.000Z' },
            ],
            '[driver] killed after 7200000ms — still active: last output 2s ago, ' +
                'gates test+lint passed at 22:45:02, last activity "Now the two wording fixes:"',
        ],
        [
            'says the run was idle when the last output is older than the threshold',
            { lastOutputAt: Date.parse('2026-09-22T22:12:16.000Z'), activity: '…' },
            [],
            '[driver] killed after 7200000ms — idle: no output for 34m, last activity "…"',
        ],
        [
            'says no output ever arrived when there was none',
            { lastOutputAt: null, activity: null },
            [],
            '[driver] killed after 7200000ms — idle: no output',
        ],
        [
            'names each gate individually when the latest verdicts are mixed',
            { lastOutputAt: RECENT, activity: null },
            [
                { name: 'test', exitCode: 3, at: '2026-09-22T22:45:02.000Z' },
                { name: 'lint', exitCode: 0, at: '2026-09-22T22:44:10.000Z' },
            ],
            '[driver] killed after 7200000ms — still active: last output 2s ago, ' +
                'gates test failed (exit 3), lint passed at 22:44:10',
        ],
        [
            'omits the gate clause when the ad-hoc gates never ran, and the activity clause when there is none',
            { lastOutputAt: RECENT, activity: null },
            [],
            '[driver] killed after 7200000ms — still active: last output 2s ago',
        ],
        [
            'keeps only the latest run per gate, and stamps the clause with the newest of those',
            { lastOutputAt: RECENT, activity: null },
            [
                { name: 'test', exitCode: 0, at: '2026-09-22T22:30:00.000Z' },
                { name: 'test', exitCode: 0, at: '2026-09-22T22:40:00.000Z' },
                { name: 'lint', exitCode: 0, at: '2026-09-22T22:35:00.000Z' },
            ],
            '[driver] killed after 7200000ms — still active: last output 2s ago, gates test+lint passed at 22:40:00',
        ],
    ])('%s', (_label, activity, gateRuns, expected) => {
        expect(timeoutNote(TWO_HOURS, activity, gateRuns, NOW)).toBe(expected);
    });

    it('treats an age of exactly the threshold as idle, and one millisecond less as active', () => {
        const now = NOW;
        const atThreshold: TimeoutActivity = { lastOutputAt: now - STILL_ACTIVE_AFTER_MS, activity: null };
        const justUnder: TimeoutActivity = { lastOutputAt: now - STILL_ACTIVE_AFTER_MS + 1, activity: null };
        expect(timeoutNote(TWO_HOURS, atThreshold, [], now)).toContain(' — idle: ');
        expect(timeoutNote(TWO_HOURS, justUnder, [], now)).toContain(' — still active: ');
    });
});
