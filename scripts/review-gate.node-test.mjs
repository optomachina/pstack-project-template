import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { askJev, gatedChoice, isJevConfigured, jevConfig, NOT_CONFIGURED, sanitizeToken } from "./jev-client.mjs";
import { parsePstackConfig } from "./lib/pstack-config.mjs";
import { SENSITIVE_PATHS_FILE, loadSensitivePaths } from "./lib/sensitive-paths.mjs";
import { categorize, countChangedLines, decide, finalTier, main, runReviewGate, SCREEN_QUESTIONS } from "./review-gate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sensitivePaths = loadSensitivePaths({ root: repoRoot });
const pstackText = readFileSync(join(repoRoot, "pstack.config.json"), "utf8");
// The template's own auto-merge categories, so the tests do not depend on a project's edits.
const pstackConfig = parsePstackConfig(pstackText);
const accepted = (choice, confidence = 0.9) => ({ status: "accepted", choice, confidence });

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

describe("review tier", () => {
  it("sends sensitive PRs to Opus whatever Jev says, and never auto-merges them", () => {
    for (const file of ["db/migrations/1.sql", ".env.production", ".github/workflows/ci.yml", "src/lib/auth/guard.ts", "package.json"]) {
      const decision = decide({ files: [file], sensitivePaths, pstackConfig, gate: accepted("low", 0.99) });
      assert.equal(decision.deterministic, "risky", file);
      assert.equal(decision.review_tier, "opus", file);
      assert.deepEqual(decision.reviews_required, ["jev", "sonnet", "opus"]);
      assert.equal(decision.auto_merge.eligible, false, file);
    }
  });

  it("lets Jev raise but never lower the tier", () => {
    assert.equal(finalTier("low", accepted("risky")), "risky");
    assert.equal(finalTier("risky", accepted("low")), "risky");
    assert.equal(finalTier("normal", accepted("low")), "normal");
    assert.equal(finalTier("Risky", accepted("low")), "risky", "an unknown deterministic tier counts as risky");
    const decision = decide({ files: ["src/lib/format.ts"], sensitivePaths, pstackConfig, gate: accepted("risky") });
    assert.equal(decision.review_tier, "opus");
  });

  it("needs a confident Jev answer for the Jev-only tier", () => {
    const docs = ["docs/guide.md", "README.md"];
    assert.equal(decide({ files: docs, sensitivePaths, pstackConfig, gate: accepted("low") }).review_tier, "jev");
    for (const gate of [{ status: NOT_CONFIGURED }, { status: "failed", reason: "timeout" }, { status: "uncertain", choice: "low", confidence: 0.2 }, accepted("bogus")]) {
      const decision = decide({ files: docs, sensitivePaths, pstackConfig, gate });
      assert.equal(decision.deterministic, "low");
      assert.equal(decision.review_tier, "sonnet", JSON.stringify(gate));
      assert.equal(decision.auto_merge.eligible, true, "auto-merge still applies after the Sonnet review");
    }
  });

  it("sends uncategorized runtime code to Sonnet and does not auto-merge it", () => {
    const decision = decide({ files: ["src/lib/format.ts"], sensitivePaths, pstackConfig, gate: accepted("low") });
    assert.equal(decision.deterministic, "normal");
    assert.equal(decision.review_tier, "sonnet");
    assert.equal(decision.auto_merge.eligible, false);
    assert.deepEqual(decision.auto_merge.blockers, ["src/lib/format.ts: no category"]);
  });

  it("fails closed when the file list is empty or a config is unavailable", () => {
    for (const input of [{ files: [] }, { files: ["docs/a.md"], sensitivePaths: null }, { files: ["docs/a.md"], pstackConfig: null }]) {
      const decision = decide({ sensitivePaths, pstackConfig, gate: accepted("low"), ...input });
      assert.equal(decision.review_tier, "opus", JSON.stringify(input));
      assert.equal(decision.auto_merge.eligible, false);
      assert.ok(decision.problems.length > 0);
    }
  });
});

