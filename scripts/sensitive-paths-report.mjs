#!/usr/bin/env node
/**
 * Sensitive-paths PR report (report only; never fails on findings).
 *
 * Diffs <base>..HEAD with `git diff --name-status -z --no-renames`, classifies
 * the changed files against the base copy of docs/sensitive-paths.json, and
 * reports gate loosening and AGENTS.md parity. On a pull_request merge
 * checkout HEAD^1 is the base as merged, which is the default.
 *
 * Usage: node scripts/sensitive-paths-report.mjs [--base-ref <ref>] [--json-out <file>] [--root <dir>]
 * Exit codes: 0 report produced, 2 usage error or a base ref that does not resolve.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { invokedAsScript, main as sensitivePathsMain, resolveCommit } from "./lib/sensitive-paths.mjs";

const GIT = process.env.PSTACK_GIT || (existsSync("/usr/bin/git") ? "/usr/bin/git" : "git");

export function runReport(argv = process.argv.slice(2), io = {}) {
  const stderr = io.stderr ?? console.error;
  let baseRef = "HEAD^1";
  let root = process.cwd();
  const passthrough = [];
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--base-ref") baseRef = argv[++k] ?? "";
    else if (argv[k] === "--root") root = argv[++k] ?? root;
    else if (argv[k] === "--json-out") passthrough.push("--json-out", path.resolve(argv[++k] ?? ""));
    else {
      stderr(`sensitive-paths-report: unknown option ${argv[k]}`);
      return 2;
    }
  }
  root = path.resolve(root);
  let base;
  try {
    base = resolveCommit(root, baseRef);
  } catch (error) {
    stderr(`sensitive-paths-report: ${error.message}`);
    return 2;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "sensitive-report-"));
  try {
    const changed = path.join(dir, "changed.z");
    writeFileSync(changed, execFileSync(GIT, ["diff", "--name-status", "-z", "--no-renames", base, "HEAD"], { cwd: root }));
    return sensitivePathsMain(["report", "--root", root, "--changed-files-from", changed, "--base-ref", base, ...passthrough], io);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = runReport();
}
