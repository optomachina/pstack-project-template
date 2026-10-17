#!/usr/bin/env node
/**
 * Risk-sized review gate (generalized from OverDrafter's Jev PR screen).
 *
 * Given a PR's changed files, it outputs:
 *   - review_tier: "jev" | "sonnet" | "opus", the highest reviewer the PR needs.
 *     Every PR gets the Jev screen first (when configured). A low-risk PR stops
 *     after Jev, a normal PR adds Sonnet, a risky PR adds Opus.
 *   - auto_merge: whether every file falls in a low-risk auto-merge category
 *     (pstack.config.json autoMerge.categories) with no sensitive path, plus the
 *     non-deterministic conditions that must still hold at the current head.
 *
 * Tier rules (risk can only go up; nothing here lowers it):
 *   deterministic = risky  when any file matches docs/sensitive-paths.json, the
 *                          list cannot be loaded, or the file list is empty;
 *                   low    when every file is in an auto-merge category;
 *                   normal otherwise.
 *   jev           = the accepted Jev tier; a failed, uncertain, or unconfigured
 *                   screen counts as "normal", so "low" (and the jev-only tier)
 *                   needs a confident Jev answer.
 *   risk          = max(deterministic, jev); low -> jev, normal -> sonnet, risky -> opus.
 *
 * The sensitive list and pstack.config.json come from --base-ref (the PR base,
 * for example HEAD^1 on a pull_request merge checkout) so a PR cannot loosen its
 * own gate. A base ref that does not resolve fails closed (risky, no auto-merge).
 * The head copies are used only when the base has none (the PR that adds them).
 *
 * Usage:
 *   node scripts/review-gate.mjs [--base-ref <ref>] [--changed-files-from <name-status>]
 *        [--numstat-from <numstat>] [--title <t>] [--no-jev] [--json-out <file>]
 *        [--log <jsonl>] [--root <dir>] [path ...]
 * Every value flag also takes --flag=value (use it for --title, which may start with "-").
 * Exit codes: 0 report produced (the gate is advisory; CI decides what to do
 * with review_tier), 2 usage or input error.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { askJev, gatedChoice, sanitizeToken } from "./jev-client.mjs";
import { PSTACK_CONFIG_FILE, parsePstackConfig } from "./lib/pstack-config.mjs";
import {
  SENSITIVE_PATHS_FILE,
  BASE_REF_UNAVAILABLE,
  classifyPaths,
  globMatcher,
  invokedAsScript,
  normalizePath,
  parseNameStatus,
  parseSensitivePaths,
  readRefFile,
  readSensitivePathsText,
} from "./lib/sensitive-paths.mjs";

export const REVIEW_GATE_SCHEMA = "review-gate.v1";
export const TIERS = ["low", "normal", "risky"];
export const REVIEW_TIER = Object.freeze({ low: "jev", normal: "sonnet", risky: "opus" });
export const REVIEW_CHAIN = Object.freeze({ jev: ["jev"], sonnet: ["jev", "sonnet"], opus: ["jev", "sonnet", "opus"] });
/** What auto-merge still needs after this gate's deterministic checks pass. */
export const AUTO_MERGE_REMAINING = Object.freeze([
  "hosted CI (required checks) green at the current head",
  "sized review passed with no open actionable findings",
  "journey test or QA evidence recorded for user-visible changes",
  "PR is not a draft and its body passes pr-body",
]);

export const SCREEN_QUESTIONS = {
  tier: {
    type: "choice",
    instructions: "Classify the review risk of this pull request. Consider blast radius, security, data, money, external integrations, CI and deploy.",
    criteria: {
      low: "Docs, tests, UI polish, or isolated tooling with no runtime, security, data or money effect.",
      normal: "Runtime code with bounded blast radius and good tests; no auth, schema, migrations, secrets, money, deploy or external integration semantics.",
      risky: "Touches auth, SQL, migrations, secrets, billing, deploy, CI gates, external integrations, or guardrails other agents rely on.",
    },
  },
  incident: {
    type: "noul",
    instructions: "Probability that merging this PR as is causes a production incident, security exposure, or a silently weakened safety gate.",
  },
};

export const maxTier = (a, b) => (TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a);

