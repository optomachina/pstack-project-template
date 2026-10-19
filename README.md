# pstack template

A project-agnostic copy of OverDrafter's pstack engineering setup: an agent contract, one shared sensitive-path list, risk-sized review (Jev, then Sonnet, then Opus), a journey-test rule, a shared preflight, a 2-round repair budget, and the CI gates that enforce them. Everything is plain Node (no runtime dependencies). `picomatch` is a dev dependency, used only as the reference implementation in tests.

## What you get

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Agent contract: standing authorization, protected actions, auto-merge categories, sensitive-path list (between markers), ownership, small PRs, preflight and repair budget, risk-sized review, journey tests, completion and failure |
| `CLAUDE.md` | Thin pointer to `AGENTS.md` |
| `pstack.config.json` | Project-owned settings: name and owner, preflight stages, PR size, journey-test globs, auto-merge categories, Jev confidence floor |
| `docs/sensitive-paths.json` | The single sensitive-path list (classes and picomatch-style globs) |
| `scripts/lib/sensitive-paths.mjs` | Dependency-free matcher (picomatch `{dot, nocase}` semantics), base-ref loading, gate-loosening detection, AGENTS.md parity and rendering, CLI |
| `scripts/lib/pstack-config.mjs` | `pstack.config.json` loader and validator |
| `scripts/sensitive-paths-report.mjs` | PR report (`HEAD^1..HEAD`, report only) |
| `scripts/validate-agent-contract.mjs` | Fails when AGENTS.md drifts from the JSON (both directions) or loses a required rule |
| `scripts/review-gate.mjs` | Review tier (`jev`, `sonnet`, `opus`) and auto-merge eligibility from the changed files |
| `scripts/jev-client.mjs` | Optional Jev client; inert unless `JEV_ENDPOINT` is set (no credentials in the repo) |
| `scripts/check-journey-tests.mjs` | Fails user-visible changes without a journey test change, unless the body says `Journey test: N/A - <reason>` |
| `scripts/check-pr-body.mjs` | PR body gate: preflight lines, journey test, review tier, sensitive classes |
| `scripts/preflight.sh` | typecheck, lint, test, build: each when `package.json` defines it, with a `preflight: <stage> PASS/FAIL/SKIP` line per stage |
| `scripts/sync-template.mjs` | Install or update the template in a project |
| `templates/.github/workflows/ci.yml` | `preflight`, `agent-contract`, `pr-gates` (sensitive report, review gate, journey check, all from the base copy), aggregate `ci` |
| `templates/.github/workflows/pr-body-gate.yml` | `pr-body` check (runs on body edits without rerunning CI) |
| `scripts/fixtures/pstack-config/template.json` | The template's `pstack.config.json`, which the gate tests use so a project's own globs cannot break them |
| `.github/pull_request_template.md` | Preflight lines, journey test, review tier, sensitive classes, risk and rollback |
| `docs/runbooks/` | `pr-lifecycle`, `review-gates`, `repair-budget`, `merge-and-rollback`, `branch-protection`, `task-contract` |
| `docs/agent-graph.md` | Where the agent graph is defined, plus metrics |

## Install into a project

```bash
git clone <this repo> pstack-template && cd pstack-template && npm install
node scripts/sync-template.mjs ../my-app --dry-run                                     # preview
node scripts/sync-template.mjs ../my-app --project "My App" --owner "Dana" --add-scripts
cd ../my-app
npm install -D picomatch             # optional: enables the matcher-vs-picomatch tests
npm run agent-contract && npm run preflight && npm run pstack:test
```

Then, in the project:

1. Edit `pstack.config.json`: set `journeyTests.userVisible` to your UI paths and `journeyTests.journeyTests` to where journey specs live. Check `autoMerge.categories` and `preflight.stages`.
2. Add project globs to `docs/sensitive-paths.json` (adding is free), then run `npm run sensitive-paths:render`.
3. Fill the `project:begin` / `project:end` blocks in `AGENTS.md`, `CLAUDE.md`, the runbooks and `ci.yml` (project CI setup and extra jobs).
4. Ask the owner to apply [branch protection](docs/runbooks/branch-protection.md) (a protected action): required checks `ci` and `pr-body`, and "Require review from Code Owners" (without it a PR can edit the workflows that gate it).
5. Optional: set the `JEV_ENDPOINT` / `JEV_API_KEY` repository secrets to enable the Jev screen.

