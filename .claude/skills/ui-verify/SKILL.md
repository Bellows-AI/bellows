---
name: ui-verify
description: Verify the Factory dashboard in a real browser with Playwright. Use after any change to web/src, to the /api/stats payload shape, or to core aggregation that panels render — and whenever a change "typechecks and the tests pass" but has never been looked at. Catches blank panels, NaN leaking from a null metric, console errors, and charts that render absurdly at small data volumes. Trigger phrases: "verify the UI", "check it in a browser", "does the dashboard still render", "/ui-verify".
---

# Verify the dashboard in a browser

## Run it

```bash
npm run verify:ui                       # all specs, chromium, headless
npx playwright test -g 'every preset'   # one spec by name
npx playwright test --headed            # watch it drive
npx playwright test --ui                # pick and step through interactively
```

`playwright.config.ts` builds all five packages and serves the built SPA from two boards: the
open board on 127.0.0.1:8123 against `factory_e2e` (project `chromium`) and an auth board on +1
against `factory_auth_e2e` with a stub IdP on +2 (project `auth`, for the signed-in specs). Both
databases must exist; the run needs a running postgres but no token, no quota and no network.
`E2E_PORT_BASE` and `E2E_DB_PREFIX` move the ports and databases. The server is never reused
between runs.

Full-page screenshots land in `artifacts/ui/*.png` (gitignored). **Read them** — a passing
assertion means the DOM was right; only the screenshot shows the layout was. Traces for failures
are written next to them and open with
`npx playwright show-trace artifacts/ui/trace/<name>/trace.zip`.

## What the specs assert

`e2e/*.spec.ts` is the source of truth; in outline:

- `dashboard.spec.ts`: every range preset re-renders the analytics dashboard cleanly (no
  `NaN`, `undefined`, `Infinity` or `[object Object]` in `main`), the toolbar and chart layout, a
  failed refresh keeping the last good data, and token accounting (a bucket with no measured
  tokens reads as dashes, never zeros).
- `journeys.spec.ts`, `task-detail.spec.ts`, `task-question.spec.ts`, `task-connect*.spec.ts`,
  `composer.spec.ts`: task threads, actions, agent questions, the Connect block and the composer.
- `batches*.spec.ts`, `workspace.spec.ts`, `skills.spec.ts`, `env.spec.ts`, `integrations.spec.ts`,
  `jira-connections.spec.ts`, `org-executors.spec.ts`, `notification-subscriptions.spec.ts`,
  `attachment-*.spec.ts`: the settings and organization surfaces.
- `auth.spec.ts`, `follow-up-auth.spec.ts`, `oauth-consent.spec.ts`, `mcp-connect.spec.ts`: the
  signed-in flows on the auth board.
- `matrix.spec.ts`, `state-matrix.spec.ts`, `org-states.spec.ts`, `navigation.spec.ts`,
  `polish.spec.ts`, `baseline.spec.ts`: responsive, accessibility and state matrices across themes
  and widths. `specimen.spec.ts` and the `@nightly` specs run only under `npm run verify:ui:nightly`.
- Throughout: no console errors, page errors or failed requests (`e2e/page-health.ts`).

## Reviewer checklist (v3)

A UI change passes only when each holds; the matrix is `e2e/state-matrix.spec.ts` and `e2e/org-states.spec.ts` (DOM assertions, no screenshots).

- Surface tier is deliberate: flat (`panel-flat`), soft (resting `panel`) or raised (dialogs, popovers, composer).
- One primary call to action per view; the rest are `tertiary` or `icon-button`.
- Mono (`.mono`) only for identifiers: SHAs, ids, tokens, branch names.
- Icons come from the frozen `ICON_NAMES` set at the sized contract (nav 20, inline 16, banner 24).
- Loading and error use `StateNote` (`status` / `alert`); an error or a held read never renders as empty.
- Compact targets reach the 44px floor on narrow shells.
- Both themes checked, light and dark.
- Nothing renders data or actions the API lacks; the reference image is illustrative only.

## Extending it

Specs live in `e2e/`. `vitest.config.ts` lists its includes explicitly, so nothing in `e2e/`
leaks into `npm test` — keep it that way; the default suite must stay offline and browser-free.

One thing to know before adding assertions:

- **A preset that resolves to the query already on screen does not refetch.** `useStats` keys on
  the query string, so clicking the active preset — or "Custom" before a date is entered — fires
  no request. Waiting on a response there hangs until the timeout.

Prefer asserting on what a reader would notice (a number changed, a caveat is present, a panel is
not empty) over asserting on markup. When a defect is found: reproduce it with a failing
assertion here first, then fix it.
