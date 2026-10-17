#!/usr/bin/env node
/**
 * Copy or update the pstack template's managed files into a target project.
 *
 *   node scripts/sync-template.mjs <target-dir> [--dry-run] [--project <name>] [--owner <name>] [--add-scripts]
 *
 * File modes (MANIFEST):
 *   managed  overwritten from the template. In Markdown and YAML files the
 *            content between `<!-- project:begin [id] -->` and
 *            `<!-- project:end [id] -->` lines is kept from the target (matched by id, or by position for
 *            unnamed blocks). A target block the template no longer has is kept
 *            at the end of the file and reported.
 *   seed     copied only when the target has none (pstack.config.json is
 *            project-owned and never overwritten).
 *   union    docs/sensitive-paths.json: the template's classes and globs are
 *            added when missing; nothing in the target is removed or
 *            reclassified (adding is free, removing loosens the gate).
 * After copying, the PROJECT, OWNER and DEFAULT_BRANCH placeholders in Markdown
 * and workflow files are filled from the target's pstack.config.json (when it
 * has real values), the AGENTS.md
 * sensitive-paths block is regenerated from the target's list, and
 * .pstack-template-version records the template version, commit and file hashes.
 *
 * --project/--owner fill a freshly seeded pstack.config.json. --add-scripts adds
 * the pstack npm scripts to the target package.json without replacing any
 * existing script. Symlinked target files are never written.
 * Exit codes: 0 synced (or dry run), 2 usage error.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokedAsScript, parseSensitivePaths, replaceAgentsSensitiveBlock } from "./lib/sensitive-paths.mjs";

export const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = ".pstack-template-version";
export const PROJECT_BEGIN = /<!-- project:begin(?:\s+([\w.-]+))?\s*-->/;
export const PROJECT_END = /<!-- project:end(?:\s+([\w.-]+))?\s*-->/;
/** Files whose project blocks are kept and whose placeholders are filled; everything else is copied verbatim. */
const PROSE = /\.(?:md|ya?ml)$/;

// The sync script itself stays in the template: run it from here against a target.
export const MANIFEST = Object.freeze([
  { path: "AGENTS.md", mode: "managed" },
  { path: "CLAUDE.md", mode: "managed" },
  { path: "pstack.config.json", mode: "seed" },
  { path: "docs/sensitive-paths.json", mode: "union" },
  { path: "docs/agent-graph.md", mode: "managed" },
  { path: "docs/runbooks/pr-lifecycle.md", mode: "managed" },
  { path: "docs/runbooks/review-gates.md", mode: "managed" },
  { path: "docs/runbooks/repair-budget.md", mode: "managed" },
  { path: "docs/runbooks/merge-and-rollback.md", mode: "managed" },
  { path: "docs/runbooks/branch-protection.md", mode: "managed" },
  { path: ".github/workflows/ci.yml", mode: "managed" },
  { path: ".github/workflows/pr-body-gate.yml", mode: "managed" },
  { path: ".github/pull_request_template.md", mode: "managed" },
  { path: "scripts/preflight.sh", mode: "managed" },
  { path: "scripts/preflight.node-test.mjs", mode: "managed" },
  { path: "scripts/lib/sensitive-paths.mjs", mode: "managed" },
  { path: "scripts/lib/sensitive-paths.node-test.mjs", mode: "managed" },
  { path: "scripts/lib/pstack-config.mjs", mode: "managed" },
  { path: "scripts/fixtures/sensitive-paths/paths.json", mode: "managed" },
  { path: "scripts/sensitive-paths-report.mjs", mode: "managed" },
  { path: "scripts/sensitive-paths-report.node-test.mjs", mode: "managed" },
  { path: "scripts/validate-agent-contract.mjs", mode: "managed" },
  { path: "scripts/validate-agent-contract.node-test.mjs", mode: "managed" },
  { path: "scripts/jev-client.mjs", mode: "managed" },
  { path: "scripts/review-gate.mjs", mode: "managed" },
  { path: "scripts/review-gate.node-test.mjs", mode: "managed" },
  { path: "scripts/check-journey-tests.mjs", mode: "managed" },
  { path: "scripts/check-journey-tests.node-test.mjs", mode: "managed" },
  { path: "scripts/check-pr-body.mjs", mode: "managed" },
  { path: "scripts/check-pr-body.node-test.mjs", mode: "managed" },
]);

