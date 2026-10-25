import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWLIST, checkFileSizes } from "./file-size-gate.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const script = join(source, "scripts/file-size-gate.mjs");
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const git = (root, ...args) => execFileSync("git", [
  "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args,
], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const write = (root, file, content) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
const commit = (root) => { git(root, "add", "-A"); git(root, "commit", "-qm", "fixture"); };
function repo(files = {}, initial = false) {
  const root = mkdtempSync(join(tmpdir(), "file-size-"));
  temps.push(root);
  git(root, "init", "-q");
  git(root, "config", "core.hooksPath", ".no-hooks");
  write(root, ALLOWLIST, readFileSync(join(source, ALLOWLIST)));
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  if (!initial) commit(root);
  return root;
}
const stage = (root) => git(root, "add", "-A");
const check = (root, options = {}) => checkFileSizes({ root, ...options });
const cli = (root, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
function installSources(root) {
  for (const file of ["scripts/file-size-gate.mjs", "scripts/lib/sensitive-paths.mjs", ".githooks/pre-commit"]) {
    write(root, file, readFileSync(join(source, file)));
  }
  chmodSync(join(root, ".githooks/pre-commit"), 0o755);
}

describe("file-size gate against real Git blobs", () => {
  it("accepts exactly 20,000 bytes, rejects 20,001, and explains splitting", () => {
    const root = repo();
    write(root, "boundary.txt", "a".repeat(20_000));
    stage(root);
    assert.deepEqual(check(root), []);
    write(root, "boundary.txt", "a".repeat(20_001));
    stage(root);
    assert.deepEqual(check(root), [{ file: "boundary.txt", bytes: 20_001, previous: 0 }]);
    const result = cli(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /5,000 tokens.*20,000 bytes/);
    assert.match(result.stderr, /Split the file by responsibility.*focused modules/);
  });

  it("permits equal-size edits and shrinking oversized files, but rejects growth", () => {
    const root = repo({ "large.txt": "a".repeat(21_000) });
    for (const bytes of [21_000, 20_001, 20_000]) {
      write(root, "large.txt", "b".repeat(bytes));
      stage(root);
      assert.deepEqual(check(root), []);
    }
    write(root, "large.txt", "b".repeat(21_001));
    stage(root);
    assert.equal(check(root)[0].previous, 21_000);
    const crossing = repo({ "small.txt": "a".repeat(19_999) });
    write(crossing, "small.txt", "a".repeat(20_001));
    stage(crossing);
    assert.equal(check(crossing).length, 1);
  });

  it("uses only staged bytes, including partial staging and unstaged deletions", () => {
    const root = repo();
    write(root, "partial.txt", "a".repeat(20_001));
    assert.deepEqual(check(root), []);
    stage(root);
    write(root, "partial.txt", "small");
    assert.equal(check(root).length, 1);
    rmSync(join(root, "partial.txt"));
    assert.equal(check(root).length, 1);
    stage(root);
    assert.deepEqual(check(root), []);
    write(root, "partial.txt", "small");
    stage(root);
    write(root, "partial.txt", "a".repeat(20_001));
    assert.deepEqual(check(root), []);
  });

  it("counts UTF-8 bytes and handles unusual path names without shell evaluation", () => {
    const root = repo();
    const names = ["space name.txt", "tab\tname.txt", "line\nname.txt", "-option.txt", "é.txt", "$(no-command).txt"];
    for (const name of names) write(root, name, "é".repeat(10_001));
    stage(root);
    assert.deepEqual(check(root).map((v) => v.file).sort(), names.sort());
    assert.ok(check(root).every((v) => v.bytes === 20_002));
  });

  it("preserves detected rename baselines and treats copies as new files", () => {
    const root = repo({ "old.txt": "line\n".repeat(5_000) });
    git(root, "mv", "old.txt", "renamed.txt");
    assert.deepEqual(check(root), []);
    write(root, "renamed.txt", "line\n".repeat(5_000) + "growth\n");
    stage(root);
    assert.equal(check(root)[0].previous, 25_000);
    write(root, "renamed.txt", "line\n".repeat(5_000));
    commit(root);
    write(root, "copy.txt", "line\n".repeat(5_000));
    stage(root);
    assert.deepEqual(check(root).map((v) => v.file), ["copy.txt"]);
  });

  it("ignores deletions, symlinks and submodules", () => {
    const root = repo({ "deleted.txt": "a".repeat(21_000) });
    git(root, "rm", "deleted.txt");
    symlinkSync("missing", join(root, "link"));
    stage(root);
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD").trim()},submodule`);
    assert.deepEqual(check(root), []);
  });

  it("ignores configured lockfiles, generated/codegen, vendored and binary files", () => {
    const root = repo();
    for (const file of ["package-lock.json", "pkg/yarn.lock", "Cargo.lock", "go.sum", "x/uv.lock",
      "generated/code.txt", "x/__generated__/code.txt", "codegen/out.txt", "vendor/lib.txt",
      "x/third_party/lib.txt", "dist/app.js", "x/a.generated.ts", "x/a.min.js", "image.PNG"]) {
      write(root, file, "a".repeat(21_000));
    }
    write(root, "binary-without-extension", Buffer.alloc(21_000));
    write(root, "invalid-utf8", Buffer.alloc(21_000, 0xff));
    write(root, "source.txt", "a".repeat(21_000));
    stage(root);
    assert.deepEqual(check(root).map((v) => v.file), ["source.txt"]);
  });

  it("uses the base allowlist and honors custom exclusions already landed", () => {
    const root = repo();
    write(root, ALLOWLIST, JSON.stringify(["assets/custom.dat"]));
    commit(root);
    write(root, "assets/custom.dat", "a".repeat(21_000));
    write(root, "source.txt", "a".repeat(21_000));
    write(root, ALLOWLIST, JSON.stringify(["**"]));
    stage(root);
    assert.deepEqual(check(root).map((v) => v.file), ["source.txt"]);
  });

  it("supports initial commits and the commit introducing the policy", () => {
    const root = repo({}, true);
    write(root, "new.txt", "a".repeat(21_000));
    stage(root);
    assert.equal(check(root).length, 1);
    git(root, "reset", "-q", "--", ALLOWLIST);
    assert.equal(cli(root).status, 2, "missing staged policy fails closed");
    const introducing = repo();
    git(introducing, "rm", ALLOWLIST);
    commit(introducing);
    write(introducing, ALLOWLIST, readFileSync(join(source, ALLOWLIST)));
    write(introducing, "new.txt", "a".repeat(21_000));
    stage(introducing);
    assert.equal(check(introducing).length, 1, "base without a policy uses staged introducing copy");
  });

  it("fails closed on missing refs, malformed policy and invalid arguments", () => {
    const root = repo();
    for (const args of [["--base-ref", ""], ["--base-ref", "missing"], ["--head-ref", "missing"], ["--wat"], ["--base-ref"]]) {
      assert.equal(cli(root, ...args).status, 2, args.join(" "));
    }
    for (const policy of ["{}", "null", "[123]", "[", '["[invalid]"]']) {
      write(root, ALLOWLIST, policy);
      commit(root);
      assert.equal(cli(root).status, 2, policy);
    }
  });

  it("actually rejects and accepts git commits through the installed hook", () => {
    const root = repo();
    installSources(root);
    commit(root);
    git(root, "config", "core.hooksPath", ".githooks");
    write(root, "too-large.txt", "a".repeat(20_001));
    stage(root);
    assert.throws(() => git(root, "commit", "-qm", "rejected"), /Split the file/);
    write(root, "too-large.txt", "a".repeat(20_000));
    stage(root);
    assert.doesNotThrow(() => git(root, "commit", "-qm", "accepted"));
  });
});

describe("file-size CI job", () => {
  const yaml = readFileSync(join(source, ".github/workflows/ci.yml"), "utf8");
  const shell = yaml.split("      - name: Check file sizes\n")[1].split("        run: |\n")[1]
    .split("\n  preflight:")[0].split("\n").map((line) => line.slice(10)).join("\n");
  function workflow(root, event, base) {
    const runner = mkdtempSync(join(tmpdir(), "file-size-runner-"));
    temps.push(runner);
    return spawnSync("bash", ["-c", shell], { cwd: root, encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runner, EVENT_NAME: event, BASE_SHA: base } });
  }

  it("rejects oversized changes on PR, push and merge_group even if head replaces its gate", () => {
    const root = repo();
    installSources(root);
    commit(root);
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, "scripts/file-size-gate.mjs", "process.exit(0);\n");
    write(root, ALLOWLIST, '["**"]');
    write(root, "large.txt", "a".repeat(21_000));
    commit(root);
    for (const event of ["pull_request", "push", "merge_group"]) {
      const result = workflow(root, event, base);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /scripts taken from: base/);
      assert.match(result.stderr, /large.txt/);
    }
  });

  it("bootstraps on introducing PRs, handles zero push SHAs and fails on unavailable history", () => {
    const root = repo();
    git(root, "rm", ALLOWLIST);
    commit(root);
    installSources(root);
    write(root, ALLOWLIST, '["scripts/lib/sensitive-paths.mjs"]');
    commit(root);
    assert.equal(workflow(root, "pull_request", "").status, 0);
    assert.equal(workflow(root, "push", "0".repeat(40)).status, 0);
    assert.notEqual(workflow(root, "push", "missing").status, 0);
    assert.match(yaml, /needs: \[preflight, agent-contract, pr-gates, file-size\]/);
    assert.match(yaml, /"\$FILE_SIZE"/);
  });
});
