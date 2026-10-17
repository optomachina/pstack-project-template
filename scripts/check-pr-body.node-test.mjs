import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkPrBody, main } from "./check-pr-body.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const template = readFileSync(join(repoRoot, ".github/pull_request_template.md"), "utf8");
const good = [
  "## Preflight",
  "```text",
  "preflight: typecheck SKIP (no \"typecheck\" script in package.json)",
  "preflight: test PASS",
  "```",
  "Journey test: e2e/journeys/signup.spec.ts",
  "Review tier: sonnet",
  "Sensitive classes: none",
].join("\n");
const sensitiveReview = { review_tier: "opus", sensitive: { sensitive: true, classes: ["auth", "deps"] }, jev: { status: "skipped" } };

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("pr-body gate", () => {
  it("accepts a complete body", () => {
    assert.deepEqual(checkPrBody(good), []);
    assert.deepEqual(checkPrBody(good.replace("Journey test: e2e/journeys/signup.spec.ts", "Journey test: N/A - backend-only change")), []);
  });

  it("rejects the unfilled template, including its commented examples", () => {
    const problems = checkPrBody(template);
    assert.equal(problems.length, 4, problems.join("\n"));
  });

  it("rejects a FAIL stage, a bare N/A, an unknown tier and a missing classes line", () => {
    assert.ok(checkPrBody(`${good}\npreflight: lint FAIL`).includes("preflight stage lint is FAIL"));
    assert.ok(checkPrBody(good.replace("e2e/journeys/signup.spec.ts", "N/A")).some((problem) => problem.includes("needs")));
    assert.ok(checkPrBody(good.replace("Review tier: sonnet", "Review tier: gpt")).some((problem) => problem.includes("Review tier")));
    assert.ok(checkPrBody(good.replace("Sensitive classes: none", "")).some((problem) => problem.includes("Sensitive classes")));
  });

  it("requires opus and every class when the review gate found sensitive paths", () => {
    const problems = checkPrBody(good.replace("Sensitive classes: none", "Sensitive classes: auth"), sensitiveReview);
    assert.deepEqual(problems, ["the review gate found sensitive classes (auth, deps), so the review tier must be opus, not sonnet", '"Sensitive classes" is missing: deps']);
    assert.deepEqual(checkPrBody(good.replace("Review tier: sonnet", "Review tier: opus").replace("none", "`auth`, `deps`"), sensitiveReview), []);
  });

  it("runs as a CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-body-"));
    temps.push(dir);
    writeFileSync(join(dir, "body.md"), good);
    writeFileSync(join(dir, "gate.json"), JSON.stringify(sensitiveReview));
    assert.equal(main(["--body-file", join(dir, "body.md")], { stdout: () => {} }), 0);
    assert.equal(main(["--body-file", join(dir, "body.md"), "--review-gate-json", join(dir, "gate.json")], { stdout: () => {} }), 1);
    assert.equal(main([], { stdout: () => {}, env: { PR_BODY: "" } }), 1);
    assert.equal(main(["--nope"], { stderr: () => {} }), 2);
  });
});
