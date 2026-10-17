# PR lifecycle

Managed by the pstack template. Policy lives in `AGENTS.md`; this is the procedure.

## 1. Before writing code

1. Confirm the issue names one bounded, independently testable change with acceptance criteria. Split it into child issues if not.
2. Check the scope against the sensitive list: `node scripts/lib/sensitive-paths.mjs classify <paths you expect to touch>`. Any class means the work is routed architect-first: plan with Opus before implementing.
3. Create a branch (`feature/<desc>` or `fix/<desc>`) or a worktree. Record the owner, branch, and completion condition on the issue.
4. Plan verification: for each acceptance criterion, write the trigger, the observable outcome and the failure condition. For user-visible behavior, name the journey test you will add or update.

## 2. While writing

- Keep the diff near the size guideline (`pstack.config.json` `prSize.maxChangedLines`, default 200, excluding lockfiles, fixtures and generated files). Stack PRs when it grows.
- Put risky or user-visible behavior behind a feature flag that defaults off.
- Add or update the journey test (under `journeyTests.journeyTests`, default `e2e/journeys/**`) in the same PR as the UI change. It must drive the real UI from a user's entry point.

## 3. Before opening or updating the PR

```bash
npm run preflight                      # paste the "preflight: <stage> ..." lines into the PR
npm run review-gate -- --base-ref origin/{{DEFAULT_BRANCH}} $(git diff --name-only origin/{{DEFAULT_BRANCH}}...HEAD)
node scripts/check-journey-tests.mjs --changed-files-from <(git diff --name-status --no-renames origin/{{DEFAULT_BRANCH}}...HEAD) --body-file pr-body.md
```

Fill `.github/pull_request_template.md`: preflight lines, `Journey test:`, `Review tier:` and `Sensitive classes:` from the review gate, risk and rollback.

## 4. CI

| Check | Workflow | Blocks merge |
| --- | --- | --- |
| `ci` (aggregate of `preflight`, `agent-contract`, `pr-gates`) | `ci.yml` | yes |
| `pr-body` | `pr-body-gate.yml` | yes |

A failing check is triaged as [infra or code](repair-budget.md). Code failures consume repair rounds (2 total); infra failures are rerun.

## 5. Review

Run the reviewers the review gate names ([review gates](review-gates.md)) on the **current head SHA**. Address actionable findings on the same PR. A review on an older head is stale and does not count.

## 6. Merge

- **Auto-merge** when the review gate reports `auto_merge.eligible`, CI is green at the head, the sized review passed with no open actionable findings, and journey or QA evidence is recorded. Squash merge.
- **Otherwise**, request one approval card from the owner naming the head SHA and the passing checks. Merge and any production change are separate actions on the card.

See [merge and rollback](merge-and-rollback.md).

## 7. After merge

- Record the merged squash SHA on the issue. The issue is complete only when every acceptance criterion holds (post-merge criteria included).
- Watch the default branch's first CI run after the merge. If it is red, roll back first and debug second.
