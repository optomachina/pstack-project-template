#!/usr/bin/env node
/**
 * Usage balancer: one JSON report on the coding usage pools (Codex, Claude,
 * Cursor) plus Jev, with pace and the routing mode each pool is in now.
 *
 * Usage pools come from CodexBar's CLI (`codexbar usage --provider <p> --format json`),
 * one provider per call with a timeout, or from saved CodexBar JSON
 * (--codexbar-json <file>, repeatable; the freshest entry per provider wins).
 * Jev (TypeSafe System One) has no published quota or reset, so its pool is
 * tracked from call ledgers (--jev-log <jsonl>, repeatable): calls, tokens and
 * 429/529 throttling in the last 7 days. --jev-probe makes one synthetic call
 * through ../jev-client.mjs (configured by JEV_ENDPOINT / JEV_API_KEY) and
 * appends the result to the first --jev-log. Read-only otherwise; it never
 * reads or prints credentials (CodexBar and jev-client own them).
 *
 *   node scripts/usage-balancer/usage-balancer.mjs [--providers codex,claude,cursor]
 *     [--source claude=web]... [--codexbar-json f]... [--jev-log f]... [--jev-probe]
 *     [--timeout-s 40] [--now ISO] [--model grok-4.6] [--cursor-cap 0.90] [--cursor-max-age-h 6]
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_INCLUDED_CAP = 0.90;
export const CURSOR_MAX_AGE_HOURS = 6;
export const REVIEW_ONLY_PERCENT = 90;
export const BURN_WINDOW_HOURS = 24;
export const ON_PACE_BAND = 3; // percentage points
export const JEV_FIRST_WORK = ["screening", "triage", "small_fix_screen", "draft_screen", "review_screen"];
const HOUR = 3_600_000;
const PROBE_MIN_GAP_MS = 15 * 60_000; // at most one capacity probe per 15 minutes

/** Pace of one rate window at `now`: elapsed fraction, target and ahead/behind. */
export function paceFor(window, now) {
  if (!window || !Number.isFinite(window.usedPercent) || !window.resetsAt || !window.windowMinutes) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return null; // unparsable, or the window already reset (stale data)
  const lengthMs = window.windowMinutes * 60_000;
  const elapsed = Math.min(1, Math.max(0, 1 - (resetMs - now) / lengthMs));
  const target = Math.round(elapsed * 1000) / 10;
  const delta = Math.round((window.usedPercent - target) * 10) / 10;
  const pace = Math.abs(delta) <= ON_PACE_BAND ? "on_pace" : delta > 0 ? "ahead" : "behind";
  return { usedPercent: window.usedPercent, resetsAt: new Date(resetMs).toISOString(), resetsAtLocal: local(resetMs),
    windowMinutes: window.windowMinutes, elapsedFraction: Math.round(elapsed * 1000) / 1000, paceTargetPercent: target,
    deltaPercent: delta, pace, hoursToReset: Math.round(((resetMs - now) / HOUR) * 10) / 10 };
}

const local = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** Pick the long (budget) window and the short (5-hour) window from one CodexBar provider entry. */
export function windowsOf(entry, now = Date.now()) {
  const u = entry?.usage ?? {};
  const all = [u.primary, u.secondary, u.tertiary].filter((w) => w && Number.isFinite(w.windowMinutes) && paceFor(w, now));
  const budget = all.filter((w) => w.windowMinutes >= 7 * 24 * 60).sort((a, b) => a.windowMinutes - b.windowMinutes)[0] ?? null;
  const short = all.find((w) => w.windowMinutes <= 300) ?? null;
  return { budget, short };
}

/** Only a complete, unambiguous Grok model name authorizes Cursor billing. */
export const isGrokModel = (model) => typeof model === "string" && model.trim().length <= 64 &&
  /^(?:xai\/|x-ai\/)?grok(?:[0-9][0-9a-z]*)?(?:[-_.][0-9a-z]+)*$/i.test(model.trim()) &&
  !/claude|opus|sonnet|haiku|gpt|gemini|composer|auto|o\d|llama|deepseek|qwen|mistral/i.test(model);
