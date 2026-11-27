'use strict';

/*
 * The review-reconcile block's reply body for a GitLab job: review-reply.cjs speaks `gh`, so the plan
 * review-reply-probe-middle.cjs builds (REPLY_PLAN, validated against the fresh collection) is POSTed to the board
 * (`POST /api/jobs/:id/agent-review/replies`), which looks every target up before it sends, posts and resolves as the
 * thread's starter and reads back a write whose answer was lost, never re-sending it (docs/workflows.md). The board's
 * `review-reply/v1` verdict is what review-reply-probe-postlude.cjs reads, unmodified.
 *
 * Only ever composed after review-collect-gitlab.cjs, whose transport and settle helpers it uses.
 * `__reviewGitlabReply()` resolves on EVERY path and writes exactly one JSON line to the (captured) stdout: the
 * verdict, or `{ ok: false, schema, version, error }`. Any answer that is not a complete 200 verdict is a refusal; a
 * 409 with `waiting: true` also holds (`__reviewGitlabHeld`). An empty plan writes nothing and posts nothing.
 */

const REVIEW_GITLAB_REPLY_DEADLINE_MS = 150000;
const REVIEW_GITLAB_REPLY_SCHEMA = 'review-reply/v1';

async function __reviewGitlabReply() {
    const plan = __reviewGitlabJson(process.env.REPLY_PLAN || '');
    if (!plan || !Array.isArray(plan.targets)) {
        return __reviewGitlabRefuse(REVIEW_GITLAB_REPLY_SCHEMA, { error: 'the reply plan is not readable' });
    }
    if (plan.targets.length === 0) {
        return __reviewGitlabLine({
            version: 1,
            schema: REVIEW_GITLAB_REPLY_SCHEMA,
            ref: plan.ref,
            results: [],
            error: null,
        });
    }
    const answer = await __reviewGitlabCall(
        'POST',
        '/agent-review/replies',
        JSON.stringify(plan),
        REVIEW_GITLAB_REPLY_DEADLINE_MS
    );
    if (answer.error !== undefined || answer.status !== HTTP_OK)
        return __reviewGitlabRefuse(REVIEW_GITLAB_REPLY_SCHEMA, answer);
    const verdict = __reviewGitlabJson(answer.text);
    if (!verdict || verdict.schema !== REVIEW_GITLAB_REPLY_SCHEMA || !Array.isArray(verdict.results)) {
        return __reviewGitlabRefuse(REVIEW_GITLAB_REPLY_SCHEMA, {
            error: 'the board answered something that is not a reply verdict',
        });
    }
    __reviewGitlabLine(verdict);
}
