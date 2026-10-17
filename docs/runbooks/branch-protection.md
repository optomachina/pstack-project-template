# Branch protection

Managed by the pstack template. **Changing branch protection or repository settings is a protected action** (`AGENTS.md`): agents draft the change and the exact command, and the owner approves before anyone applies it.

## Recommended settings for the default branch

| Setting | Recommended | Why |
| --- | --- | --- |
| Require a pull request before merging | **on** | All changes go through the gates |
| Required approvals | **1**, or 0 with a bot gate | 1 human approval for non-auto-merge PRs; an auto-merge bot satisfies it for eligible low-risk PRs. If you use 0, the `ci` + `pr-body` checks and the auto-merge eligibility are the gate |
| Dismiss stale approvals when new commits are pushed | **on** | An approval is for a SHA |
| Require review from code owners | **on** | Required for the gate to hold. A `pull_request` workflow runs the PR's own copy of `ci.yml` and `pr-body-gate.yml`, so a PR could otherwise rewrite or drop its own gate. `.github/CODEOWNERS` owns the workflows, gate scripts and configs; this setting makes the owner's approval mandatory for any PR that touches them. A code owner cannot approve their own PR, so PRs authored by the owner need another code owner or an admin merge |
| Require status checks to pass | **on**: `ci`, `pr-body` | Check names are the job `name`s, not `Workflow / job` |
| Require branches to be up to date before merging (strict) | **on** | Without it a PR can merge green against a stale base |
| Require conversation resolution | **on** | Open review threads block merge |
| Require linear history | **on** | Squash merges only; clean `git revert` rollback |
| Allowed merge methods (repo settings) | **squash only** | One commit per PR |
| Allow force pushes | **off** | |
| Allow deletions | **off** | |
| Do not allow bypassing the above (include administrators) | optional, recommended once stable | Admin bypass skips every gate |
| Automatically delete head branches (repo settings) | **on** | |
| Merge queue | optional (organization-owned repos only) | Replaces strict up-to-date; every required check must trigger on `merge_group` (both template workflows do) |

## Required check rules

- Every required workflow triggers on `merge_group` (`types: [checks_requested]`) so a queue never stalls.
- Never put a job-level `if:` on a required job. A skipped job never reports success. Gate the steps instead (see `pr-gates` and `pr-body`).
- A check that reads PR-only data (body, labels) does a no-op pass on `merge_group` and enforces on `pull_request`.
- Add a new required check to this table and to the `ci` job's `needs` in the same change.

## Snapshot before changing anything

```bash
REPO=<owner>/<repo>
gh api repos/$REPO --jq '{owner_type: .owner.type, allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}' > /tmp/repo-before.json
gh api repos/$REPO/branches/{{DEFAULT_BRANCH}}/protection > /tmp/protection-before.json 2>/dev/null || echo "no classic protection"
gh api repos/$REPO/rulesets > /tmp/rulesets-before.json
```

## Apply (owner-approved only)

> **DO NOT RUN without the owner's approval card naming this runbook's commit SHA.**

```bash
REPO=<owner>/<repo>
gh api --method PATCH repos/$REPO -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F allow_auto_merge=true -F delete_branch_on_merge=true
gh api --method PUT repos/$REPO/branches/{{DEFAULT_BRANCH}}/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci", "pr-body"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

Set `enforce_admins` to `true` once the gates are stable. That is the "include administrators" option.

## Verify (read-only)

```bash
gh api repos/$REPO/branches/{{DEFAULT_BRANCH}}/protection > /tmp/protection-after.json
diff <(jq -S . /tmp/protection-before.json) <(jq -S . /tmp/protection-after.json)
```

Then dry-run: open a trivial docs PR and confirm that `ci` and `pr-body` report, the PR cannot merge until both pass, a PR touching `.github/workflows/` asks for the code owner's review, a second PR goes out of date after the first merges, and a force push to `{{DEFAULT_BRANCH}}` is rejected.

## Rollback

Re-apply the snapshot (`/tmp/protection-before.json`) through the same `PUT`, with owner approval, or remove protection with `gh api --method DELETE repos/$REPO/branches/{{DEFAULT_BRANCH}}/protection` (also protected).
