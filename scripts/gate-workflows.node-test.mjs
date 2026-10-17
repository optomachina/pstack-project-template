import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SENSITIVE_PATHS_FILE, classifyPaths, loadSensitivePaths } from "./lib/sensitive-paths.mjs";

// The gate as the workflows run it: the "Prepare gate from base" step taken
// verbatim from each workflow, then the base copy of the scripts against a PR
// head that edits the configs and the scripts to wave itself through.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/pr-body-gate.yml"];
const CONFIGS = [SENSITIVE_PATHS_FILE, "pstack.config.json", "AGENTS.md"];

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const read = (root, file) => readFileSync(join(root, file), "utf8");
const write = (root, file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

/** The `run: |` block of the named step, dedented. */
export function runBlock(yaml, stepName) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `step ${stepName}`);
  const runAt = lines.findIndex((line, index) => index > start && /^\s+run: \|\s*$/.test(line));
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const strip = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(strip)).join("\n");
}

/** The gate files a workflow copies from the base. */
const gateFiles = (yaml) => runBlock(yaml, "Prepare gate from base").match(/files="([^"]+)"/)[1].split(/\s+/);

/** Every node invocation of a gate script in a workflow, with its continuation lines joined. */
function gateCommands(yaml) {
  return yaml
    .replaceAll(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.includes('"$RUNNER_TEMP/gate/scripts/'));
}

const allGateFiles = [...new Set(WORKFLOWS.flatMap((file) => gateFiles(read(repoRoot, file))))];

/** A repo whose base is the template's gate and whose head (HEAD, HEAD^1 = base) tries to loosen it. */
function tamperedRepo() {
  const dir = tempDir("gate-workflow-");
  git(dir, "init", "-q");
  for (const file of [...CONFIGS, ...allGateFiles]) write(dir, file, read(repoRoot, file));
  write(dir, "src/components/Card.tsx", "export const Card = () => null;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");

  // Declassify the gate files and env files.
  const list = JSON.parse(read(dir, SENSITIVE_PATHS_FILE));
  list.globs = list.globs.filter((entry) => entry.class !== "infra_ci" && entry.glob !== "**/.env*");
  list.globs.push({ glob: "nothing-here/**", class: "infra_ci" });
  write(dir, SENSITIVE_PATHS_FILE, `${JSON.stringify(list, null, 2)}\n`);
  // Make everything auto-merge "docs", drop the journey rule and the size guideline.
  const config = JSON.parse(read(dir, "pstack.config.json"));
  config.autoMerge.excludeKeywords = [];
  config.autoMerge.categories = [{ id: "docs", label: "Docs", include: ["**"], exclude: [] }];
  config.journeyTests.userVisible = ["nothing-here/**"];
  config.prSize = { maxChangedLines: 1000000, exclude: ["**"] };
  write(dir, "pstack.config.json", `${JSON.stringify(config, null, 2)}\n`);
  // And rewrite every gate script to pass.
  const pass = 'console.log("PASS review tier jev, sensitive none"); process.exitCode = 0;\n';
  for (const file of allGateFiles) write(dir, file, `export const invokedAsScript = () => false;\n${pass}`);
  write(dir, ".env.local", "API_KEY=changed\n");
  write(dir, "src/components/Card.tsx", "export const Card = () => 'changed';\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head: loosen own gate");
  return dir;
}

function prepare(dir, workflow) {
  const runnerTemp = tempDir("gate-runner-");
  const script = `set -euo pipefail\n${runBlock(read(repoRoot, workflow), "Prepare gate from base")}`;
  const proc = spawnSync("bash", ["-e", "-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: runnerTemp } });
  assert.equal(proc.status, 0, proc.stderr);
  return { runnerTemp, stdout: proc.stdout };
}

const node = (dir, args, env = {}) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env: { ...process.env, JEV_ENDPOINT: "", JEV_API_KEY: "", ...env } });

