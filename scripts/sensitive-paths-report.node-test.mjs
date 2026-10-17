import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SENSITIVE_PATHS_FILE } from "./lib/sensitive-paths.mjs";
import { runReport } from "./sensitive-paths-report.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

describe("sensitive-paths report runner", () => {
  it("diffs HEAD^1..HEAD with the base list and never fails on findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-runner-"));
    temps.push(dir);
    git(dir, "init", "-q");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE)));
    writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(repoRoot, "AGENTS.md")));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    mkdirSync(join(dir, "db/migrations"), { recursive: true });
    writeFileSync(join(dir, "db/migrations/1.sql"), "select 1;\n");
    writeFileSync(join(dir, "notes.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");

    const lines = [];
    assert.equal(runReport(["--root", dir, "--json-out", join(dir, "r.json")], { stdout: (line) => lines.push(line) }), 0);
    const report = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    assert.equal(report.config_source, "base");
    assert.deepEqual(report.classes.slice(0, 2), ["schema", "migrations"]);
    assert.equal(report.files.length, 2);
    assert.match(lines.join("\n"), /2 file\(s\), 1 sensitive/);
    assert.equal(runReport(["--root", dir, "--base-ref", "nope"], { stdout: () => {}, stderr: () => {} }), 2);
    assert.equal(runReport(["--bogus"], { stdout: () => {}, stderr: () => {} }), 2);
  });
});
