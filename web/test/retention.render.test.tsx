import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deletionDay } from '../src/api/retention.js';
import { threadSettledAt } from '../src/components/TaskDeletionNote.js';
import { RetentionText } from '../src/panels/RetentionSection.js';
import { job } from './tasks-fixtures.js';

/** The retention window as Settings → Organization shows it, and the day a finished task is deleted (docs/retention.md). */
describe('the retention window', () => {
    it('names the window, and a shorter one with the day it applies', () => {
        const html = renderToStaticMarkup(
            <RetentionText retention={{ days: 180, pending: { days: 7, effectiveAt: '2026-12-14T10:00:00.000Z' } }} />
        );
        expect(html).toContain('deleted 180 days after its last run ends');
        expect(html).toContain('From 2026-12-14, finished tasks are kept for 7 days.');
    });

    it('says an unlimited window keeps tasks until the organization is deleted', () => {
        const html = renderToStaticMarkup(<RetentionText retention={{ days: null, pending: null }} />);
        expect(html).toContain('kept until the organization is deleted');
        expect(html).not.toContain('From ');
    });
});

describe('the deletion day of a task', () => {
    it('counts from the newest finish once every run has ended', () => {
        const jobs = [
            job({ status: 'succeeded', finishedAt: '2026-11-01T10:00:00.000Z' }),
            job({ status: 'failed', finishedAt: '2026-11-03T10:00:00.000Z' }),
        ];
        const settled = threadSettledAt(jobs);
        expect(settled).toBe('2026-11-03T10:00:00.000Z');
        expect(deletionDay(settled, 7)?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    });

    it('has none while a run is going, or under an unlimited window', () => {
        expect(threadSettledAt([job({ status: 'running', finishedAt: null })])).toBeNull();
        expect(deletionDay('2026-11-03T10:00:00.000Z', null)).toBeNull();
    });
});
