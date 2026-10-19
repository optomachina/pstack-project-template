import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SENSITIVE_PATHS_FILE } from "./lib/sensitive-paths.mjs";
import { REQUIRED_PHRASES, REQUIRED_SECTIONS, validateAgentContract } from "./validate-agent-contract.mjs";

const AGREEMENT = "A second model's agreement is review evidence; it never replaces a runnable acceptance check or a test.";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const agentsText = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
const listText = readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8");
const configText = readFileSync(join(repoRoot, "pstack.config.json"), "utf8");

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the contract files with optional replacements; null deletes a file. */
function contractCopy({ agents = agentsText, claude, list = listText, config = configText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-contract-"));
  temps.push(dir);
  mkdirSync(join(dir, "docs"));
  if (claude === undefined) copyFileSync(join(repoRoot, "CLAUDE.md"), join(dir, "CLAUDE.md"));
  else if (claude !== null) writeFileSync(join(dir, "CLAUDE.md"), claude);
  if (agents !== null) writeFileSync(join(dir, "AGENTS.md"), agents);
  if (list !== null) writeFileSync(join(dir, SENSITIVE_PATHS_FILE), list);
  if (config !== null) writeFileSync(join(dir, "pstack.config.json"), config);
  return dir;
}

describe("agent contract", () => {
  it("holds for the repository", () => {
    assert.deepEqual(validateAgentContract(repoRoot), []);
  });

  it("fails when the JSON has a glob AGENTS.md lacks, and the reverse", () => {
    const list = JSON.parse(listText);
    list.globs.push({ glob: "**/*.p8", class: "secrets" });
    assert.deepEqual(validateAgentContract(contractCopy({ list: JSON.stringify(list) })), [
      "sensitive path **/*.p8 (secrets) is in docs/sensitive-paths.json but not in the AGENTS.md list",
    ]);
    const agents = agentsText.replace("`**/*.key`", "`**/*.key`, `**/*.p8`");
    assert.deepEqual(validateAgentContract(contractCopy({ agents })), ["sensitive path **/*.p8 (secrets) is in the AGENTS.md list but not in docs/sensitive-paths.json"]);
  });

  it("fails when a required section or rule is removed", () => {
    for (const section of REQUIRED_SECTIONS) {
      const agents = agentsText.replace(new RegExp(`^## ${section}`, "m"), `## Renamed ${section}`);
      assert.ok(validateAgentContract(contractCopy({ agents })).includes(`AGENTS.md missing section: ${section}`), section);
    }
    const agents = agentsText.replaceAll("2 repair rounds", "some repair rounds");
    assert.ok(validateAgentContract(contractCopy({ agents })).includes("AGENTS.md missing: 2 repair rounds"));
  });

  it("requires the task contract section and the second-model agreement rule", () => {
    assert.ok(REQUIRED_SECTIONS.includes("Task contract"));
    assert.ok(REQUIRED_PHRASES.includes(AGREEMENT));
    assert.ok(agentsText.includes(AGREEMENT), "the repository's AGENTS.md carries the rule");
    const noSection = agentsText.replace(/^## Task contract$/m, "## Renamed task section");
    assert.ok(validateAgentContract(contractCopy({ agents: noSection })).includes("AGENTS.md missing section: Task contract"));
    const noPhrase = agentsText.replace(AGREEMENT, "A second model's agreement is enough.");
    assert.deepEqual(validateAgentContract(contractCopy({ agents: noPhrase })), [`AGENTS.md missing: ${AGREEMENT}`]);
  });

  it("keeps CLAUDE.md a thin pointer", () => {
    assert.ok(validateAgentContract(contractCopy({ claude: "# Claude\n\nDo whatever.\n" })).includes("CLAUDE.md must point to AGENTS.md"));
    assert.ok(validateAgentContract(contractCopy({ claude: `AGENTS.md\n${"x".repeat(3000)}` })).includes("CLAUDE.md is no longer a thin pointer"));
    assert.ok(validateAgentContract(contractCopy({ claude: null })).includes("CLAUDE.md is missing"));
  });

  it("requires every auto-merge category to be described", () => {
    const config = JSON.parse(configText);
    config.autoMerge.categories.push({ id: "generated_clients", label: "Generated", include: ["src/generated/**"] });
    assert.deepEqual(validateAgentContract(contractCopy({ config: JSON.stringify(config) })), ["auto-merge category generated_clients (pstack.config.json) is not described in AGENTS.md"]);
  });

  it("rejects leftover placeholders once the project is named", () => {
    const config = JSON.parse(configText);
    config.project = { name: "Acme", owner: "Dana", defaultBranch: "main" };
    // Put the placeholders back explicitly: a synced project's AGENTS.md has them filled.
    const agents = agentsText.replace(/^# .* agent contract$/m, "# {{PROJECT}} agent contract").replace("## Protected actions", "## Protected actions\n\nAsk {{OWNER}}.");
    const errors = validateAgentContract(contractCopy({ agents, config: JSON.stringify(config) }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /AGENTS\.md still has template placeholders: \{\{PROJECT\}\}, \{\{OWNER\}\}/);
  });

  it("reports unbalanced project markers, a missing list and an invalid config", () => {
    const agents = agentsText.replace("<!-- project:end ownership -->", "");
    assert.ok(validateAgentContract(contractCopy({ agents })).some((error) => /project:begin and .* project:end/.test(error)));
    assert.ok(validateAgentContract(contractCopy({ list: null })).includes(`${SENSITIVE_PATHS_FILE} is missing`));
    assert.ok(validateAgentContract(contractCopy({ config: JSON.stringify({ version: 1 }) })).some((error) => error.startsWith("pstack.config.json:")));
  });
});
