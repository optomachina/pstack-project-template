/**
 * Loader and validator for pstack.config.json, the project-owned settings the
 * template gates read (journey-test globs, auto-merge categories, preflight
 * stages, review thresholds). Globs use the sensitive-path matcher's syntax and
 * semantics (picomatch {dot, nocase}; *, **, ? and {a,b}) so every gate agrees
 * on what a path matches. Dependency-free so gates can run the base copy.
 *
 * Like the sensitive list, gates should read this file from the PR's base
 * (`loadPstackConfig({root, ref})`) so a PR cannot loosen its own gate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { globProblem, readRefFile } from "./sensitive-paths.mjs";

export const PSTACK_CONFIG_FILE = "pstack.config.json";
export const PSTACK_CONFIG_VERSION = 1;
export const PLACEHOLDER = /\{\{[A-Z_]+\}\}/;
export const DEFAULT_NA_PREFIX = "Journey test: N/A - ";
export const DEFAULT_BRANCH = "main";
/** A branch name safe to fill into workflow YAML and shell commands: git ref characters only, no "..". */
export const BRANCH_NAME = /^(?!.*\.\.)[A-Za-z0-9][\w./-]*$/;

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

function checkGlobs(where, value, problems, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (!isStringArray(value) || (required && value.length === 0)) {
    problems.push(`${where} must be ${required ? "a non-empty" : "an"} array of globs`);
    return;
  }
  for (const glob of value) {
    const problem = globProblem(glob);
    if (problem) problems.push(`${where}: ${problem}`);
  }
}

/** Validate a parsed or textual config; returns it with defaults filled in. Throws listing every problem. */
export function parsePstackConfig(input) {
  const config = typeof input === "string" ? JSON.parse(input) : input;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${PSTACK_CONFIG_FILE} must be an object`);
  const problems = [];
  if (config.version !== PSTACK_CONFIG_VERSION) problems.push(`version must be ${PSTACK_CONFIG_VERSION}`);
  if (typeof config.project?.name !== "string" || config.project.name.trim() === "") problems.push("project.name is required");
  if (typeof config.project?.owner !== "string" || config.project.owner.trim() === "") problems.push("project.owner is required");
  const handle = config.project?.ownerHandle;
  if (handle !== undefined && !(typeof handle === "string" && (PLACEHOLDER.test(handle) || /^@[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?$/.test(handle)))) problems.push("project.ownerHandle must be a GitHub @user or @org/team");
  const branch = config.project?.defaultBranch;
  if (branch !== undefined && !(typeof branch === "string" && (PLACEHOLDER.test(branch) || BRANCH_NAME.test(branch)))) problems.push("project.defaultBranch must be a branch name");

  const journey = config.journeyTests ?? {};
  checkGlobs("journeyTests.userVisible", journey.userVisible, problems, { required: true });
  checkGlobs("journeyTests.exclude", journey.exclude, problems);
  checkGlobs("journeyTests.journeyTests", journey.journeyTests, problems, { required: true });
  if (journey.naPrefix !== undefined && (typeof journey.naPrefix !== "string" || journey.naPrefix.trim() === "")) problems.push("journeyTests.naPrefix must be a non-empty string");

  const auto = config.autoMerge ?? { enabled: false, categories: [] };
  if (auto.excludeKeywords !== undefined && !isStringArray(auto.excludeKeywords)) problems.push("autoMerge.excludeKeywords must be an array of strings");
  const ids = new Set();
  for (const [index, category] of (Array.isArray(auto.categories) ? auto.categories : []).entries()) {
    const where = `autoMerge.categories[${index}]`;
    if (typeof category?.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(category.id)) problems.push(`${where}.id must be a lower_snake identifier`);
    else if (ids.has(category.id)) problems.push(`${where}.id ${category.id} is duplicated`);
    ids.add(category?.id);
    checkGlobs(`${where}.include`, category?.include, problems, { required: true });
    checkGlobs(`${where}.exclude`, category?.exclude, problems);
  }
  if (auto.categories !== undefined && !Array.isArray(auto.categories)) problems.push("autoMerge.categories must be an array");

  const stages = config.preflight?.stages;
  if (stages !== undefined && !isStringArray(stages)) problems.push("preflight.stages must be an array of npm script names");
  const confidence = config.review?.jevMinConfidence;
  if (confidence !== undefined && !(typeof confidence === "number" && confidence >= 0 && confidence <= 1)) problems.push("review.jevMinConfidence must be within [0, 1]");
  if (problems.length) throw new Error(`${PSTACK_CONFIG_FILE}: ${problems.join("; ")}`);

  return {
    ...config,
    journeyTests: { exclude: [], naPrefix: DEFAULT_NA_PREFIX, ...journey },
    autoMerge: { enabled: false, excludeKeywords: [], categories: [], ...auto },
    review: { jevMinConfidence: 0.5, ...config.review },
    preflight: { stages: ["typecheck", "lint", "test", "build"], required: ["test"], ...config.preflight },
  };
}

/** True while the config still carries template placeholders (the template repository itself). */
export function isTemplateConfig(config) {
  return PLACEHOLDER.test(config?.project?.name ?? "") || PLACEHOLDER.test(config?.project?.owner ?? "");
}

/** Read and validate pstack.config.json from the working tree or, with ref, from a commit (BaseRefError on a bad ref). */
export function loadPstackConfig({ root = process.cwd(), ref = null } = {}) {
  let text;
  if (ref !== null && ref !== undefined) {
    text = readRefFile(root, ref, PSTACK_CONFIG_FILE);
    if (text === null) throw new Error(`${PSTACK_CONFIG_FILE} not found at ${ref}`);
  } else {
    text = readFileSync(path.resolve(root, PSTACK_CONFIG_FILE), "utf8");
  }
  return parsePstackConfig(text);
}
