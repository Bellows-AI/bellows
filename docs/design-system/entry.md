# Design system — region: entry

Gate, onboarding, account page. `web/src/styles/regions/entry.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Signed-out gate and the public chrome both public pages carry | `web/src/components/LoginGate.tsx`, `web/src/components/PublicPageHeader.tsx`, `web/src/components/StateNote.tsx` | `e2e/auth.spec.ts`, `web/test/auth.dom.test.tsx`, `web/test/theme.test.tsx`, `web/test/styles.test.ts` |
| Onboarding screen, one org's card, selection state and blockers | `web/src/pages/OnboardingPage.tsx`, `web/src/components/OnboardingOrganization.tsx`, `web/src/onboarding.ts`, `web/src/components/StateNote.tsx` | `web/test/onboarding.render.test.tsx` |
| Setup walk after sign-in: `/onboarding/{model,tools,ready}` outside the shell (`SetupFrame`: public header "Setup · Step N of 3" or "Ready", `.onboarding` column, one `h1`), `SetupStepper` (ordered list, `aria-current="step"`, ✓ done, – skipped, Repositories a reselect anchor), steps (Back, one primary; Tools: tracker cards, Skip for now → Continue), and `SetupRedirect` around the shell sending an unfinished member to the first open step | `web/src/components/SetupStepper.tsx`, `web/src/pages/OnboardingModelPage.tsx`, `web/src/pages/OnboardingToolsPage.tsx`, `web/src/pages/OnboardingReadyPage.tsx`, `web/src/onboarding/` | `web/test/onboarding-stepper.render.test.tsx`, `web/test/onboarding-steps.dom.test.tsx`, `web/test/onboarding-tools.dom.test.tsx`, `e2e/auth.spec.ts` |
| Ready (`ReadyStep`, `ReadySummary`: `ready-summary` rows with a `ready-lamp` and Change — Repositories through `reselectHref`; `onboarding-wide` column; the inline `TaskComposer` (`inline`: no page height) unstyled in its own `ComposerDraftProvider`, `ready-starters` under the prompt; `showNoModel` (cloud: no key; self-hosted: no key, profile or agent default) → `banner-warn`, Start `aria-disabled`) | `web/src/onboarding/ReadyStep.tsx`, `web/src/onboarding/ReadySummary.tsx`, `web/src/pages/OnboardingReadyPage.tsx` | `web/test/onboarding-ready.dom.test.tsx`, `web/test/no-model.test.ts`, `e2e/onboarding.spec.ts` |
| Model step and Settings → Model (`ModelSetup`, one component: provider radiogroup of soft cards with marks, key with a live `role=status` check line, agent + model, scope, platform or org banner, Save `aria-disabled` with its reason under it) | `web/src/model-setup/`, `web/src/pages/SettingsModelPage.tsx`, `web/src/api/useModelSetup.ts` | `web/test/model-setup.dom.test.tsx`, `web/test/model-setup-saved.dom.test.tsx`, `web/test/model-setup-keys.test.ts`, `web/test/model-setup-bodies.test.ts` |
| Account page: identity head (avatar, name, `identity-login`) over one sans `.kv` list with only the GitHub id `.mono`; `.kv dd` is sans, true identifiers opt in with `.mono`; revoking a personal token asks via `ConfirmDialog` naming it, focus returns on every exit | `web/src/pages/AccountPage.tsx`, `web/src/panels/IdentityPanel.tsx`, `web/src/panels/AccessTokensPanel.tsx`, `web/src/panels/TrackedOrgsPanel.tsx` | `web/test/settings.render.test.tsx`, `web/test/access-tokens.dom.test.tsx`, `web/test/styles.test.ts` |
| MCP consent screen (`.onboarding` column outside the shell; Allow and Deny share one class and size, neither `primary`; the client's host or unverified name, the scopes and the redirect host are `.kv` rows; a missing, spent or unreadable request is a `StateNote` alert) | `web/src/pages/OAuthConsentPage.tsx`, `web/src/api/useOAuthConsent.ts`, `web/src/oauth-client.ts` | `web/test/OAuthConsent.dom.test.tsx`, `e2e/oauth-consent.spec.ts` |
| Attachment upload page (`/attachments/upload#fcu_…`, signed-out: `LoginGate` steps past it; the `.onboarding` column outside the shell, the link read from the fragment once and dropped from the address bar, `AttachmentDropZone` as the dashed `upload-zone` plus a file picker, a `<progress>` bar, one `StateNote` alert per refusal code; a network failure offers Try again, never success) | `web/src/pages/AttachmentUploadPage.tsx`, `web/src/api/uploadByCapability.ts`, `web/src/components/LoginGate.tsx` | `web/test/AttachmentUploadPage.dom.test.tsx`, `e2e/attachment-upload.spec.ts` |
| Connected apps on the Account page (shown when `/api/auth/me` reports `mcp`; `table-cards`, Disconnect asks first, a failed read is a `StateNote` alert, never the empty line) | `web/src/panels/ConnectedAppsPanel.tsx`, `web/src/api/useOAuthGrants.ts` | `web/test/ConnectedAppsPanel.dom.test.tsx`, `e2e/oauth-consent.spec.ts` |

## Invariants

- A public page owns its one `h1`; `PublicPageHeader` carries no heading, navigation or session.
- `login-button` is an anchor skinned as a primary button: the CSP forbids a form, and a fetch
  cannot follow the OAuth 302.
- Continue is `aria-disabled`, never `disabled`, so its reason stays focusable and `aria-describedby`-wired.
- Only an explicit `setup.completed === false` in the GitHub mode redirects into the setup walk; a step
  navigates only after its write and the `/api/auth/me` re-read both land.
- Ready's draft is kept in `sessionStorage` per member (`web/src/onboarding/ready-draft.ts`; files are not), so a
  Change or the reselect round trip keeps it; a created task drops it. A summary row whose read did not answer —
  an empty repository listing with GitHub's error included — says so with Retry, never a verdict.
- Ready's Start creates the task under an Idempotency-Key, then completes setup and re-reads `/api/auth/me`
  before opening the task; a task whose `complete` failed is finished on the next Ready load, never created again.
- The model step never shows the empty form over a failed setup read, never shows a key check's answer for
  any key but the one it was asked for, and keeps its action row mounted through every state.

Classes defined here: `login-gate`, `login-card`, `login-button`, `public-brand`, `public-context`,
`public-header-actions`, `onboarding-purpose`, `onboarding-banner-body`, `onboarding-identity`,
`onboarding-orgs`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`,
`onboarding-org-summary`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`,
`onboarding-repo-count`, `onboarding-note`, `onboarding-summary-total`, `onboarding-summary-rows`,
`onboarding-actions`, `onboarding-blocker`, `onboarding-loading-line`, `identity-head`,
`identity-name`, `setup-steps`, `setup-step-mark`, `setup-step-done`,
`setup-step-skipped`, `setup-actions`, `setup-back`, `setup-tools`, `setup-tool`, `setup-tool-body`,
`setup-tool-name`, `setup-tool-purpose`, `setup-tool-connection`, `setup-tool-state`, `setup-tools-more`,
`setup-tools-retry`, `model-label`, `model-providers`, `model-provider`, `model-provider-head`,
`model-provider-tag`, `model-provider-sub`, `model-secret-note`, `model-save-why`, `model-key`, `model-check`,
`model-fields`, `model-scope`, `model-advanced`, `model-banner-body`, `model-primary`, `ready-summary`, `ready-row`,
`ready-lamp`, `ready-row-body`, `ready-row-name`, `ready-row-detail`, `ready-starters`, `onboarding-wide`.
