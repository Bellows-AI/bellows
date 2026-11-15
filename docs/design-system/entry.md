# Design system — region: entry

Gate, onboarding, account page. `web/src/styles/regions/entry.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Signed-out gate and the public chrome both public pages carry | `web/src/components/LoginGate.tsx`, `web/src/components/PublicPageHeader.tsx`, `web/src/components/StateNote.tsx` | `e2e/auth.spec.ts`, `web/test/auth.dom.test.tsx`, `web/test/theme.test.tsx`, `web/test/styles.test.ts` |
| Onboarding screen, one org's card, selection state and blockers | `web/src/pages/OnboardingPage.tsx`, `web/src/components/OnboardingOrganization.tsx`, `web/src/onboarding.ts`, `web/src/components/StateNote.tsx` | `web/test/onboarding.render.test.tsx` |
| Setup walk after sign-in: `/onboarding/{model,tools,ready}` outside the shell (`SetupFrame`: public header "Setup · Step N of 3" or "Ready", `.onboarding` column, one `h1`), `SetupStepper` (ordered list, `aria-current="step"`, ✓ done, – skipped, Repositories a reselect anchor), placeholder steps (Back, one primary), and `SetupRedirect` around the shell sending an unfinished member to the first open step | `web/src/components/SetupStepper.tsx`, `web/src/pages/OnboardingModelPage.tsx`, `web/src/pages/OnboardingToolsPage.tsx`, `web/src/pages/OnboardingReadyPage.tsx`, `web/src/onboarding/` | `web/test/onboarding-stepper.render.test.tsx`, `web/test/onboarding-steps.dom.test.tsx`, `e2e/auth.spec.ts` |
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

Classes defined here: `login-gate`, `login-card`, `login-button`, `public-brand`, `public-context`,
`public-header-actions`, `onboarding-purpose`, `onboarding-banner-body`, `onboarding-identity`,
`onboarding-orgs`, `onboarding-org-head`, `onboarding-org-name`, `onboarding-org-mark`,
`onboarding-org-summary`, `onboarding-mode-option`, `onboarding-mode-help`, `onboarding-repos`,
`onboarding-repo-count`, `onboarding-note`, `onboarding-summary-total`, `onboarding-summary-rows`,
`onboarding-actions`, `onboarding-blocker`, `onboarding-loading-line`, `identity-head`,
`identity-name`, `token-create`, `setup-steps`, `setup-step-mark`, `setup-step-done`,
`setup-step-skipped`, `setup-actions`, `setup-back`.
