import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkAgentsParity, parseSensitivePaths } from "./lib/sensitive-paths.mjs";
import { MANIFEST, PSTACK_SCRIPTS, VERSION_FILE, fillPlaceholders, main, mergeProjectBlocks, parseProjectBlocks, syncTemplate, unionSensitivePaths } from "./sync-template.mjs";
import { validateAgentContract } from "./validate-agent-contract.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix = "sync-target-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const read = (dir, file) => readFileSync(join(dir, file), "utf8");
const quiet = { stdout: () => {}, stderr: () => {} };

describe("project blocks", () => {
  it("keeps target block bodies by id and by position", () => {
    const template = ["# T", "<!-- project:begin a -->", "template a", "<!-- project:end a -->", "middle v2", "<!-- project:begin -->", "<!-- project:end -->", ""].join("\n");
    const target = ["# old", "<!-- project:begin a -->", "mine a", "more a", "<!-- project:end a -->", "middle v1", "<!-- project:begin -->", "mine unnamed", "<!-- project:end -->", ""].join("\n");
    const { text, orphans } = mergeProjectBlocks(template, target);
    assert.deepEqual(orphans, []);
    assert.equal(text, ["# T", "<!-- project:begin a -->", "mine a", "more a", "<!-- project:end a -->", "middle v2", "<!-- project:begin -->", "mine unnamed", "<!-- project:end -->", ""].join("\n"));
  });

  it("keeps an empty target block empty and works in comment syntaxes", () => {
    const template = "x\n# <!-- project:begin env -->\nDEFAULT=1\n# <!-- project:end env -->\n";
    assert.equal(mergeProjectBlocks(template, "# <!-- project:begin env -->\n# <!-- project:end env -->\n").text, "x\n# <!-- project:begin env -->\n# <!-- project:end env -->\n");
    assert.equal(mergeProjectBlocks(template, null).text, template);
  });

  it("appends target blocks the template dropped", () => {
    const { text, orphans } = mergeProjectBlocks("new\n", "old\n<!-- project:begin gone -->\nkeep me\n<!-- project:end gone -->\n");
    assert.deepEqual(orphans, ["gone"]);
    assert.match(text, /new\n\n<!-- project:begin gone -->\nkeep me\n<!-- project:end gone -->\n$/);
  });

  it("rejects nested, unclosed and mismatched markers", () => {
    assert.throws(() => parseProjectBlocks("<!-- project:begin a -->\n<!-- project:begin b -->"), /nested/);
    assert.throws(() => parseProjectBlocks("<!-- project:begin a -->\n"), /never closed/);
    assert.throws(() => parseProjectBlocks("<!-- project:end -->"), /without project:begin/);
    assert.throws(() => parseProjectBlocks("<!-- project:begin a -->\n<!-- project:end b -->"), /closes project:begin a/);
  });
});

describe("sensitive list union and placeholders", () => {
  const templateList = read(repoRoot, "docs/sensitive-paths.json");

  it("adds missing template globs and classes but never removes or reclassifies the target's", () => {
    const target = JSON.parse(templateList);
    target.globs = target.globs.filter((entry) => entry.glob !== "**/*.pem");
    target.globs.find((entry) => entry.glob === "**/*.key").class = "infra_ci";
    target.classes.pii = { label: "PII" };
    target.globs.push({ glob: "**/pii/**", class: "pii" });
    const { text, added } = unionSensitivePaths(templateList, JSON.stringify(target));
    assert.deepEqual(added, ["**/*.pem"]);
    const merged = parseSensitivePaths(text);
    assert.equal(merged.globs.find((entry) => entry.glob === "**/*.key").class, "infra_ci");
    assert.ok(merged.globs.some((entry) => entry.glob === "**/pii/**"));
    assert.deepEqual(unionSensitivePaths(templateList, templateList), { text: templateList, added: [] });
  });

  it("fills placeholders only with real values", () => {
    assert.equal(fillPlaceholders("{{PROJECT}} by {{OWNER}} on {{DEFAULT_BRANCH}}", { project: { name: "Acme", owner: "Dana", defaultBranch: "trunk" } }), "Acme by Dana on trunk");
    assert.equal(fillPlaceholders("{{PROJECT}}", { project: { name: "{{PROJECT}}" } }), "{{PROJECT}}");
    assert.equal(fillPlaceholders("{{OTHER}}", { project: { name: "Acme" } }), "{{OTHER}}");
  });
});

