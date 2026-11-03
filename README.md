# Quire GitHub Action

Run [Quire](https://quire.sh) in a workflow: verify, triage or re-check your product with an
agent that uses it the way a person would, and fail the job when its checks fail.

Each Run happens on a **Trail**, a named, repeatable check of your product. Runs on the same
Trail remember earlier Runs: they re-check what earlier Runs found and track how answers and
measurements change across commits.

## Usage

```yaml
name: Quire

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  quire:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v6
        with:
          # Quire reads the commits since the Trail's previous Run.
          fetch-depth: 0

      - uses: quireco/quire-action@v1
        with:
          api-token: ${{ secrets.QUIRE_API_TOKEN }}
          trail: checkout
          url: https://preview.example.com
          request: |
            Check that a signed-in test user can add an item to the cart and reach the
            payment step. Use the test account from .quire/runbook.md; do not place an order.
```

Create a personal access token in Quire under **Settings → Security** and save it as the
`QUIRE_API_TOKEN` repository secret. Quire never starts your app: point it at a running target
with `url`, such as a preview deployment, or describe the target in the request.

## Trails and contexts

Pass the same `trail` name everywhere. Quire picks the Trail's context from the GitHub event, so
one name gives you one Trail per context:

| Event                                                                                 | Context         |
| ------------------------------------------------------------------------------------- | --------------- |
| Push, schedule or dispatch on the default branch                                      | `main`          |
| Pull request (also comments on a PR, `workflow_run` and merge queue entries for a PR) | `pr:<number>`   |
| Push to any other branch                                                              | `branch:<name>` |

PR and branch Trails read main's checks and latest answers, but write only their own history,
so a pull request never changes main's Trail. When Quire can't tell the context (for example on
a tag push), the step fails and asks for one; set it with the `context` input.

Checks are added from a Run's request: ask for what you want checked, and that Run adds and
answers it. Later Runs on the Trail re-check it.

## Inputs

| Input                      | Default          | Description                                                                                                                |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `request`                  | required         | What Quire should verify, triage or re-check, in plain language.                                                           |
| `api-token`                | `""`             | Quire personal access token. When empty, as on pull requests from forks, the step is skipped with a notice.                |
| `url`                      | `""`             | Already-running target URL.                                                                                                |
| `trail`                    | `""`             | Trail name or `trl_…` ID. Empty opens a new Trail on every Run.                                                            |
| `context`                  | `""`             | Override the detected context: `main`, `pr:<number>` or `branch:<name>`. Needs a Trail name.                               |
| `supersede`                | `true`           | Replace follow-ups still queued on the Trail, so only the newest commit is checked.                                        |
| `fail-on`                  | `failed,blocked` | Check results that fail the step: `failed`, `blocked`, both, or empty. A Run that does not complete always fails the step. |
| `cli-version`              | `latest`         | Version of `@quireco/cli` to run. Trail contexts need 0.6.0 or later.                                                      |
| `install-browser`          | `true`           | Install the browser Quire uses for web checks.                                                                             |
| `install-terminal-control` | `true`           | Install terminal-control so Quire can drive terminal apps.                                                                 |
| `terminal-control-version` | `1.2.1`          | Version of terminal-control to install.                                                                                    |
| `working-directory`        | `.`              | Repository checkout Quire runs in.                                                                                         |

## Outputs

| Output                        | Description                                                               |
| ----------------------------- | ------------------------------------------------------------------------- |
| `run-id`                      | Quire Run ID.                                                             |
| `trail`                       | Trail name (or ID) to continue with.                                      |
| `trail-url`                   | Link to the Trail in Quire.                                               |
| `web-url`                     | Link to the Run in Quire.                                                 |
| `status`                      | `completed`, `failed`, `canceled`, `stale`, or `skipped` without a token. |
| `passed`, `failed`, `blocked` | Check counts.                                                             |
| `handoff-path`                | Path of the exported handoff Markdown, when the Run completed.            |

The job summary carries the result, links to the Run and Trail, and Quire's full handoff.

## Notes

- **Cancellation.** When the job is cancelled (a newer push, or the Cancel button), the action
  cancels the hosted Run too, so it doesn't block later Runs on the Trail.
- **Requirements.** Node.js 24, which the action installs when the runner has an older version.
  On Linux it installs Chrome's system libraries with the browser. Browser recordings use the
  ffmpeg that comes with the CLI, downloaded from GitHub at install; on a self-hosted runner that
  can't reach GitHub, install ffmpeg on PATH instead.
- **Test data.** Quire changes data only in state set aside for it: a test account, a fixture
  namespace or a throwaway session, named in the request or in `.quire/runbook.md`.
