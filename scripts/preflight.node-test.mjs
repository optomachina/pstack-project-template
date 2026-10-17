import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway project with the preflight script, the given npm scripts and optional pstack preflight config. */
function project(scripts, preflight) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  temps.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(repoRoot, "scripts/preflight.sh"), join(dir, "scripts/preflight.sh"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", private: true, scripts }));
  if (preflight) writeFileSync(join(dir, "pstack.config.json"), JSON.stringify({ preflight }));
  return dir;
}
const run = (dir, ...stages) => spawnSync("bash", [join(dir, "scripts/preflight.sh"), ...stages], { encoding: "utf8" });

describe("preflight", () => {
  it("runs defined stages, skips optional missing ones, and prints a line per stage", () => {
    const result = run(project({ test: "node -e 0", build: "node -e 0" }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^preflight: typecheck SKIP/m);
    assert.match(result.stdout, /^preflight: lint SKIP/m);
    assert.match(result.stdout, /^preflight: test PASS$/m);
    assert.match(result.stdout, /^preflight: build PASS$/m);
  });

  it("fails a failing stage but still runs the rest", () => {
    const result = run(project({ typecheck: "node -e 'process.exit(3)'", test: "node -e 0" }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^preflight: typecheck FAIL$/m);
    assert.match(result.stdout, /^preflight: test PASS$/m);
  });

  it("fails when a required stage is not defined", () => {
    const result = run(project({ lint: "node -e 0" }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^preflight: test FAIL \(required/m);
  });

  it("follows pstack.config.json stages and required, and explicit stage arguments", () => {
    const dir = project({ verify: "node -e 0", test: "node -e 'process.exit(1)'" }, { stages: ["verify"], required: ["verify"] });
    const configured = run(dir);
    assert.equal(configured.status, 0);
    assert.match(configured.stdout, /^preflight: verify PASS$/m);
    assert.doesNotMatch(configured.stdout, /test/);
    assert.equal(run(dir, "test").status, 1);
  });

  it("rejects invalid stage names with exit 2", () => {
    assert.equal(run(project({ test: "node -e 0" }), "test;rm").status, 2);
    assert.equal(run(project({ test: "node -e 0" }), "preflight").status, 2);
  });
});