/** Combine the deterministic tier with a gated Jev answer. Jev may only raise risk; anything but an accepted answer counts as normal. */
export function finalTier(deterministic, gate) {
  const base = TIERS.includes(deterministic) ? deterministic : "risky";
  const jevTier = gate?.status === "accepted" && TIERS.includes(gate.choice) ? gate.choice : "normal";
  return maxTier(base, jevTier);
}

/**
 * The auto-merge category of each file (null when none applies). A file whose
 * path contains an excluded keyword (auth, billing ...) never qualifies.
 */
export function categorize(paths, pstackConfig) {
  const auto = pstackConfig.autoMerge;
  const keywords = (auto.excludeKeywords ?? []).map((word) => word.toLowerCase());
  const categories = (auto.categories ?? []).map((category) => ({ id: category.id, include: globMatcher(category.include), exclude: globMatcher(category.exclude ?? []) }));
  return paths.map((file) => {
    const lower = file.toLowerCase();
    if (keywords.some((word) => lower.includes(word))) return { path: file, category: null, reason: "excluded keyword" };
    const hit = categories.find((category) => category.include(file) && !category.exclude(file));
    return { path: file, category: hit?.id ?? null, reason: hit ? null : "no category" };
  });
}

/** Changed lines from `git diff --numstat` text, skipping excluded globs and binary rows. */
export function countChangedLines(numstatText, excludeGlobs = []) {
  const excluded = globMatcher(excludeGlobs);
  let total = 0;
  for (const line of String(numstatText).split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match || match[1] === "-" || excluded(match[3])) continue;
    total += Number(match[1]) + Number(match[2]);
  }
  return total;
}

/**
 * The deterministic part of the decision. sensitivePaths and pstackConfig are
 * parsed configs, or null when they could not be loaded (fail closed).
 */
export function decide({ files, sensitivePaths, pstackConfig, gate = { status: "not_configured" }, changedLines = null }) {
  const paths = [...new Set((files ?? []).map(normalizePath))].filter(Boolean);
  const problems = [];
  if (paths.length === 0) problems.push("no changed files (a failed fetch looks like this)");
  if (!sensitivePaths) problems.push(`${SENSITIVE_PATHS_FILE} unavailable`);
  if (!pstackConfig) problems.push(`${PSTACK_CONFIG_FILE} unavailable`);

  const sensitive = sensitivePaths && paths.length ? classifyPaths(paths, sensitivePaths) : { sensitive: false, classes: [], files: [] };
  const categorized = pstackConfig ? categorize(paths, pstackConfig) : paths.map((file) => ({ path: file, category: null, reason: "config unavailable" }));
  const allCategorized = paths.length > 0 && categorized.every((entry) => entry.category);

  let deterministic = "normal";
  if (problems.length || sensitive.sensitive) deterministic = "risky";
  else if (allCategorized) deterministic = "low";
  const risk = finalTier(deterministic, gate);
  const reviewTier = REVIEW_TIER[risk];

  const blockers = [...problems];
  if (pstackConfig && !pstackConfig.autoMerge.enabled) blockers.push("autoMerge.enabled is false");
  if (sensitive.sensitive) blockers.push(`sensitive classes: ${sensitive.classes.join(", ")}`);
  for (const entry of categorized.filter((item) => !item.category)) blockers.push(`${entry.path}: ${entry.reason}`);
  if (risk === "risky") blockers.push("risk tier is risky (Opus review and owner approval required)");
  const maxLines = pstackConfig?.prSize?.maxChangedLines;
  const overSize = Number.isInteger(changedLines) && Number.isInteger(maxLines) && changedLines > maxLines;

  return {
    schema: REVIEW_GATE_SCHEMA,
    files: paths.length,
    problems,
    sensitive: { sensitive: sensitive.sensitive, classes: sensitive.classes, files: sensitive.files.filter((file) => file.classes.length).map(({ path: file, classes }) => ({ path: file, classes })) },
    deterministic,
    jev: { status: gate.status, tier: TIERS.includes(gate.choice) ? gate.choice : null, confidence: typeof gate.confidence === "number" ? gate.confidence : null },
    risk,
    review_tier: reviewTier,
    reviews_required: [...REVIEW_CHAIN[reviewTier]],
    auto_merge: {
      eligible: [...new Set(blockers)].length === 0,
      categories: Object.fromEntries(categorized.filter((entry) => entry.category).map((entry) => [entry.path, entry.category])),
      blockers: [...new Set(blockers)],
      remaining_conditions: [...AUTO_MERGE_REMAINING],
    },
    pr_size: { changed_lines: changedLines, max: maxLines ?? null, over: overSize },
  };
}