## Updating a project

Re-run `node scripts/sync-template.mjs <project>`. It:

- overwrites managed files but keeps everything between `<!-- project:begin [id] -->` and `<!-- project:end [id] -->` lines (matched by id, or by position for unnamed blocks). It keeps blocks the template dropped, appended at the end, with a warning. Markers work inside any comment syntax (`# <!-- project:begin x -->` in YAML);
- never overwrites `pstack.config.json`;
- adds new template sensitive globs and classes to the project's list, and never removes or reclassifies the project's own;
- fills `{{PROJECT}}`, `{{OWNER}}` and `{{DEFAULT_BRANCH}}` in Markdown, workflow and CODEOWNERS files from `pstack.config.json` (`project.defaultBranch`, default `main`: the CI push trigger, the runbooks' `origin/<branch>` and `gh api .../branches/<branch>/protection` commands), and `{{OWNER_HANDLE}}` (the gate's code owner in `.github/CODEOWNERS`) from `project.ownerHandle`, defaulting to `@optomachina`;
- regenerates the AGENTS.md sensitive block from the project's list;
- writes `.pstack-template-version` (template name, version, commit, sync time, file hashes).

Edits to managed files outside project blocks are template-owned and get reset. Change them in the template instead.

## Commands

```bash
npm test                                   # node:test suites (scripts/*-test.mjs, scripts/lib/*-test.mjs)
npm run preflight                          # bash scripts/preflight.sh [stage ...]
npm run agent-contract                     # AGENTS.md vs docs/sensitive-paths.json, required rules
npm run sensitive-paths:report             # report for HEAD^1..HEAD (or --base-ref <ref>)
npm run sensitive-paths:render             # regenerate the AGENTS.md block (add -- --check to verify)
node scripts/lib/sensitive-paths.mjs classify [--base-ref <ref>] [--json] <path>...
npm run review-gate -- [--base-ref <ref>] [--changed-files-from <name-status>] [--numstat-from <numstat>] [--no-jev] [--json-out f] [path...]
npm run journey-tests:check -- --changed-files-from <name-status> [--body-file <md>] [--base-ref <ref>]
node scripts/check-pr-body.mjs --body-file <md> [--review-gate-json <review-gate.json>]
node scripts/sync-template.mjs <target-dir> [--dry-run] [--project <name>] [--owner <name>] [--add-scripts]
npm run render-self                        # template repo only: re-render .github/workflows/ from templates/ (-- --check to verify)
```

Test files are named `*.node-test.mjs` so that projects using Vitest or Jest do not collect them. Run them with `node --test`.

## Design notes

- **Workflow sources.** GitHub cannot read the push branch from an expression, so the workflows are kept with placeholders under `templates/.github/workflows/` and sync fills them per project. The template's own `.github/workflows/` are rendered copies (from its `pstack.config.json`, `main`), so this repository runs the same gate. Edit the `templates/` copy and run `npm run render-self`; `npm test` fails while the copies are stale.
- **Base-ref semantics.** Gates read `docs/sensitive-paths.json` and `pstack.config.json` from the PR's base, and CI runs the base copy of the gate scripts, so a PR cannot loosen its own gate. A base ref that is given must resolve to a commit (an empty string from an unset variable included), or the call fails closed. It never falls back to the PR's copy. The head copy is used only when the base commit has no copy (the PR that introduces it).
- **Fail closed.** An empty file list, an unreadable list or an unresolvable base means `opus` review and no auto-merge. A failed, uncertain or unconfigured Jev screen counts as `normal`.
- **Gate loosening.** Removing, narrowing or reclassifying a sensitive glob, removing a class, or editing gate code is flagged in the report and needs owner approval plus Opus review. The gate files are themselves on the list (`infra_ci`).
- **No secrets.** Nothing in this repository names a Jev endpoint, token, customer, or provider.
