#!/usr/bin/env node
/** Check staged blobs (default), or an explicit base/head commit pair. */
import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { globMatcher, invokedAsScript, resolveCommit } from "./lib/sensitive-paths.mjs";

export const MAX_BYTES = 5_000 * 4;
export const ALLOWLIST = ".file-size-allowlist.json";
const ZERO = /^0+$/;

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root, input, maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function blob(root, spec) {
  return git(root, ["cat-file", "blob", spec]);
}

function configBlob(root, ref) {
  const entry = git(root, ["ls-tree", "-z", ref, "--", ALLOWLIST]);
  return entry.length ? blob(root, `${ref}:${ALLOWLIST}`) : null;
}

export function checkFileSizes({ root = process.cwd(), baseRef, headRef, emptyBase = false } = {}) {
  if (emptyBase && baseRef !== undefined) throw new Error("--empty-base and --base-ref are mutually exclusive");
  const staged = headRef === undefined;
  const head = staged ? null : resolveCommit(root, headRef);
  let base;
  if (emptyBase) base = null;
  else if (baseRef !== undefined) base = resolveCommit(root, baseRef);
  else if (!staged) throw new Error("--head-ref requires --base-ref or --empty-base");
  else {
    const hasHead = git(root, ["rev-parse", "--revs-only", "HEAD"]).toString().trim();
    base = hasHead ? resolveCommit(root, "HEAD") : null;
  }
  const comparison = base ?? git(root, ["mktree"], "").toString().trim();
  // Policy comes from the base; only its introducing commit uses the candidate.
  const policy = (base && configBlob(root, base)) ?? (staged
    ? blob(root, `:${ALLOWLIST}`)
    : configBlob(root, head));
  const patterns = JSON.parse(policy?.toString("utf8") ?? "null");
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
    throw new Error(`${ALLOWLIST} must contain an array of path globs`);
  }
  const allowed = globMatcher(patterns);
  const args = ["diff", "--raw", "-z", "--no-abbrev", "--find-renames=50%", "--diff-filter=ACMRT"];
  if (staged) args.push("--cached");
  args.push(comparison);
  if (!staged) args.push(head);
  args.push("--");
  const records = git(root, args).toString("utf8").split("\0");
  const violations = [];
  for (let i = 0; records[i];) {
    const [oldMode, newMode, oldOid, newOid, status] = records[i++].slice(1).split(" ");
    let file = records[i++];
    if (/^[RC]/.test(status)) file = records[i++];
    if (!/^100/.test(newMode) || allowed(file)) continue;
    const bytes = Number(git(root, ["cat-file", "-s", newOid]).toString());
    const previous = ZERO.test(oldOid) || !/^100/.test(oldMode)
      ? 0 : Number(git(root, ["cat-file", "-s", oldOid]).toString());
    if (bytes <= MAX_BYTES || bytes <= previous) continue;
    const content = blob(root, newOid);
    if (content.includes(0) || !isUtf8(content)) continue;
    violations.push({ file, bytes, previous });
  }
  return violations;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--staged") continue;
      if (arg === "--empty-base") { options.emptyBase = true; continue; }
      const key = { "--root": "root", "--base-ref": "baseRef", "--head-ref": "headRef" }[arg];
      if (!key || argv[i + 1] === undefined) throw new Error(`invalid or incomplete option: ${arg}`);
      options[key] = argv[++i];
    }
    const violations = checkFileSizes(options);
    for (const { file, bytes, previous } of violations) {
      console.error(`file-size: ${JSON.stringify(file)}: ${bytes} bytes (~${Math.ceil(bytes / 4)} tokens), previously ${previous} bytes; exceeds 5,000 tokens (20,000 bytes) and grows.`);
    }
    if (violations.length) {
      console.error("Split the file by responsibility: extract cohesive helpers or components into focused modules, move fixtures/data into separate files, and keep the entry point small. New files must stay at or below 20,000 bytes; existing oversized files must shrink or stay the same size. Stage the split and retry. Use .file-size-allowlist.json only for lockfiles, generated/codegen, vendored or binary assets; explain exceptions in the PR.");
      return 1;
    }
    console.log("file-size: PASS");
    return 0;
  } catch (error) {
    console.error(`file-size: ERROR: ${error.message}`);
    return 2;
  }
}

if (invokedAsScript(import.meta.url)) process.exitCode = main();