/** npm scripts --add-scripts adds when the target lacks them. */
export const PSTACK_SCRIPTS = Object.freeze({
  preflight: "bash scripts/preflight.sh",
  "pstack:test": "node --test scripts/*-test.mjs scripts/lib/*-test.mjs",
  "agent-contract": "node scripts/validate-agent-contract.mjs",
  "sensitive-paths:report": "node scripts/sensitive-paths-report.mjs",
  "sensitive-paths:render": "node scripts/lib/sensitive-paths.mjs render-agents",
  "review-gate": "node scripts/review-gate.mjs",
  "journey-tests:check": "node scripts/check-journey-tests.mjs",
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Split text into project blocks: [{id, key, body}] where key is the id or
 * "#<n>" for the n-th unnamed block, and body is the lines strictly between
 * the markers. Throws on nested or unbalanced markers.
 */
export function parseProjectBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let open = null;
  let unnamed = 0;
  lines.forEach((line, index) => {
    const begin = PROJECT_BEGIN.exec(line);
    const end = PROJECT_END.exec(line);
    if (begin) {
      if (open) throw new Error(`nested project:begin at line ${index + 1}`);
      const id = begin[1] ?? null;
      open = { id, key: id ?? `#${unnamed++}`, start: index };
    } else if (end) {
      if (!open) throw new Error(`project:end without project:begin at line ${index + 1}`);
      if (end[1] && open.id && end[1] !== open.id) throw new Error(`project:end ${end[1]} closes project:begin ${open.id} at line ${index + 1}`);
      blocks.push({ id: open.id, key: open.key, start: open.start, end: index, body: lines.slice(open.start + 1, index).join("\n") });
      open = null;
    }
  });
  if (open) throw new Error(`project:begin ${open.key} at line ${open.start + 1} is never closed`);
  return blocks;
}

/**
 * The template text with each project block's body taken from the target.
 * Returns {text, orphans} where orphans are target block keys the template
 * lacks (appended to the end of the file so nothing project-specific is lost).
 */
export function mergeProjectBlocks(templateText, targetText) {
  if (targetText === null || targetText === undefined) return { text: templateText, orphans: [] };
  const targetBlocks = new Map(parseProjectBlocks(targetText).map((block) => [block.key, block]));
  const templateBlocks = parseProjectBlocks(templateText);
  const lines = templateText.split("\n");
  // Replace from the bottom so earlier indexes stay valid.
  for (const block of [...templateBlocks].reverse()) {
    const kept = targetBlocks.get(block.key);
    if (!kept) continue;
    lines.splice(block.start + 1, block.end - block.start - 1, ...(kept.body === "" ? [] : kept.body.split("\n")));
  }
  const templateKeys = new Set(templateBlocks.map((block) => block.key));
  const orphans = [...targetBlocks.values()].filter((block) => !templateKeys.has(block.key));
  let text = lines.join("\n");
  if (orphans.length) {
    const targetLines = targetText.split("\n");
    const appended = orphans.map((block) => targetLines.slice(block.start, block.end + 1).join("\n")).join("\n");
    text = `${text.replace(/\n*$/, "")}\n\n${appended}\n`;
  }
  return { text, orphans: orphans.map((block) => block.key) };
}

/** Add the template's missing classes and globs to the target list; never removes or reclassifies. */
export function unionSensitivePaths(templateText, targetText) {
  const template = parseSensitivePaths(templateText);
  if (targetText === null || targetText === undefined) return { text: templateText, added: template.globs.map((entry) => entry.glob) };
  const target = JSON.parse(targetText);
  const added = [];
  target.classes = target.classes ?? {};
  target.globs = target.globs ?? [];
  for (const [name, entry] of Object.entries(template.classes)) if (!Object.hasOwn(target.classes, name)) target.classes[name] = entry;
  const have = new Set(target.globs.map((entry) => entry.glob));
  for (const entry of template.globs) {
    if (have.has(entry.glob)) continue;
    target.globs.push({ ...entry });
    added.push(entry.glob);
  }
  parseSensitivePaths(target);
  return { text: added.length ? `${JSON.stringify(target, null, 2)}\n` : targetText, added };
}

/** Fill {{PROJECT}}, {{OWNER}}, {{DEFAULT_BRANCH}} from a config whose values are real (not placeholders). */
export function fillPlaceholders(text, config) {
  const values = { PROJECT: config?.project?.name, OWNER: config?.project?.owner, DEFAULT_BRANCH: config?.project?.defaultBranch };
  return text.replaceAll(/\{\{(PROJECT|OWNER|DEFAULT_BRANCH)\}\}/g, (whole, key) => {
    const value = values[key];
    return typeof value === "string" && value.trim() !== "" && !/\{\{/.test(value) ? value : whole;
  });
}

function templateCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function readIfExists(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Plan (and unless dryRun, apply) a sync. Returns {actions: [{path, action, note?}], warnings, version}.
 * action is create | update | unchanged | kept (seed present) | skipped (symlink).
 */
export function syncTemplate({ target, templateRoot = TEMPLATE_ROOT, dryRun = false, project = null, owner = null, addScripts = false, now = new Date() }) {
  const targetRoot = path.resolve(target);
  if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) throw new Error(`target ${targetRoot} is not a directory`);
  if (realpathSync(targetRoot) === realpathSync(templateRoot)) throw new Error("target is the template repository itself");
  const pkg = JSON.parse(readFileSync(path.join(templateRoot, "package.json"), "utf8"));
  const actions = [];
  const warnings = [];
  const outputs = new Map();
  const isSymlink = (file) => {
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  };

  // 1. Compute every output from the template and the target's current files.
  for (const entry of MANIFEST) {
    const source = readFileSync(path.join(templateRoot, entry.path), "utf8");
    const destination = path.join(targetRoot, entry.path);
    const current = readIfExists(destination);
    let next;
    if (entry.mode === "seed") {
      if (current !== null) next = current;
      else {
        const seeded = JSON.parse(source);
        if (project) seeded.project.name = project;
        if (owner) seeded.project.owner = owner;
        next = `${JSON.stringify(seeded, null, 2)}\n`;
      }
    } else if (entry.mode === "union") {
      const merged = unionSensitivePaths(source, current);
      if (current !== null && merged.added.length) warnings.push(`${entry.path}: added ${merged.added.length} template glob(s): ${merged.added.join(", ")}`);
      next = merged.text;
    } else if (!PROSE.test(entry.path)) {
      // Code and fixtures are template-owned verbatim; their strings may contain markers.
      next = source;
    } else {
      const merged = mergeProjectBlocks(source, current);
      for (const key of merged.orphans) warnings.push(`${entry.path}: project block ${key} is not in the template; kept at the end of the file`);
      next = merged.text;
    }
    outputs.set(entry.path, { entry, current, next, destination });
  }

  // 2. Placeholders and the AGENTS.md sensitive block come from the target's own config and list.
  const config = JSON.parse(outputs.get("pstack.config.json").next);
  const sensitive = parseSensitivePaths(outputs.get("docs/sensitive-paths.json").next);
  for (const output of outputs.values()) {
    if (output.entry.mode !== "managed") continue;
    // Only prose and workflow files: scripts and tests mention the placeholders literally.
    if (PROSE.test(output.entry.path)) output.next = fillPlaceholders(output.next, config);
    if (output.entry.path === "AGENTS.md") output.next = replaceAgentsSensitiveBlock(output.next, sensitive);
  }

  // 3. Write.
  const hashes = {};
  for (const { entry, current, next, destination } of outputs.values()) {
    hashes[entry.path] = sha256(next);
    if (isSymlink(destination)) {
      actions.push({ path: entry.path, action: "skipped", note: "symlink" });
      warnings.push(`${entry.path}: target is a symlink; not written`);
      continue;
    }
    const action = current === null ? "create" : current === next ? (entry.mode === "seed" ? "kept" : "unchanged") : "update";
    actions.push({ path: entry.path, action });
    if (!dryRun && (action === "create" || action === "update")) {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, next);
      if (entry.path.endsWith(".sh")) execFileSync("chmod", ["+x", destination]);
    }
  }

  if (addScripts) {
    const pkgPath = path.join(targetRoot, "package.json");
    const targetPkgText = readIfExists(pkgPath);
    if (targetPkgText === null) warnings.push("package.json: not found; --add-scripts skipped");
    else {
      const targetPkg = JSON.parse(targetPkgText);
      targetPkg.scripts = targetPkg.scripts ?? {};
      const added = Object.entries(PSTACK_SCRIPTS).filter(([name]) => !Object.hasOwn(targetPkg.scripts, name));
      for (const [name, command] of added) targetPkg.scripts[name] = command;
      actions.push({ path: "package.json", action: added.length ? "update" : "unchanged", note: added.length ? `scripts: ${added.map(([name]) => name).join(", ")}` : undefined });
      if (!dryRun && added.length) writeFileSync(pkgPath, `${JSON.stringify(targetPkg, null, 2)}\n`);
    }
  }

  const version = { template: pkg.name, version: pkg.version, commit: templateCommit(templateRoot), synced_at: now.toISOString(), files: hashes };
  const versionPath = path.join(targetRoot, VERSION_FILE);
  actions.push({ path: VERSION_FILE, action: existsSync(versionPath) ? "update" : "create" });
  if (!dryRun) writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`);
  return { actions, warnings, version };
}

const USAGE = "usage: sync-template.mjs <target-dir> [--dry-run] [--project <name>] [--owner <name>] [--add-scripts]";

export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const options = { dryRun: false, addScripts: false, project: null, owner: null, target: null };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--add-scripts") options.addScripts = true;
    else if (arg === "--project" || arg === "--owner") {
      if (!argv[k + 1]) {
        stderr(`sync-template: ${arg} needs a value; ${USAGE}`);
        return 2;
      }
      options[arg.slice(2)] = argv[++k];
    } else if (arg.startsWith("--") || options.target !== null) {
      stderr(`sync-template: unexpected argument ${arg}; ${USAGE}`);
      return 2;
    } else options.target = arg;
  }
  if (!options.target) {
    stderr(`sync-template: ${USAGE}`);
    return 2;
  }
  try {
    const { actions, warnings, version } = syncTemplate(options);
    for (const { path: file, action, note } of actions) stdout(`${action.padEnd(9)} ${file}${note ? ` (${note})` : ""}`);
    for (const warning of warnings) stdout(`warning: ${warning}`);
    stdout(`sync-template: ${options.dryRun ? "dry run, nothing written" : "synced"} ${version.template}@${version.version}${version.commit ? ` (${version.commit.slice(0, 12)})` : ""}`);
    if (!options.dryRun) stdout("sync-template: next run `node scripts/validate-agent-contract.mjs` and `npm run preflight` in the target");
    return 0;
  } catch (error) {
    stderr(`sync-template: ${error.message}`);
    return 2;
  }
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main();
}
