# Repair budget

Managed by the pstack template. Policy: `AGENTS.md` "Preflight and repair budget".

## Rules

- One writer per PR owns every repair. Reviewers report; they do not push.
- **2 repair rounds total**, local and CI combined, per PR.
- A round starts when the writer changes code in response to a failure and ends when the fix is pushed (or preflight is re-run locally). Each round gets **all** current failure logs at once: fix every failing check together, not one check at a time.
- Infra failures do not consume a round, and are never fixed with code.
- Never weaken a test, a check, a threshold or a gate to get green. Weakening a gate is gate loosening and needs owner approval plus Opus review.

## Classify the failure first

| Infra failure (rerun) | Code failure (repair round) |
| --- | --- |
| `npm ci` or install errors, registry or network timeouts | a `preflight: <stage> FAIL` line |
| runner lost, job cancelled, timed out before a stage started | a failing check with an assertion, a type or lint error |
| a third-party service outage in a step that does not test our code | `agent-contract`, `pr-gates` or `pr-body` reporting a real problem |
| GitHub API rate limit in a gate step | a reproducible flake in our own test (fix the flake; it is code) |

The preflight's per-stage lines exist so this split is mechanical: no `preflight: <stage> start` line means the failure came before any stage ran.

Rerun infra failures with `gh run rerun <run-id> --failed`. If the same infra failure happens three times, stop and report it as an infra blocker. Do not change code.

## Round procedure

1. Collect every failing check's log at the current head (`gh pr checks <n>`, `gh run view <run-id> --log-failed`).
2. Reproduce locally with `npm run preflight` (or the specific stage) when possible.
3. Fix the causes, run `npm run preflight`, push once.
4. Record in the PR: round number, what failed, what changed.

## Budget exhausted

When the PR still fails after 2 rounds:

1. Convert the PR to a draft (`gh pr ready <n> --undo`).
2. Post a diagnostics comment:
   - failing checks and log excerpts at the current head;
   - what each round changed and why;
   - the suspected cause and what evidence would confirm it;
   - whether the approach itself may be wrong.
3. Label it `owner-intervention` if a human must act (it counts in [agent-graph metrics](../agent-graph.md#metrics)).
4. Stop. A replan uses stronger reasoning or an independent (Opus) causal review. It does not get a third blind attempt.

The broader stop rule still applies: after two checkpoints without durable progress, or three materially similar failures, stop the unit and replan.
