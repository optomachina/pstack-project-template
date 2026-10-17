# Usage balancer

`usage-balancer.mjs` prints one JSON report on the coding usage pools so new work lands where budget would otherwise expire unused.

- **Codex, Claude, Cursor** come from [CodexBar](https://github.com/steipete/CodexBar)'s CLI (`brew install --cask codexbar`), one `codexbar usage --provider <p> --format json` call per provider with a timeout, or from saved CodexBar JSON (`--codexbar-json`). Each pool reports `usedPercent`, `resetsAt` (UTC, and local in the system time zone), `paceTargetPercent` (elapsed share of its window), `deltaPercent` (used minus target), `pace` (`ahead`, `behind`, `on_pace` within 3 points), its routing `mode`, and the 5-hour window when the provider has one.
- **Jev** (TypeSafe System One) has no published quota or reset; it is rate limited (429/529). Its pool is tracked from JSONL call ledgers (`--jev-log`, lines with `ts`, `ok`, `reason`, `usage`): calls and tokens over 7 days and throttling in the last hour. `--jev-probe` makes one synthetic call through `../jev-client.mjs` (configured by `JEV_ENDPOINT`, optional `JEV_API_KEY`, `JEV_MODEL`) at most every 15 minutes and appends it to the first ledger.

The script reads no credentials itself and prints none; CodexBar and `jev-client.mjs` own them.

```sh
node scripts/usage-balancer/usage-balancer.mjs --source claude=web \
  --jev-log ~/.local/state/usage-balancer/jev-calls.jsonl --jev-probe
```

## Routing rule

1. **Jev first.** Send screening, triage, duplicate checks, risk and review screens, and accept/reject or rubric scoring of small fixes and drafts to Jev before any LLM pool, whenever the Jev pool is `first`. Jev only decides (choice, score, yes/no); it never writes code or text, so the generating step of a small fix or draft goes to the pool picked below, and Jev screens the result. Log every Jev call to the ledger. When Jev is `throttled` or `unavailable`, or its answer is below the confidence floor, fall back to the pool's reviewer.
2. **New builds** go to the pool in `build` mode, not cooling down, that is furthest behind pace (most negative `deltaPercent`). With none, use the furthest-behind `burn_backlog` pool.
3. **Burn before reset.** A pool within 24 hours of its reset with budget left (`burn_backlog`) gets backlog work that is fine to burn: refactors, tests, docs, cleanup, speculative spikes.
4. **Review only at 90%.** A pool at or above 90% of its weekly budget (`review_only`) takes only reviews and small verifications until it resets. This takes precedence over rule 3.
5. **Cool down.** A pool whose 5-hour window is at or above 90% (`coolingDown`) takes no new builds until that window resets.
6. A pool with no data, or whose window already reset in a stale snapshot (`unavailable`), is skipped, not assumed empty. Jev is `unavailable` on a host without `JEV_ENDPOINT`.
