# Review gates

Managed by the pstack template. Policy: `AGENTS.md` sections "Risk-sized review", "Sensitive paths", "Low-risk auto-merge" and "Journey tests".

## The review gate (`scripts/review-gate.mjs`)

Input: the PR's changed files (and optionally numstat and title). Output (`review-gate.v1` JSON):

| Field | Meaning |
| --- | --- |
| `deterministic` | `risky` if any file is sensitive, the list or config cannot be loaded, or the file list is empty; `low` if every file is in an auto-merge category; else `normal` |
| `jev` | Jev screen status (`accepted`, `uncertain`, `failed`, `not_configured`, `skipped`), tier and confidence |
| `risk` | `max(deterministic, jev)`; anything but an accepted Jev answer counts as `normal` |
| `review_tier` | `jev` (low), `sonnet` (normal), `opus` (risky) |
| `reviews_required` | the chain: `jev`, then `sonnet`, then `opus` |
| `sensitive` | classes and files from `docs/sensitive-paths.json` |
| `auto_merge` | `eligible`, per-file categories, blockers, and the conditions still to check at the head |
| `pr_size` | changed lines against `prSize.maxChangedLines` |

Rules that never bend:

- Jev can raise the tier, never lower it. A sensitive file is `opus` whatever Jev says.
- Jev-only review (`jev`) needs a confident Jev answer of `low` **and** every file in an auto-merge category.
- Unknown or unreadable inputs fail closed: `opus`, not auto-mergeable.
- The gate reads the **base** copy of `docs/sensitive-paths.json` and `pstack.config.json` (`--base-ref`), and CI runs the base copy of the script. A PR cannot loosen its own gate.

```bash
npm run review-gate -- --base-ref origin/{{DEFAULT_BRANCH}} --changed-files-from <(git diff --name-status -z --no-renames origin/{{DEFAULT_BRANCH}}...HEAD)
```

## Jev (optional)

