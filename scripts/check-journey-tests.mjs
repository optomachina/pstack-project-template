#!/usr/bin/env node
/**
 * Journey-test rule: every user-visible change adds or updates a journey test
 * that drives the real UI (ported from OverDrafter's journey rule).
 *
 * A PR fails when it changes a user-visible path (pstack.config.json
 * journeyTests.userVisible, minus journeyTests.exclude) without adding or
 * modifying a file under journeyTests.journeyTests, unless its body carries a
 * waiver line outside HTML comments:
 *
 *   Journey test: N/A - <reason>
 *
 * The reason must be real text (not empty, not a "<placeholder>"). Deleting a
 * journey test does not count as updating one. The config is read from
 * --base-ref when given (the PR base), so a PR cannot narrow its own globs.
 *
 * Usage:
 *   node scripts/check-journey-tests.mjs --changed-files-from <name-status>
 *        [--body-file <file> | (PR_BODY env)] [--base-ref <ref>] [--json-out <file>] [--root <dir>]
 * Exit codes: 0 pass, not-applicable or waived; 1 fail; 2 usage or input error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadPstackConfig, PSTACK_CONFIG_FILE } from "./lib/pstack-config.mjs";
import { globMatcher, invokedAsScript, parseNameStatus, readRefFile } from "./lib/sensitive-paths.mjs";

export const JOURNEY_SCHEMA = "journey-tests.v1";

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const stripHtmlComments = (text) => String(text ?? "").replaceAll(/<!--[\s\S]*?(?:-->|$)/g, "");

/** The waiver reason in a PR body, or null. Accepts "-", en or em dash after N/A and an optional list bullet. */
export function findWaiver(body, naPrefix = "Journey test: N/A - ") {
  const label = naPrefix.replace(/\s*[-–—]\s*$/, "").trim();
  const pattern = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[-–—:]\\s*(.+)$`, "im");
  for (const line of stripHtmlComments(body).split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    const reason = match[1].trim();
    if (reason.length >= 3 && !/^<.*>$/.test(reason) && !/^(n\/?a|none|tbd|todo)$/i.test(reason)) return reason;
  }
  return null;
}

/**
 * Evaluate the rule. changes: [{status, file}] (parseNameStatus output).
 * @returns {{schema, status: "pass"|"fail"|"waived"|"not-applicable", userVisible: string[], journeyTests: string[], waiver: string|null, reasons: string[]}}
 */
export function checkJourneyTests({ changes, body = "", config }) {
  const journey = config.journeyTests;
  const isJourney = globMatcher(journey.journeyTests);
  const isVisible = globMatcher(journey.userVisible);
  const isExcluded = globMatcher(journey.exclude ?? []);
  const userVisible = changes.filter((change) => isVisible(change.file) && !isExcluded(change.file) && !isJourney(change.file)).map((change) => change.file);
  const journeyTests = changes.filter((change) => change.status !== "D" && isJourney(change.file)).map((change) => change.file);
  const base = { schema: JOURNEY_SCHEMA, userVisible, journeyTests, waiver: null };
  if (userVisible.length === 0) return { ...base, status: "not-applicable", reasons: ["no user-visible paths changed"] };
  if (journeyTests.length > 0) return { ...base, status: "pass", reasons: journeyTests.map((file) => `journey test changed: ${file}`) };
  const waiver = findWaiver(body, journey.naPrefix);
  if (waiver) return { ...base, waiver, status: "waived", reasons: [`waived: ${waiver}`] };
  return {
    ...base,
    status: "fail",
    reasons: [
      `user-visible change without a journey test change (${journey.journeyTests.join(", ")})`,
      `add or update a journey test that drives the real UI, or add "${journey.naPrefix}<reason>" to the PR body`,
      `user-visible files: ${userVisible.join(", ")}`,
    ],
  };
}

export function formatResult(result) {
  const label = { pass: "PASS", fail: "FAIL", waived: "WAIVED", "not-applicable": "NOT APPLICABLE" }[result.status];
  return [`journey-tests: ${label}`, ...result.reasons.map((reason) => `  ${reason}`)].join("\n");
}

function parseArgs(argv) {
  const options = {};
  const flags = new Map([
    ["--changed-files-from", "changedFilesFrom"],
    ["--body-file", "bodyFile"],
    ["--base-ref", "baseRef"],
    ["--json-out", "jsonOut"],
    ["--root", "root"],
  ]);
  for (let k = 0; k < argv.length; k += 1) {
    if (!flags.has(argv[k]) || argv[k + 1] === undefined) throw new Error(`unknown option or missing value: ${argv[k]}`);
    options[flags.get(argv[k])] = argv[k + 1];
    k += 1;
  }
  if (!options.changedFilesFrom) throw new Error("--changed-files-from is required");
  if (options.baseRef !== undefined && (options.baseRef === "" || options.baseRef.startsWith("-"))) throw new Error("--base-ref needs a ref");
  return options;
}

export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error, env = process.env } = {}) {
  try {
    const options = parseArgs(argv);
    const root = path.resolve(options.root ?? process.cwd());
    // Base copy of the config when the base has one; head copy only for the PR that introduces it.
    const useBase = options.baseRef !== undefined && readRefFile(root, options.baseRef, PSTACK_CONFIG_FILE) !== null;
    const config = loadPstackConfig({ root, ref: useBase ? options.baseRef : null });
    const changes = parseNameStatus(readFileSync(path.resolve(root, options.changedFilesFrom), "utf8"));
    const body = options.bodyFile ? readFileSync(path.resolve(root, options.bodyFile), "utf8") : (env.PR_BODY ?? "");
    const result = { ...checkJourneyTests({ changes, body, config }), config_source: useBase ? "base" : "head" };
    if (options.jsonOut) writeFileSync(path.resolve(root, options.jsonOut), `${JSON.stringify(result, null, 2)}\n`);
    stdout(formatResult(result));
    return result.status === "fail" ? 1 : 0;
  } catch (error) {
    stderr(`journey-tests: ${error.message}`);
    return 2;
  }
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main();
}
