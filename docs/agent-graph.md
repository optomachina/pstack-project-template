# Agent graph

This is a pointer and a summary, not a second policy. `AGENTS.md` governs.

## Where the graph is defined

The pstack setup was extracted from OverDrafter. OverDrafter has **no document or URL called the "universal agent graph"**: a search of the OverDrafter repository found no such reference. The graph is defined across two OverDrafter documents, which this summary draws on:

- `docs/agent-development-control-plane.md` (OverDrafter), section "Design": one controller owns scheduling state, a task graph records units and dependencies, workers implement one unit each, an integrator owns the branch and PR, deterministic checks and risk-sized independent review accept or reject artifacts, and a governor observes liveness and protected boundaries without becoming a second scheduler.
- `docs/agent-graph-metrics.md` (OverDrafter): how to tell whether the "lean agent graph (see `AGENTS.md`)" is working, by cost per accepted PR and founder interventions. That is the only place OverDrafter uses the term "agent graph".

If your organization keeps a canonical universal agent graph elsewhere, replace this section with its path or URL.

<!-- project:begin graph-location -->
<!-- Project-specific graph location or controller docs, if any. -->
<!-- project:end graph-location -->

## The lean graph, as pstack implements it

```text
issue ──> writer (one owner per PR)
            │  npm run preflight (local)        ── 2 repair rounds max, local + CI
            ▼
          PR ──> CI: preflight, agent-contract, pr-gates (sensitive report,
            │       review gate, journey tests), pr-body
            ▼
          review gate ──> Jev screen ──low──> done (Jev-only)
                              │ normal ──> Sonnet review
                              │ risky or sensitive ──> Sonnet + Opus review
            ▼
          merge: auto-merge (low-risk categories, no sensitive paths)
                 or owner approval card (everything else)
            ▼
          rollback: git revert of the squash commit
```

| Node | Owner | Artifact | Gate |
| --- | --- | --- | --- |
| Writer | one agent per PR | branch, PR, preflight lines | `scripts/preflight.sh` |
| Contract | CI | `agent-contract` job | `scripts/validate-agent-contract.mjs` |
| Sensitive report | CI (base copy) | `sensitive-paths-report.json` | report only |
| Review gate | CI (base copy) | `review-gate.json`: tier and auto-merge | `scripts/review-gate.mjs` |
| Journey rule | CI (base copy) | `journey-tests.json` | `scripts/check-journey-tests.mjs` |
| PR body | CI (base copy) | `pr-body` check | `scripts/check-pr-body.mjs` |
| Reviewers | Jev, Sonnet, Opus | findings, verdict on the head SHA | sized by the review gate |
| Merger | auto-merge or owner | squash commit | branch protection |

## Metrics

Ported from OverDrafter's `docs/agent-graph-metrics.md`. Count by hand or with `gh`; no tooling is required.

**Cost per accepted PR** = total agent spend in the window / accepted PRs in the window. An accepted PR is merged to the default branch with current-head checks green. Spend includes the writer, repair rounds, the Jev screen and the Sonnet and Opus reviews. Include abandoned and draft PRs in the numerator. Report the median and worst PR alongside the mean, and split by tier (Opus-reviewed or not). Companion counts: repair rounds per PR (budget 2) and the share of PRs green with zero repair rounds.

**Owner interventions per accepted PR**: any point where the owner must act for a PR to progress beyond protected-action approvals. That covers answering an agent question, rerunning or editing by hand, taking over a draft that exhausted its repair budget, and overriding a verdict. Label each with `owner-intervention` and a one-line reason, so `gh pr list --label owner-intervention --state all` counts them.

Review weekly. Falling cost and interventions with steady throughput means the graph is paying off. A rising share of draft-with-diagnostics PRs or infra reruns points at preflight or the runners, not the agents.