/** Load the base (or, when the base has none, head) copy of a config file. Returns {text, source} or {error}. */
function loadGateFile(root, baseRef, file) {
  try {
    if (baseRef !== null && baseRef !== undefined) {
      const text = readRefFile(root, baseRef, file);
      if (text !== null) return { text, source: "base" };
    }
    const text = readSensitivePathsText({ root, file });
    return text === null ? { error: `${file} not found` } : { text, source: "head" };
  } catch (error) {
    return { error: error.message };
  }
}

export function loadGateConfigs({ root, baseRef = null }) {
  const sensitiveFile = loadGateFile(root, baseRef, SENSITIVE_PATHS_FILE);
  const configFile = loadGateFile(root, baseRef, PSTACK_CONFIG_FILE);
  const out = { sensitivePaths: null, pstackConfig: null, sources: {}, errors: [] };
  for (const [key, file, parse] of [["sensitivePaths", sensitiveFile, parseSensitivePaths], ["pstackConfig", configFile, parsePstackConfig]]) {
    if (file.error) {
      out.errors.push(file.error);
      continue;
    }
    try {
      out[key] = parse(file.text);
      out.sources[key] = file.source;
    } catch (error) {
      out.errors.push(error.message);
    }
  }
  return out;
}

/** Run the gate end to end. ask defaults to the (inert unless configured) Jev client. */
export async function runReviewGate({ root = process.cwd(), baseRef = null, files, title = "", changedLines = null, useJev = true, ask = askJev, env = process.env }) {
  const legacyProblem = await legacyPolicyProblem(root, baseRef);
  if (legacyProblem) return blockedCapabilityGate(legacyProblem);
  const configs = loadGateConfigs({ root, baseRef });
  let gate = { status: "not_configured" };
  if (useJev) {
    const result = await ask({ title, files, changedLines }, SCREEN_QUESTIONS, { env, timeoutMs: 20_000 });
    gate = gatedChoice(result, "tier", configs.pstackConfig?.review?.jevMinConfidence ?? 0.5);
    if (result?.ok && typeof result.answers?.incident?.noul === "number") gate.pIncident = result.answers.incident.noul;
  } else {
    gate = { status: "skipped" };
  }
  const decision = decide({ files, sensitivePaths: configs.sensitivePaths, pstackConfig: configs.pstackConfig, gate, changedLines });
  decision.problems.push(...configs.errors);
  decision.config_sources = configs.sources;
  if (gate.pIncident !== undefined) decision.jev.p_incident = gate.pIncident;
  if (gate.reason) decision.jev.reason = sanitizeToken(gate.reason, env);
  return decision;
}

export function formatDecision(decision) {
  if (decision.schema === "review-gate.v2") return `review-gate.v2: ${decision.status}; ${decision.reason}; obligations ${(decision.obligations ?? []).map(s => s.id).join(", ")}`;
  const lines = [
    `review-gate: ${decision.files} file(s), risk ${decision.risk} (deterministic ${decision.deterministic}, jev ${decision.jev.status}${decision.jev.tier ? ` ${decision.jev.tier}@${decision.jev.confidence}` : ""})`,
    `review-gate: review tier ${decision.review_tier} (${decision.reviews_required.join(" -> ")})`,
  ];
  if (decision.sensitive.sensitive) lines.push(`review-gate: sensitive classes ${decision.sensitive.classes.join(", ")}`);
  for (const file of decision.sensitive.files) lines.push(`  ${file.path}: ${file.classes.join(", ")}`);
  lines.push(`review-gate: auto-merge ${decision.auto_merge.eligible ? "eligible (pending remaining conditions)" : "not eligible"}`);
  for (const blocker of decision.auto_merge.blockers) lines.push(`  blocker: ${blocker}`);
  for (const problem of decision.problems) lines.push(`review-gate: problem: ${problem}`);
  if (decision.pr_size.over) lines.push(`review-gate: PR has ${decision.pr_size.changed_lines} changed lines (guideline ${decision.pr_size.max}); state why it cannot be split`);
  return lines.join("\n");
}