const validCap = (cap) => Number.isFinite(cap) && cap > 0 && cap <= 1;
const validMaxAge = (hours) => Number.isFinite(hours) && hours > 0;
const providerName = (name) => String(name ?? "").trim().toLowerCase();
const demandLabel = /on[-_ ]?demand|usage[-_ ]?based/i;
const onDemand = (row) => row?.onDemand === true || /^(cursor[-_]on[-_]demand|on[-_]demand)$/i.test(providerName(row?.pool)) || demandLabel.test(`${row?.mode ?? ""} ${row?.billing ?? ""}`);
const spendRisk = (value) => value && typeof value === "object" && Object.entries(value).some(([key, v]) =>
  /used|spend|spent|cost|amount/i.test(key)
    ? !Number.isFinite(v) || v < 0 || v > 0
    : v && typeof v === "object" && spendRisk(v));
const windowKeys = ["primary", "secondary", "tertiary"];

/** Included allowance only; retain the original windows on pool rows for rechecking. */
export function cursorEligibility(row, { model, cap = CURSOR_INCLUDED_CAP, cursorMaxAgeHours = CURSOR_MAX_AGE_HOURS, now = row?.cursorCheckedAt ?? Date.now() } = {}) {
  if (!validCap(cap)) throw new Error("cursor cap must be a fraction greater than 0 and at most 1");
  if (!validMaxAge(cursorMaxAgeHours)) throw new Error("cursor max age must be positive finite hours");
  const entry = row?.cursorEntry ?? row;
  const u = entry?.usage;
  const present = windowKeys.filter((key) => u?.[key] !== undefined);
  const totalKeys = Object.keys(entry?.rateWindowLabels ?? {}).filter((key) => /^total$/i.test(entry.rateWindowLabels[key]));
  const validWindow = (w) => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 &&
    Number.isFinite(w.windowMinutes) && w.windowMinutes >= 10080 && paceFor(w, now);
  const selected = totalKeys.length ? totalKeys : present.filter((key) => validWindow(u[key]));
  const malformed = totalKeys.length ? totalKeys.some((key) => !validWindow(u?.[key])) :
    present.some((key) => !Number.isFinite(u[key]?.usedPercent) || u[key].usedPercent < 0 ||
      !Number.isFinite(u[key].windowMinutes) || !Number.isFinite(Date.parse(u[key].resetsAt)));
  const includedUsedPercent = !malformed && selected.length ? Math.max(...selected.map((key) => u[key].usedPercent)) : null;
  const result = (reason) => ({ eligible: reason === "ok", reason, includedUsedPercent, capPercent: cap * 100 });
  if (typeof model !== "string" || !model.trim()) return result("model_unknown");
  if (!isGrokModel(model)) return result("non_grok_model");
  const labelledWindows = [
    ...present.map((key) => ({ window: u[key], label: entry?.rateWindowLabels?.[key] ?? "" })),
    ...(Array.isArray(u?.extraRateWindows) ? u.extraRateWindows.map((w) => ({
      window: w?.window ?? w, label: `${entry?.rateWindowLabels?.[w?.id] ?? ""} ${w?.title ?? ""} ${w?.id ?? ""}`,
    })) : []),
  ];
  if (onDemand(row) || spendRisk(u?.providerCost) || spendRisk(entry?.providerCost) ||
    Object.entries(u ?? {}).some(([key, value]) => demandLabel.test(key) &&
      (typeof value === "object" ? spendRisk(value) : !Number.isFinite(value) || value < 0 || value > 0)) ||
    labelledWindows.some(({ window: w, label }) => demandLabel.test(label) &&
      (!Number.isFinite(w?.usedPercent) || w.usedPercent > 0)) ||
    present.some((key) => Number.isFinite(u[key]?.usedPercent) && u[key].usedPercent >= 100)) return result("on_demand_risk");
  const updated = Date.parse(u?.updatedAt);
  if (!entry || entry.error || includedUsedPercent === null || !Number.isFinite(now) ||
    !Number.isFinite(updated) || now - updated > cursorMaxAgeHours * HOUR || updated - now > 5 * 60_000) return result("usage_unknown");
  return result(includedUsedPercent >= Math.round(cap * 1e6) / 1e4 - 1e-9 ? "at_or_over_cap" : "ok");
}

