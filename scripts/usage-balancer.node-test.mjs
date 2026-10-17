import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURSOR_INCLUDED_CAP, cursorEligibility, isGrokModel, main, jevPool, paceFor, poolFor, route } from "./usage-balancer/usage-balancer.mjs";

const now = Date.parse("2026-10-17T02:40:00Z");
const week = 10080;
const entry = (used, resetsAt, extra = {}) => ({ provider: "x", source: "web", usage: { secondary: { usedPercent: used, resetsAt, windowMinutes: week }, ...extra } });

test("pace target is the elapsed share of the window", () => {
  const pace = paceFor({ usedPercent: 81, resetsAt: "2026-10-22T06:21:42Z", windowMinutes: week }, now);
  assert.equal(pace.paceTargetPercent, 26.4);
  assert.equal(pace.pace, "ahead");
  assert.equal(paceFor({ usedPercent: 0, resetsAt: "2026-11-01T00:00:00Z", windowMinutes: 44640 }, now).pace, "behind");
  assert.equal(paceFor(null, now), null);
  assert.equal(paceFor({ usedPercent: 5, resetsAt: "2026-10-16T00:00:00Z", windowMinutes: week }, now), null, "already reset");
  assert.equal(paceFor({ usedPercent: 5, resetsAt: "soon", windowMinutes: week }, now), null, "unparsable");
});

test("modes: >= 90% is review only, then burn within 24h, else build", () => {
  assert.equal(poolFor("claude", entry(97, "2026-10-17T22:00:00Z"), now).mode, "review_only");
  assert.equal(poolFor("a", entry(60, "2026-10-17T20:00:00Z"), now).mode, "burn_backlog");
  assert.equal(poolFor("b", entry(60, "2026-10-20T20:00:00Z"), now).mode, "build");
  assert.equal(poolFor("c", { provider: "c", error: { message: "no access" } }, now).mode, "unavailable");
});

test("a 5-hour window at 90% or more cools the pool down", () => {
  const short = { usedPercent: 95, resetsAt: "2026-10-17T04:00:00Z", windowMinutes: 300 };
  assert.equal(poolFor("claude", entry(40, "2026-10-20T20:00:00Z", { primary: short }), now).coolingDown, true);
  const expired = { usedPercent: 10, resetsAt: "2026-10-17T01:00:00Z", windowMinutes: 300 };
  assert.equal(poolFor("claude", entry(40, "2026-10-20T20:00:00Z", { primary: expired, tertiary: short }), now).coolingDown, true, "skips an expired short window");
});

test("new builds go to the build pool furthest behind pace", () => {
  const pools = [
    poolFor("codex", entry(81, "2026-10-22T06:21:42Z"), now),
    poolFor("claude", entry(97, "2026-10-17T22:00:00Z"), now),
    poolFor("cursor", entry(0, "2026-11-01T00:00:00Z"), now),
    poolFor("burner", entry(50, "2026-10-17T20:00:00Z"), now),
  ];
  const r = route(pools, { model: "grok-4.6" });
  assert.equal(r.newBuildPool, "cursor");
  assert.deepEqual(r.reviewOnlyPools, ["claude"]);
  assert.deepEqual(r.burnBacklogPools, ["burner"]);
});

test("a cooling-down pool never gets new builds, even as the fallback", () => {
  const short = { usedPercent: 95, resetsAt: "2026-10-17T04:00:00Z", windowMinutes: 300 };
  const cooling = poolFor("claude", entry(10, "2026-10-20T20:00:00Z", { primary: short }), now);
  assert.equal(route([cooling]).newBuildPool, null);
  const burner = poolFor("burner", entry(50, "2026-10-17T20:00:00Z"), now);
  assert.equal(route([cooling, burner]).newBuildPool, "burner");
});

