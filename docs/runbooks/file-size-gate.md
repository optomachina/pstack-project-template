# File-size gate

Install the pre-commit hook once per checkout with `npm run hooks:install` after
syncing with `--add-scripts`. It sets local `core.hooksPath` to `.githooks`. If a
hook manager is already installed, call `node scripts/file-size-gate.mjs --staged`
from that pre-commit hook instead. Sync copies executable hooks but never
activates them automatically.

`npm run file-size:check` checks staged blobs against HEAD. Unstaged changes do
not affect the result. An initial commit uses an empty tree; stage
`.file-size-allowlist.json` too. For committed changes, run:

```bash
node scripts/file-size-gate.mjs --base-ref origin/{{DEFAULT_BRANCH}} --head-ref HEAD
```

The limit is 5,000 estimated tokens (bytes / 4), exactly 20,000 bytes. New text
files above it fail. Existing files fail if their resulting size exceeds the
limit and grows; equal-size edits and shrinking oversized files pass. Detected
renames preserve the old file's size; copies are new files. Deletions, symlinks
and submodules are ignored. UTF-8 characters count by bytes.

To fix a failure, split by responsibility: extract cohesive helpers/components
into focused modules, separate fixtures/data, and keep a small entry point. Each
new file must fit the budget; an existing oversized file must not grow. Stage
the split and retry. Do not move code into another oversized file.

The project-owned `.file-size-allowlist.json` contains exclusion globs (`*`, `**`,
`?`, `{a,b}`; case insensitive, including dotfiles). Defaults cover lockfiles,
generated/codegen output, vendored directories and common binary extensions.
Content with NUL bytes or invalid UTF-8 also counts as binary. Add precise paths
for other lockfiles, generated outputs or assets and explain exceptions in the
PR. Sync seeds the allowlist once and preserves edits. Missing/invalid policy or
refs fail closed.

The hook and CI read the base commit's allowlist; only the commit introducing
the policy uses its staged/head copy. New exceptions take effect after landing.
CI runs the base copy of the gate once installed. Its `file-size` job feeds the
required `ci` aggregate and compares the PR merge against its base, a default
branch push against the prior SHA, or a merge group against its base SHA. A zero
push SHA uses an empty tree. Workflow integrity still requires CODEOWNERS and
owner-configured branch protection as described in the branch-protection runbook.
