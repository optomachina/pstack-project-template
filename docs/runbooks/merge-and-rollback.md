# Merge and rollback

Managed by the pstack template. Policy: `AGENTS.md` "Low-risk auto-merge" and "Protected actions".

## Merge preconditions (every PR)

At the **current head SHA**:

- [ ] required checks green: `ci` and `pr-body` (see [branch protection](branch-protection.md)); a skipped, cancelled or timed-out check is not green;
- [ ] the reviewers the review gate named have completed on this SHA, with no open actionable findings;
- [ ] journey test (or a valid `Journey test: N/A - <reason>`) and, for UI changes, screenshot evidence;
- [ ] the branch is up to date with the default branch (strict checks or merge queue);
- [ ] the PR is not a draft.

## Auto-merge path

Allowed only when the review gate reports `auto_merge.eligible: true`: every file is in an auto-merge category (`pstack.config.json` `autoMerge.categories`), no path contains an excluded keyword, nothing matches the sensitive list, and the risk tier is not `risky`.

```bash
gh pr merge <n> --squash --auto --delete-branch
```

With strict up-to-date checks, GitHub auto-merge waits for someone to update the branch. Run `gh pr update-branch <n>` first, and again whenever the PR goes out of date. With a merge queue, the same command enqueues the PR. The merged commit is then the queue's tested commit, so cite the merged SHA on the default branch, not the PR head.

## Approval path (everything else)

Send the owner **one approval card per PR**, when it is ready:

- PR link, head SHA, and the passing required checks on that SHA;
- review tier and the completed reviews (with their head SHA);
- sensitive classes and any gate loosening the report flagged;
- rollback plan;
- separate actions: "merge" and, if relevant, "production migration/deploy" (protected actions are never bundled).

Merge only after an exact approval for that SHA. A new push invalidates the approval.

## Rollback

Default: revert the squash commit.

```bash
git fetch origin
git switch -c fix/revert-<short-sha> origin/main
git revert --no-edit <squash-sha>
git push -u origin HEAD
gh pr create --fill --title "revert: <original title>" --body "Reverts <squash-sha> because <observed failure>."
```

A revert PR is reviewed like any other and follows the same gates. It usually qualifies for fast Sonnet review, unless it touches sensitive paths.

Prefer the flag: if the change shipped behind a feature flag, turning the flag off is the rollback (a config change, which may itself be a protected production action).

Database migrations are **not** rolled back by reverting code. Follow the project's migration runbook, and get the owner's approval before any production database change.

After a rollback, record on the issue the reverted SHA, the revert SHA, the observed failure, and the evidence. Then reopen the issue or file a follow-up.

<!-- project:begin rollback -->
<!-- Project-specific deploy/rollback commands (hosting, feature-flag service, migration runbook). -->
<!-- project:end rollback -->