test("jev pool counts calls and flags recent throttling", () => {
  const lines = [{ ts: "2026-10-16T00:00:00Z", ok: true, usage: { input_tokens: 10, output_tokens: 2 } }, { ts: "2026-10-17T02:30:00Z", ok: false, reason: "http_429" }];
  const jev = jevPool(lines, now, true);
  assert.equal(jev.calls7d, 2);
  assert.equal(jev.inputTokens7d, 10);
  assert.equal(jev.mode, "throttled");
  assert.equal(jevPool([], now, false).mode, "unavailable");
  assert.equal(jevPool(lines.slice(0, 1), now, false).mode, "unavailable", "history without config cannot be called");
  assert.equal(jevPool([], now, true).mode, "first");
  assert.equal(jevPool([{ ts: "2026-10-17T02:35:00Z", ok: false, reason: "http_401" }], now, true).mode, "failing");
  assert.equal(jevPool([{ ts: "2026-10-18T00:00:00Z", ok: false, reason: "http_429" }], now, true).mode, "first", "ignores future lines");
});

const reset = "2026-11-01T00:00:00Z";
const cursorRow = (used, resetsAt = reset) => poolFor("cursor", entry(used, resetsAt), now);
const grokRoute = (rows, opts = {}) => route(rows, { model: "grok-4.6", now, ...opts });

test("Grok under the included cap gets the furthest-behind Cursor build pool", () => {
  const r = grokRoute([cursorRow(40), poolFor("codex", entry(80, reset), now)]);
  assert.equal(r.newBuildPool, "cursor");
  assert.equal(r.cursorEligible, true);
  assert.equal(r.cursorReason, "ok");
  for (const model of ["grok", "grok4", "grok-4", "grok_4", "grok-4.6", "XAI/GROK-4.6", "grok-code-fast-1"]) assert.equal(isGrokModel(model), true);
  for (const model of ["notgrok", "grokish", "agroky", "opus", "", undefined]) assert.equal(isGrokModel(model), false);
});

test("Cursor snapshots stay private while routing rechecks the original row", () => {
  const value = { ...entry(40, reset), accountEmail: "private@example.test", accountId: "private-id" };
  const row = poolFor("cursor", value, now);
  const json = JSON.stringify(row);
  for (const field of ["cursorEntry", "cursorCheckedAt", "accountEmail", "private@example.test", "accountId"])
    assert.equal(json.includes(field), false, field);
  assert.equal(route([row], { model: "grok4" }).newBuildPool, "cursor");
  const copied = grokRoute([{ ...row }]);
  assert.equal(copied.newBuildPool, null);
  assert.equal(copied.cursorReason, "usage_unknown", "spreading drops the private snapshot and fails closed");
  value.usage.secondary.usedPercent = 95;
  assert.equal(grokRoute([row]).cursorReason, "at_or_over_cap", "rechecks usage rather than cached eligibility");
});

test("Cursor stops at the default 90 percent cap and respects a custom cap", () => {
  assert.equal(CURSOR_INCLUDED_CAP, 0.90);
  for (const used of [90, 95]) {
    const row = cursorRow(used);
    assert.equal(row.mode, "included_cap_reached");
    assert.equal(row.reason, "at_or_over_cap");
    const r = grokRoute([row]);
    assert.equal(r.newBuildPool, null);
    assert.deepEqual(r.buildOrder, []);
    assert.equal(r.cursorReason, "at_or_over_cap");
  }
  assert.equal(grokRoute([cursorRow(60)], { cursorCap: 0.5 }).newBuildPool, null);
  assert.equal(grokRoute([cursorRow(95)], { cursorCap: 1 }).newBuildPool, "cursor");
  assert.equal(poolFor("cursor", entry(60, reset), now, { cursorCap: 0.5 }).mode, "included_cap_reached");
  assert.equal(cursorEligibility(entry(60, reset), { model: "grok", now }).capPercent, 90);
});

test("non-Grok models cannot build or burn on Cursor even as the only live pool", () => {
  for (const model of ["claude-opus-4", "sonnet", "gpt-5", "gemini-2.5-pro", "composer", "auto"]) {
    for (const resetsAt of [reset, "2026-10-17T20:00:00Z"]) {
      const r = route([cursorRow(0, resetsAt)], { model, now });
      assert.equal(r.newBuildPool, null, model);
      assert.deepEqual(r.buildOrder, []);
      assert.deepEqual(r.burnBacklogPools, []);
      assert.equal(r.cursorReason, "non_grok_model");
    }
  }
});

