# Bellows user docs

The public user documentation, built with [Mintlify](https://mintlify.com). `docs/` at the repo root
is the maintainer index; this folder is for people who use Bellows.

## Preview locally

```bash
cd site
npx mint@latest dev              # http://localhost:3000
npx mint@latest validate         # docs.json + MDX build check
npx mint@latest broken-links
```

## Layout

| Path                 | What                                                  |
| -------------------- | ----------------------------------------------------- |
| `docs.json`          | Site config: theme, colors, logo, navigation          |
| `overview/`          | Introduction, Quickstart, Core concepts               |
| `guides/`            | Task-focused guides                                   |
| `images/`            | Screenshots, by section                               |
| `logo/`, `favicon.svg` | Brand assets (same mark as bellows.cloud)           |
| `style.css`          | Status tags in the app's status colors                |

A new page is an `.mdx` file plus an entry in `docs.json` → `navigation`.

## Screenshots

Light theme, captured from the app. These files are placeholders until replaced at the same path and size:

| File                                   | Size       | Shows                                                         |
| -------------------------------------- | ---------- | ------------------------------------------------------------- |
| `images/quickstart/01-onboarding.png`    | 1280 × 800 | Choose organizations and repositories, one org selected       |
| `images/quickstart/02-settings-repos.png`| 1280 × 380 | Settings → Repositories with the example repo listed          |
| `images/quickstart/03-new-task.png`      | 1440 × 470 | New task with the example prompt, repo and executor picked    |
| `images/quickstart/04-question.png`      | 660 × 360  | An agent question waiting for an answer, cropped to the card  |
| `images/quickstart/05-task-review.png`   | 1280 × 920 | Task page waiting for review, with the published PR           |
| `images/guides/06-inbox.png`             | 1440 × 640 | Needs attention with 3–5 tasks in mixed states                |

This repo is public: screenshots and examples must not show a real organization, repository,
person or task id.