`scripts/jev-client.mjs` speaks a System One compatible protocol (OverDrafter used TypeSafe's System One). The client is **inert** unless `JEV_ENDPOINT` is set in the environment, and no endpoint or credential lives in the repository. To enable it in CI, add repository secrets `JEV_ENDPOINT` (https) and optionally `JEV_API_KEY` and set `JEV_MODEL` if you pin a model. Fork PRs never receive secrets, so their screen is inert and low-risk PRs get Sonnet review. Without Jev, the graph still works: low-risk PRs get Sonnet instead of a Jev-only pass.

Jev output is advisory. It never authorizes, accepts, or filters evidence.

## Reviewers

| Tier | Reviewer | Scope |
| --- | --- | --- |
| `jev` | Jev screen | Semantic risk screen only; the PR still needs green CI and journey evidence |
| `sonnet` | Claude Sonnet, independent session | Correctness, tests, contracts, docs drift ([priorities](#review-priorities)) |
| `opus` | Claude Opus, independent session, high effort | Everything Sonnet covers plus security, data, money, gate integrity; reads the sensitive files in full |

Also require Opus, regardless of tier, for cross-cutting architecture, security-sensitive boundaries, disputed evidence, a third similar failure, and any gate loosening.

A review counts only when it completed on the current head SHA. Record the reviewer, the head SHA, the findings and their dispositions in the PR's "Review findings" section. A rate-limit notice, a stale review or a green quality gate is not evidence that no finding remains.

### Review priorities

1. Security, privacy, auth and data-loss regressions.
2. Broken schema, API or workflow contracts.
3. Missing validation or unsafe handling of external input.
4. Risky dependency additions or expanded permissions.
5. Critical-path testing gaps, including a user-visible change without a real journey test.

Prefer a few high-signal findings over style noise, minimal fixes over refactors, and treat undocumented behavior changes as findings.

## Sensitive paths

- Classify: `node scripts/lib/sensitive-paths.mjs classify <path>...`
- PR report (report only): `npm run sensitive-paths:report` (diffs `HEAD^1..HEAD`; `--base-ref <ref>` to change).
- After editing `docs/sensitive-paths.json`: `npm run sensitive-paths:render` to regenerate the AGENTS.md block, then `npm run agent-contract`.
- **Gate loosening** means removing, narrowing or reclassifying a glob, removing a class, deleting or breaking the list, or editing gate code (`GATE_CODE_FILES`). The report prints `GATE LOOSENING: needs owner approval + Opus review`. Additions are free.

## Journey tests

`scripts/check-journey-tests.mjs` fails when a user-visible path changes (`journeyTests.userVisible` minus `journeyTests.exclude`) and no journey test under `journeyTests.journeyTests` is added or modified, unless the body has `Journey test: N/A - <reason>`. A deleted journey test does not count. A placeholder reason (`<reason>`, `n/a`, `tbd`) does not count, and neither does text inside HTML comments.

A good journey test:

- starts where a user starts (a public route, a link, a deep link), not at a component;
- runs against the real app, with real routing, in a real browser, with no build flags a user would not have;
- performs the user's steps and asserts what the user sees, including the failure path that matters most;
- is named for the journey (`e2e/journeys/<journey>.spec.ts`) so the PR can cite it.

A valid N/A is rare: a copy-only or style-token change already covered by a named journey, or a change behind a default-off flag whose journey lands with the flag flip.

## PR body (`scripts/check-pr-body.mjs`)

Requires `preflight: <stage> PASS|SKIP` lines (no FAIL), `Journey test:`, `Review tier:` and `Sensitive classes:`. For a sensitive PR it requires `Review tier: opus` and every sensitive class.

## Capability contract v2 — disabled until base-governed adoption

The v1 chain above remains effective for unchanged consumers and historical
receipts. `docs/review-policy.json` is a strict, project-owned disabled seed, not an
activation. Once separately adopted, correctness and deep are obligations; approved
Sonnet and Opus remain preferred, with explicitly eligible Astra xhigh subscription
bindings only after confirmed primary unavailability. These native efforts are
independent declarations, not a conversion between providers. No catalog record or
live entitlement is seeded. Normal risk keeps correctness; risky keeps correctness
plus a different deep-review execution. Extra project obligations remain required.

`runReviewGateV2` loads policy and configuration exclusively from a committed base,
and verifies that its complete executing code bundle matches that base. It requires
a separate authenticated adoption package and exact-head source review evidence.
The owner transition names old/new policy digests, exact base/head/patch, approved
bindings and preserved independence/diversity predicates. Its source review must
have separately observed Astra xhigh identity and pass the completion validator.
The adopting commit must be in base history. Boolean bypasses and head-policy
fallbacks are not supported. Authority/issuer authentication belongs to the existing
controller; matching hashes alone do not create authorization.

The CLI `--contract v2` is fail-closed without that authenticated controller package;
this patch does not transport live authorization through CI or enable v2. The
existing v1 workflow/check names and required conditions remain intact. A subsequent
reviewed adapter must call the v2 API from a base-prepared bundle. The bundle includes
the strict policy, routing and completion helpers; a PR's head code cannot be used
as the adoption authority. Code Owners/branch protection remain independently
required and are not enabled by this patch. Verify a real configured owner before
claiming enforcement; template placeholders and fallback owner strings are not proof.

V2 PR bodies use `Review risk`, `Review obligations`, `Review policy` (digest), and
one `Review receipt: <id> <digest> <https://... or artifact:...>` for each genuinely
validated completion. They omit `Review tier`; an Astra run must not be labeled
Opus or Sonnet. A URL alone does not satisfy receipt validation. Unknown schema
versions block. V1 receipts never become v2 attestations through label conversion.

Cross-family constraints remain hard requirements. This default template seed uses
execution independence and distinct slots because the existing template does not
state a separate author/reviewer cross-family predicate. It is not authority to
remove such a predicate from a project. The owner transition explicitly preserves
all applicable diversity constraints; consumer reconciliation remains separate.

To adopt, Groot must bind the finished patch and independently accepted source
review to the real owner's authenticated transition record, set a verified owner
and enable the policy through a separately reviewed base change. Preserve any old
coordinator countersign, merge-card and Code Owner requirements until a separately
recorded authority transition settles them. No historical review is reclassified.

When a base policy is enabled, the legacy gate explicitly blocks with
`adopted_policy_requires_v2` before consulting Jev. Unknown policy versions block
instead of being parsed as v1. Unchanged bases without a policy, and explicit
unresolvable-base fail-closed v1 reporting, retain their existing compatibility.


### Inactive v2 boundary hardening

The v2 gate and base readers share the verified system Git executor in
`scripts/lib/sensitive-paths.mjs`; project PATH and npm's local executable prefix
cannot choose Git. `/usr/bin/git` is the default. A trusted launcher may provide
an absolute `PSTACK_GIT` override only with root-owned canonical executable and
ancestors, none group/world-writable. Missing/unverified executables block; host,
launcher, Node/Git installation and authenticated controller remain trusted.
Current and adoption evidence use raw `--binary --no-ext-diff --no-textconv
--ignore-submodules=none` patches, including final newline. This changes the
unpublished evidence convention, so old proposal digests cannot authorize it.

V2 completion binds the original policy's three repair/replan counter maxima in
`appliedCounterLimits`, rejects later increases and counter resets, and blocks at
equal-or-tighter limits. Supported team owners (`@org/team`) remain the configured
owner through policy and authenticated authorization; exact equality and real
actor authority are still required. See [model routing](model-routing.md) for the
complete boundary and compatibility rules. The template policy remains disabled.
