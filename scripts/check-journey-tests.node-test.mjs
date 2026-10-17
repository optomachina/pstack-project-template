import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkJourneyTests, findWaiver, main } from "./check-journey-tests.mjs";
import { parsePstackConfig } from "./lib/pstack-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const configText = readFileSync(join(repoRoot, "pstack.config.json"), "utf8");
const config = parsePstackConfig(configText);
const changes = (...files) => files.map((file) => (typeof file === "string" ? { status: "M", file } : file));

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

describe("journey-test rule", () => {
  it("fails a user-visible change without a journey test change", () => {
    const result = checkJourneyTests({ changes: changes("src/components/Button.tsx", "src/lib/format.ts"), config });
    assert.equal(result.status, "fail");
    assert.deepEqual(result.userVisible, ["src/components/Button.tsx"]);
    assert.match(result.reasons[1], /Journey test: N\/A - <reason>/);
  });

  it("passes when a journey test is added or modified", () => {
    for (const status of ["A", "M"]) {
      const result = checkJourneyTests({ changes: changes("src/pages/Home.tsx", { status, file: "e2e/journeys/home.spec.ts" }), config });
      assert.equal(result.status, "pass", status);
      assert.deepEqual(result.journeyTests, ["e2e/journeys/home.spec.ts"]);
    }
  });

  it("does not count a deleted journey test", () => {
    const result = checkJourneyTests({ changes: changes("src/pages/Home.tsx", { status: "D", file: "e2e/journeys/home.spec.ts" }), config });
    assert.equal(result.status, "fail");
  });

  it("treats deleting a user-visible file as user-visible", () => {
    assert.equal(checkJourneyTests({ changes: changes({ status: "D", file: "src/pages/Old.tsx" }), config }).status, "fail");
  });

  it("is not applicable for non-visible changes, tests and stories", () => {
    for (const files of [["src/lib/format.ts"], ["docs/a.md"], ["src/components/Button.test.tsx", "src/components/Button.stories.tsx"], ["e2e/journeys/home.spec.ts"]]) {
      assert.equal(checkJourneyTests({ changes: changes(...files), config }).status, "not-applicable", files.join(","));
    }
  });

  it("matches styles and public assets anywhere", () => {
    assert.equal(checkJourneyTests({ changes: changes("styles/theme.SCSS"), config }).status, "fail");
    assert.equal(checkJourneyTests({ changes: changes("public/logo.svg"), config }).status, "fail");
  });

  it("accepts a waiver with a real reason", () => {
    const body = "## Journey test\n\nJourney test: N/A - copy-only change, covered by e2e/journeys/home.spec.ts\n";
    const result = checkJourneyTests({ changes: changes("src/pages/Home.tsx"), body, config });
    assert.equal(result.status, "waived");
    assert.equal(result.waiver, "copy-only change, covered by e2e/journeys/home.spec.ts");
  });

  it("accepts bullets, bold labels and dash variants", () => {
    for (const line of ["- Journey test: N/A - reason here", "**Journey test: N/A** — reason here", "journey test: n/a – reason here", "* Journey test: N/A: reason here"]) {
      assert.equal(findWaiver(line), "reason here", line);
    }
  });

  it("rejects placeholder, empty, commented-out and inline waivers", () => {
    for (const body of [
      "Journey test: N/A - <reason>",
      "Journey test: N/A - ",
      "Journey test: N/A - n/a",
      "Journey test: N/A - tbd",
      "<!-- Journey test: N/A - real reason in a comment -->",
      "<!--\nJourney test: N/A - multi-line comment\n-->",
      "I wrote Journey test: N/A - inline in prose",
    ]) {
      assert.equal(findWaiver(body), null, JSON.stringify(body));
      assert.equal(checkJourneyTests({ changes: changes("src/pages/Home.tsx"), body, config }).status, "fail", JSON.stringify(body));
    }
  });
});

describe("journey-test CLI", () => {
  it("exits 1 on failure, 0 on waiver, and reads the body from PR_BODY", () => {
    const dir = tempDir("journey-cli-");
    writeFileSync(join(dir, "pstack.config.json"), configText);
    writeFileSync(join(dir, "changed.txt"), "M\tsrc/components/Card.tsx\n");
    writeFileSync(join(dir, "body.md"), "Journey test: N/A - visual token rename with no behavior change\n");
    const out = [];
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt"], { stdout: (line) => out.push(line), env: {} }), 1);
    assert.match(out.join("\n"), /journey-tests: FAIL/);
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt", "--body-file", "body.md", "--json-out", "j.json"], { stdout: () => {} }), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "j.json"), "utf8")).status, "waived");
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt"], { stdout: () => {}, env: { PR_BODY: "Journey test: N/A - reason from env" } }), 0);
    assert.equal(main(["--root", dir], { stderr: () => {} }), 2);
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt", "--base-ref", ""], { stderr: () => {} }), 2);
  });

  it("uses the base copy of the globs when --base-ref is given", () => {
    const dir = tempDir("journey-base-");
    const git = (...args) => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, "pstack.config.json"), configText);
    git("add", "-A");
    git("commit", "-qm", "base");
    // The head narrows userVisible so its own UI change escapes the rule.
    const loosened = JSON.parse(configText);
    loosened.journeyTests.userVisible = ["nothing/**"];
    writeFileSync(join(dir, "pstack.config.json"), JSON.stringify(loosened));
    git("commit", "-qam", "head");
    writeFileSync(join(dir, "changed.txt"), "M\tsrc/components/Card.tsx\n");
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt"], { stdout: () => {}, env: {} }), 0, "head copy is loosened");
    assert.equal(main(["--root", dir, "--changed-files-from", "changed.txt", "--base-ref", "HEAD^1"], { stdout: () => {}, env: {} }), 1, "base copy still applies");
    const proc = spawnSync(process.execPath, [join(repoRoot, "scripts/check-journey-tests.mjs"), "--root", dir, "--changed-files-from", "changed.txt", "--base-ref", "no-such-ref"], { encoding: "utf8" });
    assert.equal(proc.status, 2);
  });
});

describe("pstack config", () => {
  it("accepts an @user or @org/team ownerHandle, or the placeholder, and rejects anything else", () => {
    const withHandle = (ownerHandle) => parsePstackConfig({ ...JSON.parse(configText), project: { ...config.project, ownerHandle } });
    assert.equal(withHandle("@optomachina").project.ownerHandle, "@optomachina");
    assert.equal(withHandle("@acme/platform").project.ownerHandle, "@acme/platform");
    assert.equal(withHandle("{{OWNER_HANDLE}}").project.ownerHandle, "{{OWNER_HANDLE}}");
    for (const bad of ["optomachina", "@", "@a b", 7]) assert.throws(() => withHandle(bad), /ownerHandle/);
  });
});
