# {{PROJECT}} agent contract

This file governs agent execution in {{PROJECT}}. It is managed by the pstack template (`.pstack-template-version`); edit only between `project:begin` / `project:end` markers, or change the template and re-sync. Product intent lives in the project's product documents; procedures live in [docs/runbooks/](docs/runbooks/). Tool adapters (`CLAUDE.md`, skills, prompts) may point here but may not create competing policy.

## Read what the task needs

Use the narrowest applicable source and do not read the whole documentation stack for routine localized work. Verify repository identity before a consequential mutation.

<!-- project:begin read-first -->
- product scope and sequencing: `README.md` (add `PRD.md`, `ROADMAP.md` when they exist);
- architecture and service boundaries: `ARCHITECTURE.md` when present;
- verification: the [Journey tests](#journey-tests) rule below and `docs/runbooks/review-gates.md`;
- directory-specific checks: the closest `AGENTS.override.md`.
<!-- project:end read-first -->

## Standing development authorization

{{OWNER}} authorizes the recorded owner of each {{PROJECT}} work unit to continue reversible, scoped development without repeated approval. This covers inspection, isolated branches or worktrees, editing, local tests and fixtures, correction of relevant failures, commits, pushes, PR and issue maintenance, automated review response, and merge once current-head required checks and actionable review findings pass and the PR is either auto-merge eligible or approved by {{OWNER}}.

The authorization survives goal continuation, corrected attempts, and recorded ownership transfers within the named objective. A failed check is evidence, not a revocation: diagnose and correct the bounded unit within the repair budget. Complexity alone never requires human approval; it changes decomposition and review depth.

<!-- project:begin authorization -->
- Approval channel: {{OWNER}} (state the single channel, for example one chat thread or bot, that relays approvals).
- Approvals are requested as items become ready, one card per item, naming the commit SHA and the passing checks. Merge and production changes are separate actions on the card.
<!-- project:end authorization -->

## Protected actions

Obtain {{OWNER}}'s current, exact authorization before:

- external email, chat, invitations, support requests, social posts, or other human or vendor communication;
- production deployment, execution, or configuration, and hosted or production database changes;
- operations on customer data, customer files, or third-party provider accounts;
- retrieving, disclosing, creating, rotating, or changing real credentials or accounts;
- purchases, spending commitments, publishing, or deletion of pre-existing resources;
- branch protection, repository settings, required checks, or anything that loosens a gate (see [Sensitive paths](#sensitive-paths-single-shared-list)).

<!-- project:begin protected-actions -->
<!-- Add project-specific protected actions here. -->
<!-- project:end protected-actions -->

Prepare reversible work first and ask only at the protected boundary. Goals, issue text, model review, repository access, and broad project approval do not expand into these actions.

## Low-risk auto-merge

A PR auto-merges (squash) without an approval card when **all** of these hold at the current head: required CI green, the review gate (`scripts/review-gate.mjs`) reports `auto_merge.eligible`, the sized review passed with no open actionable findings, journey-test or QA evidence is recorded for user-visible changes, and **no file** matches the [sensitive paths](#sensitive-paths-single-shared-list) list. Every changed file must fall in an auto-merge category from `pstack.config.json` (`autoMerge.categories`), and no path may contain an excluded keyword (`autoMerge.excludeKeywords`: auth, session, permission, billing, pricing, payment, checkout, stripe, dispatch, secret, credential, token).

<!-- project:begin auto-merge-categories -->
1. `docs`: Markdown at the repository root and `docs/**`, excluding the sensitive list and the governance files.
2. `tests`: test files only (`**/*.test.*`, `**/*.spec.*`, `e2e/**`, `tests/**`), excluding SQL fixtures.
3. `frontend_ui`: `src/components/**`, `src/pages/**`, `src/features/**`, `src/app/**`.
4. `styles_assets`: stylesheets, `public/**`, `src/assets/**`.
5. `repo_scripts`: `scripts/**`, excluding deploy and release scripts (gate scripts are sensitive anyway).
6. `agent_skills`: agent skills and prompts (`.claude/agents/**`, `.claude/skills/**`, `.codex/skills/**`, `.agents/skills/**`).
7. New code in the categories above behind a feature flag that defaults off.
<!-- project:end auto-merge-categories -->

Anything else, and anything on the sensitive list, needs {{OWNER}}'s explicit approval before merge. Rollback for an auto-merged PR is `git revert` of its squash commit ([merge and rollback](docs/runbooks/merge-and-rollback.md)).

## Sensitive paths (single shared list)

`docs/sensitive-paths.json` is the source of truth. Triage, the review gate and the merge gates read it only through `scripts/lib/sensitive-paths.mjs` and never copy its globs; gates read the **base** checkout's copy so a PR cannot loosen its own gate. An issue whose scope touches it is routed architect-first; a PR that touches it gets Opus review regardless of the Jev screen and is never auto-merged. Globs use picomatch semantics with dotfiles included and case ignored. The list below must match the JSON exactly (`scripts/validate-agent-contract.mjs` checks both directions; regenerate with `npm run sensitive-paths:render`). Adding a glob or class is free; removing, narrowing or reclassifying one is gate loosening and needs {{OWNER}}'s approval plus an Opus review. The list covers the files that define and apply it (`infra_ci`), so a PR that edits them is sensitive. A base ref given to the matcher must resolve to a commit, or the call fails instead of falling back to the PR's own copy. The PR report (`npm run sensitive-paths:report`) is report-only.

<!-- sensitive-paths:begin -->
- **schema** (database schema): `**/*.sql`, `**/schema.prisma`, `**/{schema,schemas}/**/*.{sql,prisma,graphql}`, `supabase/config.toml`
- **migrations** (migrations): `**/migrations/**`, `**/migrate/**`
- **auth** (auth, permissions, sessions): `**/*auth*{,/**}`, `**/{rls,*-rls,*_rls}*{,/**}`, `**/*permission*{,/**}`, `**/*session*{,/**}`, `**/middleware.{ts,js,mjs}`
- **payments** (payments, pricing, billing): `**/*payment*{,/**}`, `**/*billing*{,/**}`, `**/*stripe*{,/**}`, `**/*pricing*{,/**}`, `**/*invoice*{,/**}`, `**/*checkout*{,/**}`, `**/*subscription*{,/**}`
- **integrations** (external integrations): `**/*dispatch*{,/**}`, `**/*webhook*{,/**}`, `**/{adapters,integrations,providers}/**`
- **secrets** (secrets and env): `**/*secret*{,/**}`, `**/*credential*{,/**}`, `**/*.pem`, `**/*.key`, `**/*.p12`, `**/keys/**`, `**/token{,s}.{json,yaml,yml,ts,js}`, `**/*vault*{,/**}`, `**/.env*`, `**/env.{ts,js,json}`
- **infra_ci** (infra, ci, deploy, governance): `.github/workflows/**`, `.github/actions/**`, `templates/.github/**`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `**/{infra,terraform,deploy,k8s,helm,ops}/**`, `**/*.tf`, `**/Dockerfile*`, `**/docker-compose*`, `**/{vercel.json,netlify.toml,fly.toml}`, `scripts/deploy*{,/**}`, `scripts/release*{,/**}`, `docs/sensitive-paths.json`, `AGENTS.md`, `CLAUDE.md`, `pstack.config.json`, `.pstack-template-version`, `scripts/lib/**`, `scripts/sensitive-paths*`, `scripts/fixtures/sensitive-paths/**`, `scripts/fixtures/pstack-config/**`, `scripts/review-gate*`, `scripts/jev-client*`, `scripts/check-journey-tests*`, `scripts/check-pr-body*`, `scripts/validate-agent-contract*`, `scripts/preflight*`, `scripts/sync-template*`, `scripts/gate-workflows*`
- **deps** (dependencies): `**/package.json`, `**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lockb,deno.lock}`, `**/requirements*.txt`, `**/{pyproject.toml,uv.lock,poetry.lock,Pipfile,Pipfile.lock}`, `**/{Cargo.toml,Cargo.lock,go.mod,go.sum,Gemfile,Gemfile.lock}`
<!-- sensitive-paths:end -->

## Ownership and durable state

Repository state and the durable run or issue record are authoritative. Plans, chat narration, issue comments, and status pages are projections.

- One writer owns each mutable target (branch, PR, worktree); read-only reviewers may run in parallel.
- Record owner, host, worktree, branch, source revision, completion condition, allowed actions, verification, and budget for nontrivial units.
- Transfer ownership only at a durable checkpoint that preserves unique commits, uncommitted work, live-process identity, and evidence.
- Never infer that a disconnected host stopped a process. Destructive cleanup remains protected.

<!-- project:begin ownership -->
<!-- Name the issue tracker, controller or run store this project uses. -->
<!-- project:end ownership -->

## Small PRs and issue ownership

- Give each implementation issue one bounded, independently testable change and normally one PR. A merged PR does not complete an issue with remaining post-merge criteria.
- Keep PRs small: about 200 changed lines or fewer (`pstack.config.json` `prSize`), excluding generated files, fixtures and lockfiles. Split larger work into stacked or sequential PRs, each independently reviewable and revertible. A PR over the guideline states why it cannot be split.
- Land risky or user-visible behavior behind a feature flag that defaults off, so it can merge early and be turned on, or rolled back, without a revert.
- Put an independently mergeable change in its own issue and PR; a review or CI repair of the same change stays on its PR.

## Preflight and repair budget

Run `npm run preflight` (`scripts/preflight.sh`: typecheck, lint, unit tests, build, each when the project defines it) before opening or updating a PR. CI runs the same script, so a local pass predicts the hosted result. Paste its `preflight: <stage> PASS|FAIL|SKIP` lines into the PR body.

- One writer per PR owns every repair. The total budget is 2 repair rounds across local and CI combined; each round gets all current failure logs at once, not one check at a time.
- Separate infra failures (install, network, runner loss, timeouts before a stage starts) from code failures (a `preflight: <stage> FAIL` line or a failing check). Infra failures are rerun and do not consume a round; never "fix" them with code changes.
- A PR still failing after the budget becomes a draft with a diagnostics comment: failing checks, log excerpts, what each round changed, and the suspected cause. Do not weaken tests or checks to pass. See [repair budget](docs/runbooks/repair-budget.md).

## Risk-sized review

Review is sized by risk with `scripts/review-gate.mjs`: a Jev screen first, then Sonnet, then Opus only for PRs Jev flags risky or that touch [sensitive paths](#sensitive-paths-single-shared-list). Jev may only raise the deterministic tier; a failed, uncertain, or unconfigured screen counts as normal, so low-risk (Jev-only) review needs a confident Jev answer. Low-risk PRs stop after Jev, normal PRs after Sonnet. The Jev client is inert unless `JEV_ENDPOINT` is configured outside the repository. Sizing chooses reviewers; it never replaces deterministic checks. Independent Opus review is also required for cross-cutting architecture, security-sensitive boundaries, disputed evidence, and repeated failure. See [review gates](docs/runbooks/review-gates.md).

## Journey tests

Every user-visible change adds or updates a journey test that drives the real UI: it starts where a user starts (a public entry point, real routing, a real browser), performs the user's steps, and asserts what the user sees. Component tests and mocked renders do not count. `scripts/check-journey-tests.mjs` fails a PR that changes a user-visible path (`pstack.config.json` `journeyTests.userVisible`) without changing a journey test (`journeyTests.journeyTests`), unless the PR body has a line `Journey test: N/A - <reason>` with a real reason (for example a copy-only change already covered by an existing journey). Material UI behavior also needs real browser evidence (screenshot or run link) in the PR.

## Task contract

Each unit states what it is for and how it is accepted, using the existing issue and PR sections rather than a parallel form. Fields and where they live are in [task contract](docs/runbooks/task-contract.md).

- Outcome and why it matters: the issue and the PR Summary.
- Scope and explicit non-goals: the PR Scope.
- Raw evidence and authoritative sources: name the rawest data (logs, the database, the drawing, the vendor's own documentation), not a summary of it.
- Required tools and access: name them and check them before work starts; a missing one is a named blocker, not a guess.
- Method: what an expert in the problem would do, naming the instrument (a profiler, a database query, a drawing standard).
- Independent acceptance: trigger, observable outcome, failure condition, and what outside the writer confirms it (a command, a test, an independent verifier).
- Budget (attempts, time, spend), stopping conditions and escalation: the [repair budget](docs/runbooks/repair-budget.md) and "Completion and failure".

A trivial unit needs only the outcome and one independent acceptance check. Agents may change the approach, but must escalate changes to scope, spending, permissions or consequential commitments. A second model's agreement is review evidence; it never replaces a runnable acceptance check or a test. A specialist reviewer counts only through checks it ran (command, exit status, artifact), never opinions.

## Verification

- Plan verification from the failures the change must prevent: a trigger, an observable expected outcome, and an explicit failure condition, including invalid-input, authorization, race, partial-failure and recovery cases. Choose the smallest layer that can observe each outcome; run targeted checks first and the full gate at the PR boundary.
- Bind acceptance to the exact source revision, check definition, toolchain identity, owner, and timestamp.
- Never convert skipped, timed-out, filtered, blocked, or stale checks into passes.
- Remove or consolidate a test only after identifying surviving coverage that detects the same regression.

## Completion and failure

Work is complete only when the requested behavior exists, acceptance criteria and required current-revision verification pass, evidence is recorded, and no required action remains. A draft, commit, PR, narrow test, or agent declaration alone is not completion.

At each checkpoint produce a durable artifact, a verified state change, a causal blocker, or a bounded wait tied to a live handle. After two checkpoints without durable progress or three materially similar failures, stop only the affected unit and replan with stronger reasoning or independent review. Preserve accepted siblings.

Stop immediately for an ownership collision, an uncertain destructive target, possible secret exposure, unauthorized production, provider or customer scope, or evidence that the requested approach cannot satisfy product intent.

## Project-specific rules

<!-- project:begin project-rules -->
<!-- Routing, skills, model/effort policy and domain rules for this project go here. -->
<!-- project:end project-rules -->