/** One pool row: pace plus the routing mode (unavailable, review_only, burn_backlog, build). */
export function poolFor(provider, entry, now, { cursorCap = CURSOR_INCLUDED_CAP, cursorMaxAgeHours = CURSOR_MAX_AGE_HOURS } = {}) {
  provider = providerName(provider);
  if (provider === "cursor") {
    const eligibility = cursorEligibility(entry, { model: "grok", cap: cursorCap, cursorMaxAgeHours, now });
    const { budget, short } = windowsOf(entry, now);
    const totalKey = Object.keys(entry?.rateWindowLabels ?? {}).find((key) => /^total$/i.test(entry.rateWindowLabels[key]));
    const pace = paceFor(totalKey !== undefined ? entry?.usage?.[totalKey] : budget, now);
    const shortPace = paceFor(short, now);
    const mode = !eligibility.eligible ? eligibility.reason === "usage_unknown" ? "unavailable" : eligibility.reason === "on_demand_risk" ? "on_demand_risk" : "included_cap_reached"
      : pace.hoursToReset <= BURN_WINDOW_HOURS ? "burn_backlog" : "build";
    const row = { pool: provider, plan: entry?.usage?.loginMethod ?? null, source: entry?.source ?? null,
      updatedAt: entry?.usage?.updatedAt ?? null, ...pace, coolingDown: shortPace ? shortPace.usedPercent >= REVIEW_ONLY_PERCENT : false,
      fiveHour: shortPace, mode, reason: eligibility.reason,
      includedUsedPercent: eligibility.includedUsedPercent, capPercent: eligibility.capPercent };
    return Object.defineProperties(row, {
      cursorEntry: { value: entry, enumerable: false },
      cursorCheckedAt: { value: now, enumerable: false },
      cursorCap: { value: cursorCap, enumerable: false },
    });
  }
  if (!entry || entry.error) return { pool: provider, mode: "unavailable", reason: entry?.error?.message?.slice(0, 160) ?? "no data" };
  const { budget, short } = windowsOf(entry, now);
  const pace = paceFor(budget, now);
  if (!pace) return { pool: provider, mode: "unavailable", reason: "no current budget window (missing or already reset)" };
  const shortPace = paceFor(short, now);
  let mode = "build";
  if (pace.usedPercent >= REVIEW_ONLY_PERCENT) mode = "review_only";
  else if (pace.hoursToReset <= BURN_WINDOW_HOURS && pace.usedPercent < 100) mode = "burn_backlog";
  const coolingDown = shortPace ? shortPace.usedPercent >= REVIEW_ONLY_PERCENT : false;
  return { pool: provider, plan: entry.usage?.loginMethod ?? null, source: entry.source ?? null, mode, coolingDown,
    updatedAt: entry.usage?.updatedAt ?? null, ...pace, fiveHour: shortPace };
}