describe("auto-merge categories", () => {
  it("assigns each low-risk file its category", () => {
    const files = ["README.md", "docs/runbooks/x.md", "src/lib/x.test.ts", "e2e/journeys/signup.spec.ts", "src/components/Button.tsx", "src/styles/app.css", "public/logo.svg", "scripts/report.mjs", ".claude/agents/reviewer.md"];
    const decision = decide({ files, sensitivePaths, pstackConfig, gate: accepted("low") });
    assert.deepEqual(decision.auto_merge.categories, {
      "README.md": "docs",
      "docs/runbooks/x.md": "docs",
      "src/lib/x.test.ts": "tests",
      "e2e/journeys/signup.spec.ts": "tests",
      "src/components/Button.tsx": "frontend_ui",
      "src/styles/app.css": "styles_assets",
      "public/logo.svg": "styles_assets",
      "scripts/report.mjs": "repo_scripts",
      ".claude/agents/reviewer.md": "agent_skills",
    });
    assert.equal(decision.auto_merge.eligible, true);
    assert.equal(decision.review_tier, "jev");
  });

  it("excludes keyword paths, nested Markdown outside docs, deploy scripts and SQL test fixtures", () => {
    const result = categorize(["src/components/LoginSessionBanner.tsx", "src/components/TokenInput.tsx", "packages/x/README.md", "scripts/deploy-prod.sh", "e2e/fixtures/seed.sql"], pstackConfig);
    assert.deepEqual(result.map((entry) => entry.category), [null, null, null, null, null]);
    assert.equal(result[0].reason, "excluded keyword");
    assert.equal(result[2].reason, "no category");
  });

  it("honors autoMerge.enabled", () => {
    const disabled = parsePstackConfig({ ...JSON.parse(pstackText), autoMerge: { ...JSON.parse(pstackText).autoMerge, enabled: false } });
    const decision = decide({ files: ["docs/a.md"], sensitivePaths, pstackConfig: disabled, gate: accepted("low") });
    assert.equal(decision.auto_merge.eligible, false);
    assert.ok(decision.auto_merge.blockers.includes("autoMerge.enabled is false"));
  });

  it("counts changed lines without excluded files and flags oversized PRs", () => {
    const numstat = "120\t30\tsrc/a.ts\n500\t0\tpackage-lock.json\n-\t-\tlogo.png\n60\t5\tsrc/b.ts\n";
    assert.equal(countChangedLines(numstat, pstackConfig.prSize.exclude), 215);
    const decision = decide({ files: ["src/a.ts"], sensitivePaths, pstackConfig, changedLines: 215 });
    assert.deepEqual(decision.pr_size, { changed_lines: 215, max: 200, over: true });
  });
});

