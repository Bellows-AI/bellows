# Design system — region: composer

The chat footer and the `/tasks/new` page. Styles: `web/src/styles/regions/composer.css`; shared
primitives and the system contracts: [../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Prompt surface, context chips, launch row, skeleton | `web/src/panels/TaskComposer.tsx`, `web/src/pages/TaskComposerPage.tsx` | `web/test/task-composer.render.test.tsx`, `e2e/composer.spec.ts` |
| Validation, blockers, readiness derivation | `web/src/task-composer.ts` | `web/test/task-composer-logic.test.ts` |
| Draft persistence and restore | `web/src/use-composer-draft.ts` | `web/test/composer-draft.test.tsx` |
| The shell's draft store: new-task fields and files, follow-up drafts per thread root, object-URL revocation | `web/src/composer-draft.tsx` | `web/test/composer-draft.test.tsx`, `web/test/composer-draft.dom.test.tsx` |
| Upload client, limits, per-file state, submission key | `web/src/api/useAttachments.ts` | `web/test/task-composer.dom.test.tsx` |
| Attach button, drop and paste | `web/src/panels/AttachmentPicker.tsx` | `web/test/task-composer.dom.test.tsx`, `e2e/composer.spec.ts` |
| One chip per chosen file (state, remove, retry) | `web/src/panels/AttachmentList.tsx` | `web/test/task-composer.dom.test.tsx`, `e2e/composer.spec.ts` |
| The follow-up composer's files and draft | `web/src/panels/TaskDetail.tsx` | `web/test/task-detail-follow-up.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| A workflow's declared parameter fields | `web/src/components/WorkflowParameterFields.tsx` | `web/test/task-composer.render.test.tsx` |
| The no-tracked-repository banner | `web/src/panels/TaskComposer.tsx` | `web/test/task-composer.dom.test.tsx` |

## Invariants

- The request counter's ceiling is core's `COMMAND_LIMIT`, imported, never restated.
- Start's `aria-describedby` names whichever banner or status text is blocking it, so the reason is
  announced rather than inferred from a disabled button.
- A task launches only against a tracked repository; the same rule is refused at `POST /api/jobs`
  (`400 UNKNOWN_REPO`) in `server/src/routes/jobs/job-handlers-worker.ts`,
  `server/test/routes.executor-lifecycle.test.ts`.

Classes defined here: `composer-row`, `composer-input`, `composer-label`, `composer-fields`,
`composer-helper`, `composer-param-input`, `composer-param-error`, `composer-param-details`,
`composer-prompt`, `composer-prompt-head`, `composer-bar`, `composer-start`, `composer-blocker`,
`composer-help`, `composer-help-trigger`, `composer-help-panel`, `composer-counter`, `is-over`,
`composer-context-item`, `composer-context-value`, `composer-trigger-missing`,
`composer-notices-body`, `composer-notices-dismiss`, `composer-skeleton-block`,
`composer-skeleton-line`, `task-compose`, `attachment-add`, `attachment-list`, `attachment-chip`,
`attachment-thumb`, `attachment-body`, `attachment-name`, `attachment-meta`, `attachment-state`,
`attachment-action`.
- Start and Send follow-up stay dark while any file is uploading or failed; a submission carries the
  completed ids and one `Idempotency-Key` kept in the draft store until it succeeds
  (`web/test/task-composer.dom.test.tsx`, `web/test/task-detail-follow-up.dom.test.tsx`).