test("missing, invalid and stale Cursor usage and unknown models fail closed", () => {
  for (const value of [null, { error: { message: "failed" } }, { usage: {} },
    entry(1, "2026-10-16T00:00:00Z"), entry(1, "invalid"), entry(NaN, reset), entry(Infinity, reset), entry("0", reset)]) {
    const row = poolFor("cursor", value, now);
    assert.equal(row.mode, "unavailable");
    assert.equal(row.reason, "usage_unknown");
    const r = grokRoute([row]);
    assert.equal(r.newBuildPool, null);
    assert.equal(r.cursorReason, "usage_unknown");
  }
  const r = route([cursorRow(0)], { now });
  assert.equal(r.newBuildPool, null);
  assert.equal(r.cursorReason, "model_unknown");
});

test("on-demand pools and Cursor spend signals never enter build routing", () => {
  const rows = [
    { pool: "paid", mode: "build", onDemand: true },
    { pool: "cursor-on-demand", mode: "build" },
    { pool: "on_demand", mode: "burn_backlog" },
    { pool: "paid-mode", mode: "on_demand" },
    { pool: "paid-billing", mode: "build", billing: "usage-based" },
  ];
  const r = grokRoute(rows);
  assert.equal(r.newBuildPool, null);
  assert.deepEqual(r.buildOrder, []);
  assert.deepEqual(r.burnBacklogPools, []);
  for (const value of [entry(0, reset, { providerCost: { used: 1 } }),
    entry(0, reset, { providerCost: { spend: 0.5 } }), entry(100, reset)]) {
    const row = poolFor("cursor", value, now);
    assert.equal(row.mode, "on_demand_risk");
    assert.equal(row.reason, "on_demand_risk");
    const result = grokRoute([row]);
    assert.equal(result.cursorReason, "on_demand_risk");
    assert.equal(result.newBuildPool, null);
    assert.deepEqual(result.buildOrder, []);
  }
});

test("Cursor uses the current Total label, otherwise the maximum billing window", () => {
  const value = entry(10, reset, { primary: { usedPercent: 95, resetsAt: reset, windowMinutes: week } });
  value.rateWindowLabels = { primary: "Total", secondary: "Cursor" };
  assert.equal(cursorEligibility(value, { model: "grok", now }).includedUsedPercent, 95);
  assert.equal(grokRoute([poolFor("cursor", value, now)]).cursorReason, "at_or_over_cap");
  value.rateWindowLabels = { secondary: "Total" };
  assert.equal(cursorEligibility(value, { model: "grok", now }).includedUsedPercent, 10);
  delete value.rateWindowLabels;
  assert.equal(cursorEligibility(value, { model: "grok", now }).includedUsedPercent, 95);
  value.rateWindowLabels = { primary: "Total" };
  value.usage.primary.resetsAt = "2026-10-16T00:00:00Z";
  assert.equal(cursorEligibility(value, { model: "grok", now }).includedUsedPercent, 10);
});

test("Codex and Claude routing stays unchanged without a model", () => {
  const r = route([poolFor("codex", entry(10, reset), now), poolFor("claude", entry(97, reset), now)]);
  assert.equal(r.newBuildPool, "codex");
  assert.deepEqual(r.buildOrder, ["codex"]);
  assert.deepEqual(r.reviewOnlyPools, ["claude"]);
});

test("CLI forwards model, cap and saved Cursor usage and rejects invalid caps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-balancer-"));
  const originalLog = console.log;
  console.log = () => {};
  try {
    const file = join(dir, "usage.json");
    writeFileSync(file, JSON.stringify([{ ...entry(40, reset), provider: "cursor" }, { ...entry(80, reset), provider: "codex" }]));
    const args = ["--codexbar-json", file, "--model", "grok-4.6", "--now", new Date(now).toISOString(), "--providers", "cursor,codex"];
    const report = await main(args);
    assert.equal(report.routing.cursorEligible, true);
    assert.equal(report.routing.newBuildPool, "cursor");
    assert.equal(report.routing.model, "grok-4.6");
    assert.equal(report.routing.cursorCap, 0.90);
    const capped = await main([...args, "--cursor-cap", "0.3"]);
    assert.equal(capped.routing.cursorEligible, false);
    assert.equal(capped.routing.newBuildPool, "codex");
    for (const cap of ["0", "-1", "1.1", "NaN", "Infinity", ""]) await assert.rejects(main(["--cursor-cap", cap]), /--cursor-cap/);
    await assert.rejects(main(["--cursor-cap"]), /--cursor-cap/);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
