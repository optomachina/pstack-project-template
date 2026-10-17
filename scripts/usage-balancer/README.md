# Usage balancer

`usage-balancer.mjs` prints one JSON report on the coding usage pools so new work lands where budget would otherwise expire unused.

- **Codex, Claude, Cursor** come from [CodexBar](https://github.com/steipete/CodexBar)'s CLI (`brew install --cask codexbar`), one `codexbar usage --provider <p> --format json` call per provider with a timeout, or from saved CodexBar JSON (`--codexbar-json`). Cursor reports included usage (the `Total` window) and is a Grok-only build pool; see rule 7. Each pool reports `usedPercent`, `resetsAt` (UTC, and local in the system time zone), `paceTargetPercent` (elapsed share of its window), `deltaPercent` (used minus target), `pace` (`ahead`, `behind`, `on_pace` within 3 points), its routing `mode`, and the 5-hour window when the provider has one.
- **Jev** (TypeSafe System One) has no published quota or reset; it is rate limited (429/529). Its pool is tracked from JSONL call ledgers (`--jev-log`, lines with `ts`, `ok`, `reason`, `usage`): calls and tokens over 7 days and throttling in the last hour. `--jev-probe` makes one synthetic call through `../jev-client.mjs` (configured by `JEV_ENDPOINT`, optional `JEV_API_KEY`, `JEV_MODEL`) at most every 15 minutes and appends it to the first ledger.

The script reads no credentials itself and prints none; CodexBar and `jev-client.mjs` own them.

```sh
node scripts/usage-balancer/usage-balancer.mjs --source claude=web \
  --jev-log ~/.local/state/usage-balancer/jev-calls.jsonl --jev-probe
```

## Routing rule

1. **Jev first.** Send screening, triage, duplicate checks, risk and review screens, and accept/reject or rubric scoring of small fixes and drafts to Jev before any LLM pool, whenever the Jev pool is `first`. Jev only decides (choice, score, yes/no); it never writes code or text, so the generating step of a small fix or draft goes to the pool picked below, and Jev screens the result. Log every Jev call to the ledger. When Jev is `throttled`, `failing` (its latest call this hour failed) or `unavailable`, or its answer is below the confidence floor, fall back to the pool's reviewer.
2. **New builds** go to the pool in `build` mode, not cooling down, that is furthest behind pace (most negative `deltaPercent`). With none, use the furthest-behind `burn_backlog` pool.
3. **Burn before reset.** A pool within 24 hours of its reset with budget left (`burn_backlog`) gets backlog work that is fine to burn: refactors, tests, docs, cleanup, speculative spikes.
4. **Review only at 90%.** A pool at or above 90% of its weekly budget (`review_only`) takes only reviews and small verifications until it resets. This takes precedence over rule 3.
5. **Cool down.** A pool whose 5-hour window is at or above 90% (`coolingDown`) takes no new builds until that window resets.
6. A pool with no data, or whose window already reset in a stale snapshot (`unavailable`), is skipped, not assumed empty. Jev is `unavailable` on a host without `JEV_ENDPOINT`.
7. **Cursor eligibility takes precedence over rules 2 and 3 for Cursor.** Cursor is a Grok-only build pool (for example `grok-4.6` or `xai/grok-4.6`). The work item's model decides eligibility: non-Grok models, including Claude, Composer and Auto, are ineligible. Cursor is never a review pool. It routes only while included usage is strictly below `--cursor-cap` (default `0.90`); at or above the cap its pool mode is `included_cap_reached`, with no build or backlog routing. On-demand risk uses mode `on_demand_risk`; unknown usage uses `unavailable`. Never route into on-demand spend. Positive provider cost or any current included billing window at 100% blocks Cursor, and all pools marked for on-demand billing are excluded. Missing, invalid or stale usage and an unknown model fail closed. Cursor rule corrected by Blaine, Oct 16 2026.

Pass `--model <name>` for the model of the work being routed and optionally `--cursor-cap <fraction>` where `0 < fraction <= 1`. For example:

```sh
node scripts/usage-balancer/usage-balancer.mjs --model grok-4.6 --cursor-cap 0.90
```

Cursor included usage comes from the current billing window labelled `Total`, or, without a current Total window, the maximum usage across current primary/secondary/tertiary billing windows of at least seven days. Grok Bot extra rate windows do not replace the included allowance check. Pool rows retain a non-enumerable Cursor snapshot so `route()` can recheck it without printing account details; spreading a row drops the snapshot and fails closed; `poolFor()` reports allowance eligibility independently of the work model, which `route()` enforces.

The `routing` section includes `model`, `cursorCap`, `cursorEligible`, `cursorReason` and `cursorExcluded` alongside the existing routing fields. Cursor pool rows also carry `reason`. Reasons are `ok`, `model_unknown`, `non_grok_model`, `usage_unknown`, `at_or_over_cap` or `on_demand_risk`. `cursorExcluded` is true whenever Cursor is ineligible; Cursor is then absent from `buildOrder` and `burnBacklogPools` and cannot be `newBuildPool`.
