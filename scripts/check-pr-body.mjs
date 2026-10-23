#!/usr/bin/env node
/**
 * PR body gate: the PR body carries the evidence AGENTS.md asks for, in the
 * shape .github/pull_request_template.md lays out. Text inside HTML comments
 * is ignored, so the template's prompts never satisfy the gate.
 *
 * Required (case-insensitive, one per line):
 *   preflight: <stage> PASS|SKIP     at least one, and no "preflight: <stage> FAIL"
 *   Journey test: <spec path, run URL, or "N/A - <reason>">
 *   Review tier: jev|sonnet|opus
 *   Sensitive classes: none | <class>, <class> ...
 *
 * With --review-gate-json (the deterministic review-gate output for this PR,
 * computed from the base copy of the gate), a sensitive PR must declare
 * "Review tier: opus" and list every sensitive class the gate found.
 *
 * Usage: node scripts/check-pr-body.mjs --body-file <file> [--review-gate-json <file>]
 *        (or the body in PR_BODY)
 * Exit codes: 0 valid, 1 problems found, 2 usage error.
 */
import { readFileSync } from "node:fs";

import { stripHtmlComments } from "./check-journey-tests.mjs";
import { invokedAsScript } from "./lib/sensitive-paths.mjs";

export const TIERS = ["jev", "sonnet", "opus"];
const PLACEHOLDER = /^(?:<.*>|\.\.\.|tbd|todo|-|)$/i;

/** The value after "<label>:" on its own line (optional bullet or bold), or null. */
function field(text, label) {
  // [ \t] rather than \s after the label, so an empty field never captures the next line.
  const pattern = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?${label}(?:\\*\\*)?[ \\t]*:(?:\\*\\*)?[ \\t]*(.*)$`, "im");
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

/** Problems with a PR body; review, when given, is a review-gate decision. */
export function checkPrBody(body, review = null) {
  const text = stripHtmlComments(body);
  const problems = [];

  const stages = [...text.matchAll(/^\s*(?:[-*]\s+)?preflight: (\S+) (PASS|FAIL|SKIP)\b/gim)];
  if (!stages.some((match) => /^(PASS|SKIP)$/i.test(match[2]))) problems.push('no "preflight: <stage> PASS" lines (paste the npm run preflight stage lines)');
  for (const match of stages.filter((item) => /^FAIL$/i.test(item[2]))) problems.push(`preflight stage ${match[1]} is FAIL`);

  const journey = field(text, "Journey test");
  if (journey === null || PLACEHOLDER.test(journey)) problems.push('missing "Journey test: <spec or run URL | N/A - reason>"');
  else if (/^n\/a\b/i.test(journey) && !/^n\/a\s*[-–—:]\s*\S.{2,}/i.test(journey)) problems.push('"Journey test: N/A" needs " - <reason>"');

  const allowedLegacy = ['schema','files','problems','sensitive','deterministic','jev','risk','review_tier','reviews_required','auto_merge','pr_size','config_sources'];
  if (review && review.schema !== 'review-gate.v2' && Object.keys(review).some(k=>!allowedLegacy.includes(k))) problems.push('unknown legacy review field');
  const isV2 = review?.schema === "review-gate.v2";
  if (review?.schema && !["review-gate.v1", "review-gate.v2"].includes(review.schema)) problems.push("unknown review-gate schema");
  const tierText = field(text, "Review tier");
  const tier = tierText?.toLowerCase().match(/^(jev|sonnet|opus)\b/)?.[1] ?? null;
  if (!isV2 && !tier) problems.push('missing "Review tier: jev|sonnet|opus"');

  const classesText = field(text, "Sensitive classes");
  let classes = null;
  if (classesText === null || PLACEHOLDER.test(classesText)) problems.push('missing "Sensitive classes: none | <class>, ..."');
  else classes = /^none\b/i.test(classesText) ? [] : classesText.split(/[,\s]+/).map((name) => name.replaceAll("`", "").trim().toLowerCase()).filter(Boolean);

  if (review?.sensitive?.sensitive) {
    if (!isV2 && tier && tier !== "opus") problems.push(`the review gate found sensitive classes (${review.sensitive.classes.join(", ")}), so the review tier must be opus, not ${tier}`);
    const missing = classes ? review.sensitive.classes.filter((name) => !classes.includes(name)) : [];
    if (missing.length) problems.push(`"Sensitive classes" is missing: ${missing.join(", ")}`);
  }
  if (!isV2 && review && tier && TIERS.indexOf(tier) < TIERS.indexOf(review.review_tier) && review.jev?.status === "accepted") {
    problems.push(`declared review tier ${tier} is below the gate's ${review.review_tier}`);
  }
  if (isV2) problems.push(...checkCapabilityBody(text, review));
  return problems;
}

export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error, env = process.env } = {}) {
  let bodyFile = null;
  let reviewFile = null;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--body-file" && argv[k + 1]) bodyFile = argv[++k];
    else if (argv[k] === "--review-gate-json" && argv[k + 1]) reviewFile = argv[++k];
    else {
      stderr(`pr-body: unknown option or missing value ${argv[k]}`);
      return 2;
    }
  }
  try {
    const body = bodyFile ? readFileSync(bodyFile, "utf8") : (env.PR_BODY ?? "");
    const review = reviewFile ? JSON.parse(readFileSync(reviewFile, "utf8")) : null;
    const problems = checkPrBody(body, review);
    if (problems.length) {
      stdout("pr-body: FAIL");
      for (const problem of problems) stdout(`  ${problem}`);
      return 1;
    }
    stdout("pr-body: PASS");
    return 0;
  } catch (error) {
    stderr(`pr-body: ${error.message}`);
    return 2;
  }
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main();
}

/** V2 references must agree with the base-validated receipt set; links alone confer no approval. */
function checkCapabilityBody(text, review) {
  const errors=[];
  if(field(text,'Review tier')!==null) errors.push('v2 must not relabel a capability receipt as a legacy review tier');
  if(review.status!=='consistent'||review.completion?.status!=='accepted')errors.push('v2 completion evidence is not accepted');
  if(field(text,'Review risk')!==review.risk)errors.push('Review risk must match the base gate');
  const ids=(field(text,'Review obligations')??'').split(/[,\s]+/).filter(Boolean);
  const required=(review.obligations??[]).map(s=>s.id);
  if(ids.join(',')!==required.join(',')&&!(required.length===0&&ids.join(',')==='none'))errors.push('Review obligations must match the base gate');
  if(field(text,'Review policy')!==review.policy_digest)errors.push('Review policy must match the base digest');
  for(const receipt of review.receipt_refs??[]) {
    const prefix=`Review receipt: ${receipt.id} ${receipt.digest} `;
    if(!text.split(/\r?\n/).some(line=>line.startsWith(prefix)&&/^(?:https:\/\/|artifact:)/.test(line.slice(prefix.length))))errors.push(`missing genuine completion receipt reference: ${receipt.id}`);
  }
  return errors;
}