describe("Jev client", () => {
  it("is inert without JEV_ENDPOINT and makes no request", async () => {
    let called = false;
    const fetch = async () => {
      called = true;
      throw new Error("must not be called");
    };
    assert.equal(isJevConfigured({}), false);
    const result = await askJev({ x: 1 }, SCREEN_QUESTIONS, { env: {}, fetch });
    assert.deepEqual(result, { ok: false, reason: NOT_CONFIGURED, latencyMs: 0 });
    assert.equal(called, false);
    assert.deepEqual(gatedChoice(result, "tier"), { status: NOT_CONFIGURED, reason: NOT_CONFIGURED });
  });

  it("refuses non-https endpoints except loopback", () => {
    assert.equal(jevConfig({ JEV_ENDPOINT: "http://jev.example.test/v1" }), null);
    assert.equal(jevConfig({ JEV_ENDPOINT: "not a url" }), null);
    assert.ok(jevConfig({ JEV_ENDPOINT: "http://127.0.0.1:8080/v1" }));
    assert.ok(jevConfig({ JEV_ENDPOINT: "https://jev.example.test/v1" }));
  });

  it("validates answers, sends the key only as a bearer header, and never echoes it", async () => {
    const env = { JEV_ENDPOINT: "https://jev.example.test/v1", JEV_API_KEY: "sk-test-123", JEV_MODEL: "jev-x" };
    let seen;
    const reply = (body, status = 200) => async (url, init) => {
      seen = { url, init };
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    };
    const good = { model: "jev-x", answers: { tier: { type: "choice", choice: "low", confidence: 0.8 }, incident: { type: "noul", noul: 0.01 } } };
    const result = await askJev({ title: "t" }, SCREEN_QUESTIONS, { env, fetch: reply(good) });
    assert.equal(result.ok, true);
    assert.equal(seen.init.headers.Authorization, "Bearer sk-test-123");
    assert.ok(!seen.init.body.includes("sk-test-123"));
    assert.equal((await askJev({}, SCREEN_QUESTIONS, { env, fetch: reply({ ...good, model: "other" }) })).reason, "unexpected_model_version");
    assert.equal((await askJev({}, SCREEN_QUESTIONS, { env, fetch: reply({ model: "jev-x", answers: { tier: { type: "choice", choice: "huge", confidence: 1 } } }) })).reason, "malformed_response");
    assert.equal((await askJev({}, SCREEN_QUESTIONS, { env, fetch: reply({}, 403) })).reason, "http_403");
    assert.equal(sanitizeToken("leak sk-test-123", env), "redacted");
  });

  it("feeds a configured screen into the gate", async () => {
    const ask = async () => ({ ok: true, model: "m", answers: { tier: { type: "choice", choice: "risky", confidence: 0.9 }, incident: { type: "noul", noul: 0.3 } } });
    const decision = await runReviewGate({ root: repoRoot, files: ["docs/a.md"], ask });
    assert.equal(decision.review_tier, "opus");
    assert.equal(decision.jev.p_incident, 0.3);
  });
});

describe("CLI and base ref", () => {
  it("reads the base copy of the configs so a PR cannot loosen its own gate", async () => {
    const dir = tempDir("review-gate-");
    git(dir, "init", "-q");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE)));
    writeFileSync(join(dir, "pstack.config.json"), pstackText);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    // The head removes the .env glob and adds .env to the docs category.
    const list = JSON.parse(readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8"));
    list.globs = list.globs.filter((entry) => entry.glob !== "**/.env*");
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), JSON.stringify(list));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");
    writeFileSync(join(dir, "changed.z"), "M\0.env.local\0");

    const lines = [];
    assert.equal(await main(["--root", dir, "--base-ref", "HEAD^1", "--changed-files-from", "changed.z", "--no-jev", "--json-out", "gate.json"], { stdout: (line) => lines.push(line) }), 0);
    const decision = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8"));
    assert.equal(decision.config_sources.sensitivePaths, "base");
    assert.ok(decision.sensitive.classes.includes("secrets"));
    assert.equal(decision.review_tier, "opus");
    assert.match(lines.join("\n"), /review tier opus/);

    // Without the base ref the loosened head list would apply.
    assert.equal(await main(["--root", dir, "--changed-files-from", "changed.z", "--no-jev", "--json-out", "head.json"], { stdout: () => {} }), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "head.json"), "utf8")).sensitive.sensitive, false);

    // An unresolvable base ref fails closed.
    assert.equal(await main(["--root", dir, "--base-ref", "no-such-ref", "--no-jev", "--json-out", "bad.json", "docs/a.md"], { stdout: () => {} }), 0);
    const bad = JSON.parse(readFileSync(join(dir, "bad.json"), "utf8"));
    assert.equal(bad.review_tier, "opus");
    assert.equal(bad.auto_merge.eligible, false);
  });

  it("returns 2 on usage errors and runs as a process", async () => {
    assert.equal(await main(["--base-ref"], { stderr: () => {} }), 2);
    assert.equal(await main(["--bogus"], { stderr: () => {} }), 2);
    const proc = spawnSync(process.execPath, [join(repoRoot, "scripts/review-gate.mjs"), "--root", repoRoot, "--no-jev", "docs/guide.md"], { encoding: "utf8", env: { ...process.env, JEV_ENDPOINT: "" } });
    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /review tier sonnet/);
    assert.match(proc.stdout, /auto-merge eligible/);
  });
});