/** Jev capacity from ledger lines: calls, tokens and throttling over the last 7 days. */
export function jevPool(lines, now, configured) {
  const week = lines.filter((l) => Date.parse(l.ts) > now - 7 * 24 * HOUR && Date.parse(l.ts) <= now);
  const recent = week.filter((l) => Date.parse(l.ts) > now - HOUR);
  const throttled = recent.some((l) => /http_(429|529)/.test(String(l.reason ?? "")));
  const tok = (k) => week.reduce((s, l) => s + (Number(l.usage?.[k]) || 0), 0);
  const failures = recent.filter((l) => l.ok === false).length;
  const last = [...recent].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1);
  const failing = last?.ok === false && !throttled; // e.g. http_401 or a timeout on the latest call this hour
  const mode = !configured ? "unavailable" : throttled ? "throttled" : failing ? "failing" : "first";
  return { pool: "jev", mode, configured, quota: "none published; rate limited (429/529)", calls7d: week.length,
    okCalls7d: week.filter((l) => l.ok !== false).length, inputTokens7d: tok("input_tokens"), outputTokens7d: tok("output_tokens"),
    failuresLastHour: failures, lastCallAt: week.map((l) => l.ts).sort().at(-1) ?? null, handles: JEV_FIRST_WORK };
}

/** The routing decision across pools (see README for the rule text). */
export function route(pools, { model, cursorCap = CURSOR_INCLUDED_CAP, cursorMaxAgeHours = CURSOR_MAX_AGE_HOURS, now } = {}) {
  if (!validCap(cursorCap)) throw new Error("cursor cap must be a fraction greater than 0 and at most 1");
  const isCursor = (p) => providerName(p.pool) === "cursor";
  const checks = pools.filter(isCursor).map((p) => cursorEligibility(p, {
    model, cap: Math.min(p.cursorCap ?? cursorCap, cursorCap), cursorMaxAgeHours,
    ...(now === undefined ? {} : { now }),
  }));
  const cursor = checks.find((check) => !check.eligible) ?? checks[0] ?? { eligible: false, reason: "usage_unknown" };
  const live = pools.filter((p) => p.mode !== "unavailable" && !onDemand(p) && (!isCursor(p) || cursor.eligible))
    .map((p) => isCursor(p) && p.mode === "included_cap_reached" ?
      { ...p, mode: p.hoursToReset <= BURN_WINDOW_HOURS ? "burn_backlog" : "build" } : p);
  const behindFirst = (a, b) => a.deltaPercent - b.deltaPercent;
  const builders = live.filter((p) => p.mode === "build" && !p.coolingDown).sort(behindFirst);
  const burn = live.filter((p) => p.mode === "burn_backlog").sort(behindFirst);
  const fallback = burn.filter((p) => !p.coolingDown);
  return { cursorEligible: cursor.eligible, cursorReason: cursor.reason, cursorExcluded: !cursor.eligible, newBuildPool: builders[0]?.pool ?? fallback[0]?.pool ?? null, buildOrder: builders.map((p) => p.pool),
    burnBacklogPools: burn.map((p) => p.pool), reviewOnlyPools: live.filter((p) => p.mode === "review_only").map((p) => p.pool),
    coolingDownPools: live.filter((p) => p.coolingDown).map((p) => p.pool), unavailablePools: pools.filter((p) => p.mode === "unavailable").map((p) => p.pool) };
}

function codexbar(provider, timeoutS, source) {
  const args = ["usage", "--provider", provider, "--format", "json", ...(source ? ["--source", source] : [])];
  return new Promise((resolve) => {
    execFile("codexbar", args, { timeout: timeoutS * 1000, maxBuffer: 8 << 20 }, (error, stdout) => {
      try { resolve(JSON.parse(stdout).find((e) => e.provider === provider) ?? null); }
      catch { resolve({ provider, error: { message: error?.killed ? `codexbar timed out after ${timeoutS}s` : "codexbar returned no JSON" } }); }
    });
  });
}

const readJsonl = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
  try { const v = JSON.parse(l); return v && typeof v === "object" && !Array.isArray(v) && Number.isFinite(Date.parse(v.ts)) ? [v] : []; } catch { return []; }
}) : []);