describe("syncTemplate", () => {
  it("installs every managed file into an empty project and the result validates", () => {
    const target = tempDir();
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "acme", scripts: { test: "vitest run" } }));
    assert.equal(main([target, "--project", "Acme", "--owner", "Dana", "--add-scripts"], quiet), 0);
    for (const { path } of MANIFEST) assert.ok(existsSync(join(target, path)), path);
    const agents = read(target, "AGENTS.md");
    assert.match(agents, /^# Acme agent contract/);
    assert.ok(!agents.includes("{{"), "placeholders filled");
    assert.deepEqual(validateAgentContract(target), []);
    const pkg = JSON.parse(read(target, "package.json"));
    assert.equal(pkg.scripts.test, "vitest run", "existing scripts are kept");
    assert.equal(pkg.scripts.preflight, PSTACK_SCRIPTS.preflight);
    const version = JSON.parse(read(target, VERSION_FILE));
    assert.equal(version.template, "pstack-template");
    assert.equal(version.version, JSON.parse(read(repoRoot, "package.json")).version);
    assert.equal(Object.keys(version.files).length, MANIFEST.length);
  });

  it("preserves project sections, pstack.config.json and added sensitive globs on update", () => {
    const target = tempDir();
    syncTemplate({ target, project: "Acme", owner: "Dana" });
    // Project edits: a project block, a customized config, and an extra sensitive glob.
    const agentsPath = join(target, "AGENTS.md");
    writeFileSync(agentsPath, read(target, "AGENTS.md").replace(/(<!-- project:begin project-rules -->\n)[\s\S]*?(<!-- project:end project-rules -->)/, "$1- Use the acme-deploy skill for releases.\n$2"));
    const config = JSON.parse(read(target, "pstack.config.json"));
    config.journeyTests.journeyTests = ["playwright/journeys/**"];
    writeFileSync(join(target, "pstack.config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const list = JSON.parse(read(target, "docs/sensitive-paths.json"));
    list.globs.push({ glob: "**/customer-exports/**", class: "secrets" });
    writeFileSync(join(target, "docs/sensitive-paths.json"), JSON.stringify(list, null, 2));
    // Drift outside a project block is template-owned and gets reset.
    writeFileSync(agentsPath, read(target, "AGENTS.md").replace("## Completion and failure", "## Completion and failure (edited locally)"));

    const { actions } = syncTemplate({ target });
    const byPath = Object.fromEntries(actions.map((action) => [action.path, action.action]));
    assert.equal(byPath["pstack.config.json"], "kept");
    assert.equal(byPath["AGENTS.md"], "update");
    assert.equal(byPath["scripts/review-gate.mjs"], "unchanged");
    const agents = read(target, "AGENTS.md");
    assert.match(agents, /- Use the acme-deploy skill for releases\./);
    assert.match(agents, /^## Completion and failure$/m);
    assert.match(agents, /`\*\*\/customer-exports\/\*\*`/, "AGENTS.md list regenerated from the project's list");
    assert.deepEqual(checkAgentsParity(agents, parseSensitivePaths(read(target, "docs/sensitive-paths.json"))), []);
    assert.deepEqual(JSON.parse(read(target, "pstack.config.json")).journeyTests.journeyTests, ["playwright/journeys/**"]);
    assert.deepEqual(validateAgentContract(target), []);
  });

  it("writes nothing on --dry-run", () => {
    const target = tempDir();
    const lines = [];
    assert.equal(main([target, "--dry-run"], { stdout: (line) => lines.push(line), stderr: () => {} }), 0);
    assert.ok(lines.some((line) => line.startsWith("create    AGENTS.md")));
    assert.ok(lines.some((line) => /dry run, nothing written/.test(line)));
    assert.equal(existsSync(join(target, "AGENTS.md")), false);
    assert.equal(existsSync(join(target, VERSION_FILE)), false);
  });

  it("leaves placeholders when the project is not named yet", () => {
    const target = tempDir();
    syncTemplate({ target });
    assert.match(read(target, "AGENTS.md"), /^# \{\{PROJECT\}\} agent contract/);
    assert.deepEqual(validateAgentContract(target), [], "a template-mode config allows placeholders");
  });

  it("never writes through a symlink and refuses bad targets", () => {
    const target = tempDir();
    const outside = tempDir("sync-outside-");
    writeFileSync(join(outside, "victim.md"), "untouched\n");
    symlinkSync(join(outside, "victim.md"), join(target, "CLAUDE.md"));
    const { actions, warnings } = syncTemplate({ target });
    assert.equal(actions.find((action) => action.path === "CLAUDE.md").action, "skipped");
    assert.ok(warnings.some((warning) => warning.includes("symlink")));
    assert.equal(read(outside, "victim.md"), "untouched\n");
    assert.equal(main([repoRoot], quiet), 2, "the template itself");
    assert.equal(main([join(target, "missing")], quiet), 2);
    assert.equal(main([], quiet), 2);
    assert.equal(main([target, "--bogus"], quiet), 2);
  });

  it("covers every template-managed file that exists in the template", () => {
    for (const { path } of MANIFEST) assert.ok(existsSync(join(repoRoot, path)), path);
  });
});
