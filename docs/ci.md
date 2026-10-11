# CI

Two workflows and no configured secret — the only credential either uses is `github.token`, and
`core/test/ci-workflows.test.ts` pins every claim below.

| Concern | Code | Test |
| --- | --- | --- |
| Validation and the browser lane | `.github/workflows/ci.yml` | `core/test/ci-workflows.test.ts` |
| Tag fold, image matrix, scan gate, manifest, chart publish | `.github/workflows/release-image.yml`, `.trivyignore` | `core/test/ci-workflows.test.ts` |
| Release command: patch bump, version-only commit, tag, atomic push | `scripts/release.sh`, `VERSION` | `core/test/release-script.test.ts` |
| The images a release builds | `docker/Dockerfile`, `docker/driver.Dockerfile`, `docker/{claude,opencode}-executor/` | `driver/test/executor-images.test.ts` |
| Browser-lane databases and ports | `e2e/reset-db.mjs`, `playwright.config.ts` | `core/test/e2e-config.test.ts` |

## Invariants

- **`npm run build` precedes `npm test`**, so a broken `core/dist` reports as a build failure; `npm run typecheck`
  follows, covering `server/tsconfig.test.json` and `e2e/tsconfig.json`.
- **The `e2e` job runs only on a push to `main`**, with a `postgres:17` service, `factory_e2e` and
  `factory_auth_e2e` created by hand (`e2e/reset-db.mjs` truncates but never creates), and chromium.
- **A push to `main` that changes only `VERSION` skips CI; its tag still validates** through the `workflow_call`
  `release-image.yml` makes. No release commit carries `[skip ci]`.
- **Node is `24`, matching `docker/Dockerfile`'s runtime base**; there is no `.nvmrc`, so the test is the only pin.
- **Every base image and the e2e `postgres` service pull from `public.ecr.aws/docker/library/`** (Docker Hub
  rate-limits shared runner IPs).
- **Every `uses:` on a job holding `packages: write` is GitHub-owned**, pinned by major tag; Trivy runs as a pinned
  container and helm from a checksum-verified tarball.
- **Each build job builds to a tarball, scans it, and only then runs `docker login`.** Two Trivy passes: SARIF
  upload (`--exit-code 0`) and the gate (`--exit-code 1`, `CRITICAL,HIGH`), narrowed only by `--ignore-unfixed`
  and `--skip-files /usr/local/bin/acli`.
- **All four images the chart renders are built, each architecture natively**, pushed as `<image>:<tag>-<arch>` and
  merged by `manifest`; `--provenance=false` keeps the merge from nesting manifest lists. The collector image is
  mirrored too, its version read from `charts/factory/values.yaml`.
- **The chart publishes after `manifest`, never beside it.** `--version` is the tag minus its `v`; `--app-version`
  is the tag exactly, which `factory.image` falls back to. Each package's first push is private
  ([eks-runbook.md](eks-runbook.md), step 3).

## Stated limits

- `driver/test/executor-images.test.ts` and `driver/test/review-reply-script.test.ts` spawn real processes and can
  time out on a contended runner; re-run the job.
- CI never runs `npm run test:db`, `npm run test:jobs` or `npm run test:k8s`, and no lane runs a real cloud cluster
  ([eks-runbook.md](eks-runbook.md)).
