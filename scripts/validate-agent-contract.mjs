#!/usr/bin/env node
/**
 * Agent-contract validator. Fails when AGENTS.md drifts from the sources it
 * mirrors or loses a required rule:
 *   - AGENTS.md stays within its size budget and keeps every required section;
 *   - CLAUDE.md stays a thin pointer to AGENTS.md;
 *   - the AGENTS.md sensitive-paths list equals docs/sensitive-paths.json, both directions;
 *   - pstack.config.json is valid and every auto-merge category id appears in AGENTS.md;
 *   - project:begin / project:end markers are balanced;
 *   - outside the template repository, no {{PLACEHOLDER}} remains.
 *
 * Usage: node scripts/validate-agent-contract.mjs [--root <dir>]
 * Exit codes: 0 valid, 1 contract errors.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isTemplateConfig, parsePstackConfig, PLACEHOLDER, PSTACK_CONFIG_FILE } from "./lib/pstack-config.mjs";
import { SENSITIVE_PATHS_FILE, checkAgentsParity, invokedAsScript, parseSensitivePaths } from "./lib/sensitive-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AGENTS_MAX_BYTES = 24 * 1024;
export const CLAUDE_MAX_BYTES = 2 * 1024;
/** Headings AGENTS.md must keep (matched as "## <heading>" prefixes). */
export const REQUIRED_SECTIONS = Object.freeze([
  "Standing development authorization",
  "Protected actions",
  "Low-risk auto-merge",
  "Sensitive paths",
  "Ownership",
  "Small PRs",
  "Preflight and repair budget",
  "Risk-sized review",
  "Journey tests",
  "Completion and failure",
]);
/** Rules whose wording other gates and runbooks depend on. */
export const REQUIRED_PHRASES = Object.freeze([
  "2 repair rounds",
  "Journey test: N/A - ",
  "npm run preflight",
  "scripts/validate-agent-contract.mjs",
  "Never convert skipped",
]);

export function validateAgentContract(repoRoot = root) {
  const errors = [];
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(repoRoot, name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        errors.push(`${name} is missing`);
        return null;
      }
      throw error;
    }
  };
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");
  const sensitiveText = read(SENSITIVE_PATHS_FILE);
  const configText = read(PSTACK_CONFIG_FILE);

  if (agents !== null) {
    if (Buffer.byteLength(agents) > AGENTS_MAX_BYTES) errors.push(`AGENTS.md exceeds the ${AGENTS_MAX_BYTES / 1024} KiB budget`);
    for (const section of REQUIRED_SECTIONS) {
      if (!new RegExp(`^##+ ${section.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(agents)) errors.push(`AGENTS.md missing section: ${section}`);
    }
    for (const phrase of REQUIRED_PHRASES) if (!agents.includes(phrase)) errors.push(`AGENTS.md missing: ${phrase}`);
    const begins = agents.match(/<!-- project:begin[^>]*-->/g)?.length ?? 0;
    const ends = agents.match(/<!-- project:end[^>]*-->/g)?.length ?? 0;
    if (begins !== ends) errors.push(`AGENTS.md has ${begins} project:begin and ${ends} project:end markers`);
  }
  if (claude !== null) {
    if (Buffer.byteLength(claude) > CLAUDE_MAX_BYTES) errors.push("CLAUDE.md is no longer a thin pointer");
    if (!claude.includes("AGENTS.md")) errors.push("CLAUDE.md must point to AGENTS.md");
  }

  let sensitivePaths = null;
  if (sensitiveText !== null) {
    try {
      sensitivePaths = parseSensitivePaths(sensitiveText);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (sensitivePaths && agents !== null) errors.push(...checkAgentsParity(agents, sensitivePaths));

  let config = null;
  if (configText !== null) {
    try {
      config = parsePstackConfig(configText);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (config && agents !== null) {
    for (const category of config.autoMerge.categories) {
      if (!agents.includes(`\`${category.id}\``)) errors.push(`auto-merge category ${category.id} (${PSTACK_CONFIG_FILE}) is not described in AGENTS.md`);
    }
    if (!isTemplateConfig(config)) {
      for (const [name, text] of [["AGENTS.md", agents], ["CLAUDE.md", claude]]) {
        const found = text?.match(new RegExp(PLACEHOLDER.source, "g"));
        if (found) errors.push(`${name} still has template placeholders: ${[...new Set(found)].join(", ")}`);
      }
    }
  }
  return errors;
}

if (invokedAsScript(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  const errors = validateAgentContract(index === -1 ? root : path.resolve(process.argv[index + 1] ?? "."));
  if (errors.length) {
    for (const error of errors) console.error(`agent-contract: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("agent-contract: valid");
  }
}
