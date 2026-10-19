# Task contract

Managed by the pstack template. Policy: `AGENTS.md` "Task contract". This runbook maps the contract onto the issue, the PR body and the run record that already exist, and defines the explicit states a unit can be in when work cannot proceed. It adds no gate and no new form.

## Fields

| Field | Example | Where it lives today |
| --- | --- | --- |
| Outcome and why it matters | "Quote page loads in under 2 s for a 50-line cart, so buyers do not abandon it" | Issue; PR `## Summary` |
| Scope and non-goals | "Cart query only; no pricing changes" | PR `## Scope` |
| Raw evidence and authoritative sources | "Production trace for the slow request, the query plan, not the dashboard summary" | Issue; PR `## Verification` |
| Required tools and access | "Read access to the trace store; `EXPLAIN` on a replica" | Issue; run record (checked before work starts) |
| Method | "Profile with the database's own query plan, then compare before and after on the same data" | Issue; PR `## Verification` |
| Independent acceptance | "Trigger: load test at the head SHA. Outcome: p95 under 2 s. Failure: any run over 2 s. Confirmed by: CI job or a verifier that is not the writer" | PR `## Verification`, `## Review findings`; run record verdict |
| Budget | "2 repair rounds; 4 hours; no paid services" | PR `Repair rounds used`; run record |
| Stopping conditions and escalation | "Stop if the query plan shows the fix needs a schema change; escalate to the owner" | `AGENTS.md` "Completion and failure"; [repair budget](repair-budget.md) |

### Simple task (two fields)

- Outcome: the README install command is wrong; make it match `package.json`.
- Independent acceptance: `grep` the README for the command and run it in a clean checkout; exit status 0.

A trivial unit needs nothing more. Do not fill the other fields to look thorough.

### Nontrivial task (all fields)

- Outcome and why: checkout totals differ from the invoice by one cent for some carts; finance cannot reconcile.
- Scope and non-goals: the rounding step only; no change to tax rules or the invoice layout.
- Raw evidence: ten real mismatched orders exported from the orders table, with line items; the payment provider's rounding documentation.
- Tools and access: read-only database role; the provider's sandbox. Both checked before starting.
- Method: replay the ten orders through the totals function and diff against the stored totals; fix; replay again plus a property test over random carts.
- Independent acceptance: the replay script exits 0 for all ten orders at the head SHA, and the property test passes in CI. A reviewer who is not the writer re-runs the replay.
- Budget: 2 repair rounds, one working day, no spend.
- Stop and escalate: if any fix changes a stored total, stop and ask the owner (customer data and money).

## States and recovery

Each state is recorded on the unit (issue comment or run record) with its entry evidence. Acceptance, evidence and budget are never lowered to leave a state.

| State | Evidence required to enter | Who acts | How it exits | Repair round consumed |
| --- | --- | --- | --- | --- |
| Failed check (code) | A `preflight: <stage> FAIL` line or failing check, log at the current head | The writer | A repair round fixes all current failures together; re-run | Yes |
| Infra failure | Failure before any stage started, runner lost, install or network error | The writer, or whoever owns the runner | Rerun (`gh run rerun <run-id> --failed`); three identical failures become an infra blocker | No (existing [repair budget](repair-budget.md) rule) |
| Access missing | The exact access that is missing (system, role, credential type) and the command or call that showed it | A named owner who can grant it; credentials are a protected action | Owner grants access; the writer re-checks it and resumes | No |
| Quota exhausted, model unavailable or provider unavailable | The provider's own error or status, and the time of the observation | The controller or owner | Resume at the stated time if known, or move to a fallback route of equal or higher capability that keeps the same task record, acceptance and evidence | No |
| Host offline | Failed reachability check from the controller; never assume the process stopped | The controller | Only that host's units park; independent work continues elsewhere. The unit resumes when the host returns, or its owner is transferred at a durable checkpoint | No |
| Review disagreement | Two reviewers' findings on the same head SHA, with the checks each ran | The owner, or an Opus review for disputed evidence | Escalate with the evidence; resolve by re-running the disputed check | No |
| Budget exhausted | Round, time or spend count against the recorded budget | The writer stops; the owner decides | Stop and replan with stronger reasoning or independent review per the [repair budget](repair-budget.md); spend beyond budget is a protected action | Already spent |

A blocked unit names its blocker, owner and what unblocks it. A bare "blocked" is not a state.

## Provider handoff invariant

When a unit moves to a different model, provider or runtime, the task identity, acceptance criteria, evidence and budget travel unchanged. The new runtime does not restate the task from memory; it reads the same record. It records the model and effort it actually observed running, not the ones requested. A fallback route must be of equal or higher capability; a weaker one is an escalation to the owner, and it never lowers the acceptance check.

## Runtime adapters

Shared policy lives in `AGENTS.md` and these runbooks. Runtime adapters (`CLAUDE.md`, the Codex configuration, and the OpenCode, Hermes, OpenClaw and Grok Bot configurations) may map only:

- model IDs;
- effort parameters;
- tool names;
- session mechanics.

An adapter adds no gates and creates no competing policy. Take model IDs and effort settings from the runtime's own `--help` output or documented catalog at the time of use, not from a copy in this repository. Names such as Claude Code `ultracode` are session modes of one runtime, not effort values that carry over to another. For the model catalog and routing policy, see `docs/runbooks/model-routing.md` once adopted; this runbook does not define them.

## Jev

Jev handles bounded semantic judgments: relevance, duplicate detection, a routing choice, raising a risk tier. Its output is validated against a fixed set of allowed answers, and a deterministic fallback applies when it is unconfigured, uncertain or failing. Jev never authorizes or accepts; see "Jev (optional)" in [review gates](review-gates.md) ("Jev output is advisory. It never authorizes, accepts, or filters evidence.").