const USAGE = "usage: review-gate.mjs [--base-ref <ref>] [--changed-files-from <file>] [--numstat-from <file>] [--title <t>] [--no-jev] [--json-out <file>] [--log <jsonl>] [--root <dir>] [path ...]";

export function parseArgs(argv) {
  const options = { paths: [], useJev: true, baseRef: null, contract: "v1" };
  const valueFlags = new Map([
    ["--base-ref", "baseRef"],
    ["--contract", "contract"],
    ["--changed-files-from", "changedFilesFrom"],
    ["--numstat-from", "numstatFrom"],
    ["--title", "title"],
    ["--json-out", "jsonOut"],
    ["--log", "log"],
    ["--root", "root"],
  ]);
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    // --flag=value keeps a value that starts with "-" (a PR title, say) from reading as an option.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (arg === "--no-jev") options.useJev = false;
    else if (valueFlags.has(flag)) {
      const value = eq === -1 ? argv[k + 1] : arg.slice(eq + 1);
      if (value === undefined || (flag === "--base-ref" && (value === "" || value.startsWith("-")))) throw new Error(`${flag} needs a value; ${USAGE}`);
      options[valueFlags.get(flag)] = value;
      if (eq === -1) k += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}; ${USAGE}`);
    else options.paths.push(arg);
  }
  if (!["v1", "v2"].includes(options.contract)) throw new Error("unknown review contract");
  return options;
}

export async function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error, ask = askJev, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`review-gate: ${error.message}`);
    return 2;
  }
  const root = path.resolve(options.root ?? process.cwd());
  let files = options.paths;
  let changedLines = null;
  try {
    if (options.changedFilesFrom) files = [...files, ...parseNameStatus(readFileSync(path.resolve(root, options.changedFilesFrom), "utf8")).map((change) => change.file)];
    if (options.numstatFrom) {
      const config = loadGateConfigs({ root, baseRef: options.baseRef }).pstackConfig;
      changedLines = countChangedLines(readFileSync(path.resolve(root, options.numstatFrom), "utf8"), config?.prSize?.exclude ?? []);
    }
  } catch (error) {
    stderr(`review-gate: ${error.message}`);
    return 2;
  }
  const decision = options.contract === "v2"
    ? await runReviewGateV2({ root, baseRef: options.baseRef, files, changedLines })
    : await runReviewGate({ root, baseRef: options.baseRef, files, title: options.title ?? "", changedLines, useJev: options.useJev, ask, env });
  if (options.jsonOut) writeFileSync(path.resolve(root, options.jsonOut), `${JSON.stringify(decision, null, 2)}\n`);
  if (options.log) appendFileSync(path.resolve(root, options.log), `${JSON.stringify({ ts: new Date().toISOString(), ...decision })}\n`);
  stdout(formatDecision(decision));
  return decision.schema === "review-gate.v2" && decision.status === "blocked" ? 1 : 0;
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = await main();
}

/** Explicit inactive v2 entrypoint. Adoption and completion contexts must be authenticated by the caller. */
export async function runReviewGateV2({root,baseRef,headRef='HEAD',files,gate={status:'not_configured'},changedLines=null,
  routingInput=null,adoption=null,completion=null,now}={}) {
  const fail=blockedCapabilityGate;
  try {
    const policyApi=await import('./lib/review-policy.mjs');
    const {digest,resolveRoutingV2}=await import('./lib/model-routing.mjs');
    const {validateReviewCompletions}=await import('./lib/review-completion.mjs');
    const loaded=policyApi.loadBaseReviewPolicy({root,baseRef});
    if(!adoption||!policyApi.validateReviewTransition({...adoption,policy:loaded.policy,now}))return fail('transition_authority_required');
    // The adoption head must already belong to this committed base history.
    const {execFileSync}=await import('node:child_process');
    execFileSync('git',['merge-base','--is-ancestor',adoption.transition.headSha,baseRef],{cwd:root,stdio:'pipe'});
    const revision=checkRevisionBinding({root,baseRef,headRef,routingInput,adoption},execFileSync,digest);
    if(typeof revision==='string')return fail(revision);
    const sensitiveText=readRefFile(root,baseRef,SENSITIVE_PATHS_FILE), configText=readRefFile(root,baseRef,PSTACK_CONFIG_FILE);
    if(sensitiveText===null||configText===null)return fail('base_configuration_missing');
    const pstackConfig=parsePstackConfig(configText);
    const d=decide({files:revision.files,sensitivePaths:parseSensitivePaths(sensitiveText),pstackConfig,gate,
      changedLines:countChangedLines(revision.numstat,pstackConfig.prSize?.exclude??[])});
    const risk={low:'low',normal:'moderate',risky:'high'}[d.risk];
    const obligations=loaded.policy.reviewRules.find(r=>r.risk===risk)?.slots;
    if(!obligations)return fail('missing_risk_rule');
    const {review_tier,reviews_required,...common}=d;
    const result={...common,schema:'review-gate.v2',status:'blocked',reason:'binding_required',policy_digest:loaded.digest,
      policy_version:loaded.policy.version,obligations,binding_plan:null,completion:null,receipt_refs:[],config_sources:{sensitivePaths:'base',pstackConfig:'base',reviewPolicy:'base'}};
    result.auto_merge={...d.auto_merge,eligible:false,blockers:d.auto_merge.blockers.map(b=>b.replace('Opus review','deep review'))};
    if(!policyApi.matchesBaseReviewPolicy(loaded.policy,routingInput)||routingInput.trustedContext?.risk!==risk)return result;
    if(routingInput.trustedContext.reviewSubject?.kind!=='existing_artifact')return {...result,reason:'exact_artifact_required'};
    result.binding_plan=resolveRoutingV2(routingInput);
    if(result.binding_plan.status!=='planned')return {...result,reason:result.binding_plan.reason};
    if(!completion)return {...result,reason:'completion_required'};
    result.completion=validateReviewCompletions({...completion,plan:result.binding_plan,now});
    if(result.completion.status!=='accepted')return {...result,reason:result.completion.reason};
    result.receipt_refs=completion.receipts.map(r=>({id:r.id,digest:digest(r)}));
    return {...result,status:'consistent',reason:'base_governed_declarations_consistent',auto_merge:d.auto_merge};
  } catch {return fail('invalid_base_policy_or_authority');}
}

function checkRevisionBinding({root,baseRef,headRef,routingInput,adoption},execFileSync,digest) {
    const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const head=git('rev-parse','--verify','--end-of-options',`${headRef}^{commit}`).trim();
    const base=git('rev-parse','--verify','--end-of-options',`${baseRef}^{commit}`).trim();
    const treeSha=git('rev-parse',`${head}^{tree}`).trim();
    const patch=digest(git('diff','--binary','--no-ext-diff',base,head));
    const adoptionPatch=digest(git('diff','--binary','--no-ext-diff',adoption.transition.baseSha,adoption.transition.headSha));
    if(adoption.transition.patchDigest!==adoptionPatch)return 'transition_patch_mismatch';
    if(routingInput&&['policy','trustedContext','request'].some(k=>routingInput[k]?.repoId!==adoption.transition.repoId))return 'repository_binding_mismatch';
    if(routingInput&&(routingInput.trustedContext?.sourceSha!==head||routingInput.trustedContext?.baseSha!==base||
      routingInput.trustedContext?.diffDigest!==patch||routingInput.trustedContext?.artifactDigest!==digest({treeSha})))return 'stale_revision_binding';
    // Disabling rename detection retains deleted sources and added destinations.
    const files=git('diff','--name-only','-z','--no-renames','--no-ext-diff',base,head).split('\0').filter(Boolean);
    const numstat=git('diff','--numstat','--no-renames','--no-ext-diff',base,head);
    return {files,numstat};
}

function blockedCapabilityGate(reason) {
  return {schema:'review-gate.v2',status:'blocked',reason,policy_digest:null,
    obligations:[],binding_plan:null,completion:null,receipt_refs:[],auto_merge:{eligible:false}};
}

async function legacyPolicyProblem(root,baseRef) {
  if(baseRef===null||baseRef===undefined)return null;
  try {
    const text=readRefFile(root,baseRef,'docs/review-policy.json');
    if(text===null)return null; // An unchanged consumer's explicitly legacy base.
    const policy=JSON.parse(text),{validateV2}=await import('./lib/model-routing.mjs');
    if(!validateV2('reviewPolicy',policy).valid)return 'invalid_base_review_policy';
    return policy.enabled?'adopted_policy_requires_v2':null;
  } catch(error) {return error.code===BASE_REF_UNAVAILABLE?null:'base_review_policy_unavailable';}
}
