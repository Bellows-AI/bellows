# Design system — region: composer

The chat footer and the `/tasks/new` page. Styles: `web/src/styles/regions/composer.css`; shared
primitives and the system contracts: [../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| The new-task page: the chat input with the context chips in its control row (no title field; the title derives from it), a note atop each listbox, counter only near the limit, skeleton; the whole page is the drop zone | `web/src/panels/TaskComposer.tsx`, `web/src/pages/TaskComposerPage.tsx` | `web/test/task-composer.render.test.tsx`, `web/test/styles.test.ts`, `e2e/composer.spec.ts` |
| Validation, blockers, readiness derivation | `web/src/task-composer.ts` | `web/test/task-composer-logic.test.ts` |
| Draft persistence and restore | `web/src/use-composer-draft.ts` | `web/test/composer-draft.test.tsx` |
| The shell's draft store: new-task fields and files, follow-up drafts per thread root, object-URL revocation | `web/src/composer-draft.tsx` | `web/test/composer-draft.test.tsx`, `web/test/composer-draft.dom.test.tsx` |
| Upload client, limits, per-file state, submission key | `web/src/api/useAttachments.ts` | `web/test/task-composer.dom.test.tsx` |
| The chat input, shared by the new-task page and the follow-up: files above, a one-line bordered field that grows, a row with the paperclip, caller controls and the round send arrow | `web/src/panels/ChatInput.tsx` | `web/test/task-composer.render.test.tsx`, `web/test/task-run.render.test.tsx`, `web/test/styles.test.ts` |
| Attach button (paperclip icon) and paste | `web/src/panels/AttachmentPicker.tsx` | `web/test/task-composer.dom.test.tsx`, `e2e/composer.spec.ts` |
| The drop zone: a region taking dropped files, with the "Drop files to attach" overlay | `web/src/panels/AttachmentDropZone.tsx` | `web/test/attachment-drop-zone.dom.test.tsx`, `e2e/composer.spec.ts`, `e2e/task-detail.spec.ts` |
| One wrapping tile per file: in a draft a square (spinner while uploading, then the preview; a failure is a ⚠ that retries; name in the tooltip; remove), in history a tile with name, size and download | `web/src/panels/AttachmentList.tsx` | `web/test/task-composer.dom.test.tsx`, `e2e/composer.spec.ts` |
| The follow-up composer's files and draft | `web/src/panels/TaskDetail.tsx` | `web/test/task-detail-follow-up.dom.test.tsx`, `e2e/task-detail.spec.ts` |
| The base-branch chip: a pick-only combobox, debounced server-side search, "Load more" by cursor, an error row (never "no branches") | `web/src/components/BranchCombobox.tsx`, `web/src/api/useBranches.ts` | `web/test/branch-combobox.dom.test.tsx`, `e2e/composer.spec.ts` |
| The prompt's `/` skill menu: built-ins and the repository's at the chosen branch; the picked `/name` stays in the text | `web/src/components/SlashSkillMenu.tsx`, `web/src/slash-skills.ts`, `web/src/api/useRepoSkills.ts` | `web/test/slash-skills.test.ts`, `web/test/task-composer.dom.test.tsx`, `e2e/composer.spec.ts` |
| A workflow's declared parameter fields | `web/src/components/WorkflowParameterFields.tsx` | `web/test/task-composer.render.test.tsx` |
| The no-tracked-repository banner | `web/src/panels/TaskComposer.tsx` | `web/test/task-composer.dom.test.tsx` |

## Invariants

- The request counter's ceiling is core's `COMMAND_LIMIT`, imported, never restated.
- Start's `aria-describedby` names whichever banner or status text is blocking it, so the reason is
  announced rather than inferred from a disabled button.
- A task launches only against a tracked repository; the same rule is refused at `POST /api/jobs`
  (`400 UNKNOWN_REPO`) in `server/src/routes/jobs/job-handlers-worker.ts`,
  `server/test/routes.executor-lifecycle.test.ts`.

`.chat-input` is the one chat input, reused by both composers, never restyled per composer. It has no surface of its own: the field (`.chat-input-field`) carries the only frame, `1px solid var(--line)`, and focus brightens that border to `--line-strong` instead of drawing a ring. The field starts one line high and grows with its text (`field-sizing: content`) up to half the viewport. The paperclip and the 24px round send arrow (44px on the compact shell) sit inside the field's frame on its last line (`.chat-input-box`); the row below holds only caller controls and the status. No shortcut hint is drawn; Ctrl/⌘+Enter still sends. The page's heading stays; the empty-prompt state is silent (Start is simply disabled).

Classes defined here: `chat-input`, `chat-input-field`, `chat-input-box`, `chat-input-bar`, `chat-input-controls`,
`chat-input-end`, `chat-input-send`, `composer-label`, `composer-fields`,
`composer-helper`, `composer-param-input`, `composer-param-error`, `composer-param-details`,
`composer-heading`, `composer-visually-hidden`, `composer-blocker`, `composer-note`, `composer-counter`, `is-over`,
`composer-context-item`, `composer-context-value`, `composer-branch`, `composer-branch-toggle`,
`composer-branch-input`, `composer-branch-options`, `composer-branch-action`, `composer-branch-error`,
`composer-skill-menu`, `composer-skill-option`, `composer-skill-name`, `composer-skill-description`,
`composer-skill-source`, `composer-trigger-missing`,
`composer-notices-body`, `composer-notices-dismiss`, `composer-skeleton-block`,
`composer-skeleton-line`, `task-compose`, `task-compose-body`, `attachment-add`, `attachment-list`, `attachment-chip`,
`attachment-tile`, `attachment-spinner`,
`attachment-media`, `attachment-thumb`, `attachment-body`, `attachment-name`, `attachment-meta`, `attachment-state`,
`attachment-action`, `attachment-retry`, `attachment-remove`, `attachment-download`,
`attachment-list-history`, `drop-zone`, `is-dragging`, `drop-overlay`.
- Start and Send follow-up stay dark while any file is uploading or failed; a submission carries the
  completed ids and one `Idempotency-Key` kept in the draft store until it succeeds
  (`web/test/task-composer.dom.test.tsx`, `web/test/task-detail-follow-up.dom.test.tsx`).
