import assert from "node:assert/strict";
import { test } from "node:test";

import { jevPool, paceFor, poolFor, route } from "./usage-balancer/usage-balancer.mjs";

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
});

test("new builds go to the build pool furthest behind pace", () => {
  const pools = [
    poolFor("codex", entry(81, "2026-10-22T06:21:42Z"), now),
    poolFor("claude", entry(97, "2026-10-17T22:00:00Z"), now),
    { ...poolFor("cursor", entry(0, "2026-11-01T00:00:00Z"), now) },
    poolFor("burner", entry(50, "2026-10-17T20:00:00Z"), now),
  ];
  const r = route(pools);
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
});
