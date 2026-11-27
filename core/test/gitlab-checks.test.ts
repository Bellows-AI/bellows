import { describe, expect, it } from 'vitest';
import {
    CHECKS_FAILING,
    CHECKS_PASSING,
    CHECKS_PENDING,
    CHECKS_UNKNOWN,
    gitlabCheckItem,
    gitlabCheckState,
    gitlabMergeable,
    GITLAB_UNFINISHED,
    type ChecksState,
} from '../src/index.js';

describe('gitlabCheckState', () => {
    const rows: Array<[string, ChecksState, ChecksState]> = [
        ['success', CHECKS_PASSING, CHECKS_PASSING],
        ['failed', CHECKS_FAILING, CHECKS_PASSING],
        ['created', CHECKS_PENDING, CHECKS_PENDING],
        ['waiting_for_resource', CHECKS_PENDING, CHECKS_PENDING],
        ['preparing', CHECKS_PENDING, CHECKS_PENDING],
        ['pending', CHECKS_PENDING, CHECKS_PENDING],
        ['running', CHECKS_PENDING, CHECKS_PENDING],
        ['canceling', CHECKS_PENDING, CHECKS_PENDING],
        ['scheduled', CHECKS_PENDING, CHECKS_PENDING],
        ['manual', CHECKS_UNKNOWN, CHECKS_PASSING],
        ['skipped', CHECKS_PASSING, CHECKS_PASSING],
        ['canceled', CHECKS_UNKNOWN, CHECKS_UNKNOWN],
        ['something_new', CHECKS_UNKNOWN, CHECKS_UNKNOWN],
        ['', CHECKS_UNKNOWN, CHECKS_UNKNOWN],
    ];

    it.each(rows)('%s maps to a state and never an unknown value to success or failure', (status, strict, lenient) => {
        expect(gitlabCheckState(status, false)).toBe(strict);
        expect(gitlabCheckState(status, true)).toBe(lenient);
    });

    it('lists every pending status as unfinished', () => {
        for (const [status, strict] of rows) {
            expect(GITLAB_UNFINISHED.includes(status)).toBe(strict === CHECKS_PENDING);
        }
    });
});

describe('gitlabCheckItem', () => {
    it('carries the name, the url and the stage and failure reason of a failing job', () => {
        const item = gitlabCheckItem({
            name: 'test',
            status: 'failed',
            allowFailure: false,
            url: 'https://board.gitlab.test/grp/web/-/jobs/9',
            stage: 'verify',
            failureReason: 'script_failure',
        });
        expect(item).toEqual({
            name: 'test',
            state: CHECKS_FAILING,
            url: 'https://board.gitlab.test/grp/web/-/jobs/9',
            detail: 'stage verify: script_failure',
        });
    });

    it('says a failed job that may fail was allowed to', () => {
        const item = gitlabCheckItem({ name: 'lint', status: 'failed', allowFailure: true, url: null });
        expect(item).toMatchObject({ state: CHECKS_PASSING, detail: 'allowed to fail' });
    });

    it('names the status when nothing else is known', () => {
        expect(gitlabCheckItem({ name: 'x', status: 'running', allowFailure: false, url: null }).detail).toBe(
            'running'
        );
    });
});

describe('gitlabMergeable', () => {
    it.each([
        ['conflict', false],
        ['need_rebase', false],
        ['unchecked', null],
        ['checking', null],
        ['preparing', null],
        ['approvals_syncing', null],
        ['mergeable', true],
        ['ci_must_pass', true],
        ['ci_still_running', true],
        ['not_approved', true],
        ['discussions_not_resolved', true],
        ['draft_status', true],
        ['blocked_status', true],
        ['requested_changes', true],
        ['external_status_checks', true],
        ['jira_association_missing', true],
        ['merge_time', true],
        ['locked_paths', true],
        ['locked_lfs_files', true],
        ['security_policy_violations', true],
        ['title_regex', true],
        ['commits_status', true],
        ['merge_request_blocked', true],
        ['not_open', null],
        ['broken_status', null],
        ['a_status_from_the_future', null],
    ])('%s is %s', (status, expected) => {
        expect(gitlabMergeable(status, false)).toBe(expected);
    });

    it('reads a conflict flag as conflicting whatever the status', () => {
        expect(gitlabMergeable('mergeable', true)).toBe(false);
        expect(gitlabMergeable('checking', true)).toBe(false);
    });
});