describe("gate workflows", () => {
  it("every gate script invocation reads its configs from the base", () => {
    for (const workflow of WORKFLOWS) {
      const commands = gateCommands(read(repoRoot, workflow));
      assert.ok(commands.length >= 2, workflow);
      for (const command of commands) {
        // check-pr-body reads no repo config: only the body and the review-gate output.
        if (command.includes("check-pr-body.mjs")) continue;
        assert.match(command, /--base-ref HEAD\^1\b/, `${workflow}: ${command.trim()}`);
      }
    }
  });

  for (const workflow of WORKFLOWS) {
    it(`${workflow}: a PR editing the configs and gate scripts cannot declassify its own files`, () => {
      const dir = tamperedRepo();
      const { runnerTemp, stdout } = prepare(dir, workflow);
      assert.match(stdout, /Gate scripts taken from: base/);
      for (const file of gateFiles(read(repoRoot, workflow))) assert.equal(read(join(runnerTemp, "gate"), file), read(repoRoot, file), `${file} is the base copy`);
      const gate = (script) => join(runnerTemp, "gate/scripts", script);
      const changed = join(runnerTemp, "changed.z");
      const reviewJson = join(runnerTemp, "review-gate.json");

      const review = node(dir, [gate("review-gate.mjs"), "--root", ".", "--base-ref", "HEAD^1", "--no-jev", "--changed-files-from", changed, "--numstat-from", join(runnerTemp, "numstat.txt"), "--title=-docs: tidy", "--json-out", reviewJson]);
      assert.equal(review.status, 0, review.stderr);
      const decision = JSON.parse(readFileSync(reviewJson, "utf8"));
      assert.deepEqual(decision.config_sources, { sensitivePaths: "base", pstackConfig: "base" });
      for (const name of ["infra_ci", "secrets"]) assert.ok(decision.sensitive.classes.includes(name), name);
      for (const file of [SENSITIVE_PATHS_FILE, "pstack.config.json", "scripts/review-gate.mjs", "scripts/lib/sensitive-paths.mjs"]) {
        assert.ok(decision.sensitive.files.find((entry) => entry.path === file)?.classes.includes("infra_ci"), `${file} stays infra_ci`);
      }
      assert.equal(decision.review_tier, "opus");
      assert.equal(decision.auto_merge.eligible, false);

      if (workflow.endsWith("pr-body-gate.yml")) {
        // The body gate holds the PR to opus and every class the base found (CRLF body, as the web UI sends).
        write(runnerTemp, "body.md", "preflight: test PASS\r\nJourney test: N/A - copy change\r\nReview tier: sonnet\r\nSensitive classes: none\r\n");
        const body = node(dir, [gate("check-pr-body.mjs"), "--body-file", join(runnerTemp, "body.md"), "--review-gate-json", reviewJson]);
        assert.equal(body.status, 1, body.stderr);
        assert.match(body.stdout, /review tier must be opus/);
        assert.match(body.stdout, /missing: .*infra_ci/);
      }

      // The base journey globs still cover the UI change.
      write(runnerTemp, "plain.md", "Review tier: opus\n");
      const journey = node(dir, [gate("check-journey-tests.mjs"), "--root", ".", "--base-ref", "HEAD^1", "--changed-files-from", changed, "--body-file", join(runnerTemp, "plain.md")]);
      assert.equal(journey.status, 1, journey.stdout);

      if (workflow.endsWith("ci.yml")) {
        const reportJson = join(runnerTemp, "sensitive-paths-report.json");
        const report = node(dir, [gate("sensitive-paths-report.mjs"), "--root", ".", "--base-ref", "HEAD^1", "--json-out", reportJson]);
        assert.equal(report.status, 0, report.stderr);
        const parsed = JSON.parse(readFileSync(reportJson, "utf8"));
        assert.equal(parsed.config_source, "base");
        assert.ok(parsed.classes.includes("infra_ci"));
        assert.equal(parsed.gate_loosening.detected, true);
      }
    });
  }

  it("falls back to the head copy only when the base lacks a gate script", () => {
    const dir = tempDir("gate-bootstrap-");
    git(dir, "init", "-q");
    write(dir, "README.md", "before the gate\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    for (const file of [...CONFIGS, ...allGateFiles]) write(dir, file, read(repoRoot, file));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add the gate");
    for (const workflow of WORKFLOWS) assert.match(prepare(dir, workflow).stdout, /Gate scripts taken from: head/);
  });
});

describe("code owners", () => {
  const codeowners = read(repoRoot, ".github/CODEOWNERS");
  const rules = codeowners
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  // Enough of the CODEOWNERS syntax for the anchored patterns the template uses.
  const owns = (pattern, file) => {
    assert.ok(pattern.startsWith("/"), `${pattern} is anchored`);
    const body = pattern.slice(1);
    if (body.endsWith("/")) return file.startsWith(body);
    const regex = new RegExp(`^${body.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);
    return regex.test(file);
  };
  const governed = [
    ...WORKFLOWS,
    ".github/workflows/new-workflow.yml",
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    SENSITIVE_PATHS_FILE,
    "pstack.config.json",
    "AGENTS.md",
    "CLAUDE.md",
    ...allGateFiles,
    "scripts/preflight.sh",
    "scripts/validate-agent-contract.mjs",
    "scripts/sync-template.mjs",
    "scripts/gate-workflows.node-test.mjs",
  ];

  it("owns every workflow, gate script and gate config", () => {
    for (const file of governed) {
      const rule = rules.findLast(([pattern]) => owns(pattern, file));
      assert.ok(rule, `${file} has a code owner`);
      assert.equal(rule[1], "{{OWNER_HANDLE}}", `${file} is owned by the template owner`);
    }
  });

  it("and the sensitive list classifies each of them as infra_ci", () => {
    const result = classifyPaths(governed, loadSensitivePaths({ root: repoRoot }));
    for (const file of result.files) assert.ok(file.classes.includes("infra_ci"), file.path);
  });
});
