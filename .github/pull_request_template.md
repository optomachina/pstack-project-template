<!--
Fill every section. Text inside HTML comments (like this one) is ignored by the
pr-body gate (scripts/check-pr-body.mjs), so delete nothing but the prompts.
-->

## Summary

<!-- What changes and why, in two or three sentences. Link the issue. -->

Issue:

## Scope

<!-- What is included, what is intentionally not. A PR over ~200 changed lines (pstack.config.json prSize) states why it cannot be split. Risky or user-visible behavior lands behind a feature flag that defaults off. -->

## Preflight

<!-- Paste the stage lines from `npm run preflight` at the current head. A FAIL line fails this gate. Infra failures (install, network, runner) are reruns, not repair rounds. -->

```text
preflight: typecheck
preflight: lint
preflight: test
preflight: build
```

Repair rounds used: 0 of 2

## Journey test

<!--
Every user-visible change adds or updates a journey test that drives the real UI.
Name the spec (or the CI run URL) here, for example:
  Journey test: e2e/journeys/signup.spec.ts
or, when no journey test applies, give a real reason:
  Journey test: N/A - <reason>
Material UI changes also attach a screenshot or recording.
-->

Journey test:

## Review tier

<!-- From `npm run review-gate` (or the pr-gates job summary): jev, sonnet or opus. Sensitive paths or a risky Jev screen mean opus. -->

Review tier:

## Sensitive classes

<!-- From the review gate / sensitive-paths report: "none" or a comma list (schema, migrations, auth, payments, integrations, secrets, infra_ci, deps). Gate loosening (removing or narrowing a sensitive glob, editing gate code) needs owner approval plus an Opus review. -->

Sensitive classes:

## Verification

<!-- Exact commands run beyond preflight, with outcomes. Separate unrelated baseline failures. Never count skipped, timed-out or stale checks as passes. -->

## Risk and rollback

<!-- Blast radius, feature flag name and default, and how to roll back (git revert of the squash commit unless stated). -->

## Review findings

<!-- Final head SHA, reviewers that completed on that head, open threads and their dispositions. A missing or stale review is not a clean review. -->

<!-- Adopted v2 only: omit the legacy Review tier field. Record Review risk,
Review obligations, Review policy (base digest), and one Review receipt:
<id> <digest> <https://... or artifact:...> per accepted exact-head completion.
A link or requested model is not an observed identity or a completed review.
The disabled template seed and this comment do not adopt the transition. -->