function parseArgs(argv) {
  const opts = { providers: ["codex", "claude", "cursor"], codexbarJson: [], jevLog: [], jevProbe: false, sources: {}, timeoutS: 40, model: undefined, cursorCap: CURSOR_INCLUDED_CAP, cursorMaxAgeHours: CURSOR_MAX_AGE_HOURS, now: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--providers") opts.providers = v().split(",").map(providerName);
    else if (a === "--codexbar-json") opts.codexbarJson.push(v());
    else if (a === "--jev-log") opts.jevLog.push(v());
    else if (a === "--source") { const [p, src] = v().split("="); opts.sources[providerName(p)] = src; }
    else if (a === "--jev-probe") opts.jevProbe = true;
    else if (a === "--timeout-s") opts.timeoutS = Number(v());
    else if (a === "--model") opts.model = v();
    else if (a === "--cursor-cap") { opts.cursorCap = Number(v()); if (!validCap(opts.cursorCap)) throw new Error("--cursor-cap must be a fraction greater than 0 and at most 1"); }
    else if (a === "--cursor-max-age-h") { opts.cursorMaxAgeHours = Number(v()); if (!validMaxAge(opts.cursorMaxAgeHours)) throw new Error("--cursor-max-age-h must be positive finite hours"); }
    else if (a === "--now") { opts.now = Date.parse(v()); if (!Number.isFinite(opts.now)) throw new Error("--now must be a parseable finite date"); }
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const saved = opts.codexbarJson.flatMap((f) => { try { return [JSON.parse(readFileSync(f, "utf8"))].flat(); } catch { return []; } });
  const entries = await Promise.all(opts.providers.map(async (p) => {
    const fromFiles = saved.filter((e) => providerName(e.provider) === p && !e.error).sort((a, b) => String(b.usage?.updatedAt).localeCompare(String(a.usage?.updatedAt)))[0];
    return fromFiles ?? (opts.codexbarJson.length ? null : await codexbar(p, opts.timeoutS, opts.sources[p]));
  }));
  let jev = null, probeError = null;
  try { jev = await import("../jev-client.mjs"); } catch { probeError = "jev_client_unavailable"; }
  const lastProbe = Math.max(0, ...readJsonl(opts.jevLog[0]).filter((l) => l.kind === "usage_balancer_probe").map((l) => Date.parse(l.ts)));
  if (opts.jevProbe && !opts.jevLog[0]) probeError = "probe_needs_jev_log";
  else if (opts.jevProbe && opts.now - lastProbe <= PROBE_MIN_GAP_MS) probeError = "probe_skipped_recent";
  if (jev && opts.jevProbe && opts.jevLog[0] && opts.now - lastProbe > PROBE_MIN_GAP_MS) {
    try {
      const r = await jev.askJev({ task: "usage-balancer capacity probe" }, { alive: { type: "noul", instructions: "Is `task` a capacity probe?" } });
      mkdirSync(dirname(opts.jevLog[0]), { recursive: true });
      appendFileSync(opts.jevLog[0], JSON.stringify({ ts: new Date(opts.now).toISOString(), kind: "usage_balancer_probe", ok: r.ok, reason: r.ok ? null : r.reason, usage: r.usage ?? null, latencyMs: r.latencyMs }) + "\n");
    } catch (error) { probeError = `probe_failed_${error?.code ?? "error"}`; }
  }
  const pools = opts.providers.map((p, i) => poolFor(p, entries[i], opts.now, opts));
  const jevRow = { ...jevPool(opts.jevLog.flatMap(readJsonl), opts.now, jev?.isJevConfigured() ?? false), probeError };
  const report = { generatedAt: new Date(opts.now).toISOString(), jev: jevRow, pools, routing: { jevFirst: jevRow.mode === "first", model: opts.model ?? null, cursorCap: opts.cursorCap, cursorMaxAgeHours: opts.cursorMaxAgeHours, ...route(pools, opts) } };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(`usage-balancer: ${error.message}`); process.exitCode = 2; });
}
