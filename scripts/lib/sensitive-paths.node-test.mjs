import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASE_REF_UNAVAILABLE,
  BaseRefError,
  DEFAULT_SENSITIVE_CLASSES,
  GATE_CODE_FILES,
  LOOSENING_CLASS_REMOVED,
  LOOSENING_CONFIG_INVALID,
  LOOSENING_CONFIG_REMOVED,
  LOOSENING_GLOB_NARROWED,
  LOOSENING_GLOB_RECLASSIFIED,
  LOOSENING_GLOB_REMOVED,
  LOOSENING_MATCHER_CHANGED,
  MATCHER_PATH,
  SENSITIVE_PATHS_FILE,
  checkAgentsParity,
  classNames,
  classifyPaths,
  compileGlob,
  createMatcher,
  findGateLoosening,
  globMatcher,
  globProblem,
  loadSensitivePaths,
  main,
  normalizePath,
  parseNameStatus,
  parseSensitivePaths,
  pathCandidates,
  readSensitivePathsText,
  renderAgentsSensitiveList,
  replaceAgentsSensitiveBlock,
  triageRoute,
  unquoteGitPath,
} from "./sensitive-paths.mjs";
import { decide } from "../review-gate.mjs";
import { isTemplateConfig, loadPstackConfig } from "./pstack-config.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const libPath = fileURLToPath(new URL("./sensitive-paths.mjs", import.meta.url));
// picomatch is the semantic reference (a dev dependency); the matcher itself stays dependency-free.
let picomatch = null;
try {
  picomatch = createRequire(import.meta.url)("picomatch");
} catch {
  picomatch = null;
}
const PICOMATCH_OPTIONS = { dot: true, nocase: true };
const needsPicomatch = picomatch ? {} : { skip: "picomatch is not installed (npm install -D picomatch)" };

const fixture = JSON.parse(readFileSync(join(repoRoot, "scripts/fixtures/sensitive-paths/paths.json"), "utf8")).paths;
const config = loadSensitivePaths({ root: repoRoot });
const configText = readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8");
const agentsText = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
const pstackConfig = loadPstackConfig({ root: repoRoot });
// In the template repository the list is the template's, so classes match exactly;
// a project may add globs, so it may gain classes but never lose one.
const exact = isTemplateConfig(pstackConfig);
const assertClasses = (actual, expected, message) => {
  if (exact) assert.deepEqual(actual, expected, message);
  else for (const name of expected) assert.ok(actual.includes(name), `${message}: missing ${name} in ${JSON.stringify(actual)}`);
};

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const picomatchClasses = (file, cfg = config) => classNames(cfg).filter((name) => cfg.globs.some((entry) => entry.class === name && picomatch(entry.glob, PICOMATCH_OPTIONS)(file)));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const withGlobs = (mutate) => {
  const copy = JSON.parse(configText);
  mutate(copy.globs, copy);
  return JSON.stringify(copy);
};

/** A git repo whose base commit holds the list (and AGENTS.md) and whose head applies `change`. */
function repoWithChange(prefix, change, { baseList = true } = {}) {
  const dir = tempDir(prefix);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  if (baseList) {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), configText);
    writeFileSync(join(dir, "AGENTS.md"), agentsText);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  change(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
  writeFileSync(join(dir, "changed.z"), git(dir, "diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"));
  return dir;
}

describe("sensitive-paths config", () => {
  it("is a valid document whose every class has globs", () => {
    assert.equal(config.version, 1);
    for (const name of classNames(config)) assert.ok(config.globs.some((entry) => entry.class === name), name);
    for (const name of DEFAULT_SENSITIVE_CLASSES) assert.ok(classNames(config).includes(name), `template class ${name} kept`);
  });

  it("rejects unknown classes, duplicates, classless entries and unsupported glob syntax", () => {
    assert.throws(() => parseSensitivePaths(withGlobs((globs) => globs.push({ glob: "x/**", class: "misc" }))), /unknown class misc/);
    assert.throws(() => parseSensitivePaths(withGlobs((globs) => globs.push({ ...globs[0] }))), /duplicate glob/);
    assert.throws(() => parseSensitivePaths(withGlobs((_globs, copy) => (copy.classes.empty = { label: "Empty" }))), /class empty has no globs/);
    for (const glob of ["src/[ab].ts", "!src/**", "/abs/**", "a//b", "a/../b", "+(a|b)", "{a}", "{a,b", "a\\b"]) {
      assert.notEqual(globProblem(glob), null, glob);
    }
    assert.throws(() => parseSensitivePaths({ ...JSON.parse(configText), version: 2 }), /version must be 1/);
  });
});

describe("shared fixture", () => {
  it("covers every template class and some non-sensitive paths", () => {
    assert.ok(fixture.length >= 40);
    for (const name of DEFAULT_SENSITIVE_CLASSES) assert.ok(fixture.some((entry) => entry.classes.includes(name)), name);
    assert.ok(fixture.some((entry) => entry.classes.length === 0));
  });

  it("gives the same classification from every consumer", () => {
    const matcher = createMatcher(config);
    const batch = classifyPaths(fixture.map((entry) => entry.path), config);
    const cli = [];
    assert.equal(main(["classify", "--root", repoRoot, "--json", ...fixture.map((entry) => entry.path)], { stdout: (line) => cli.push(line) }), 0);
    const cliFiles = JSON.parse(cli.join("\n")).files;
    for (const [index, { path, classes }] of fixture.entries()) {
      const actual = matcher.classify(path);
      assertClasses(actual, classes, `matcher ${JSON.stringify(path)}`);
      if (picomatch) assert.deepEqual(picomatchClasses(path), actual, `picomatch ${JSON.stringify(path)}`);
      assert.equal(batch.files[index].path, path);
      assert.deepEqual(batch.files[index].classes, actual, `batch ${path}`);
      assert.deepEqual(cliFiles[index].classes, actual, `cli ${path}`);
      assert.deepEqual(triageRoute([path], config), { route: actual.length ? "architect_first" : "standard", classes: actual }, `triage ${path}`);
      // Review gate: any sensitive file makes the PR risky and Opus-reviewed.
      const decision = decide({ files: [path], sensitivePaths: config, pstackConfig });
      if (actual.length) assert.equal(decision.review_tier, "opus", `review gate ${path}`);
      assert.deepEqual(decision.sensitive.classes, actual, `review gate classes ${path}`);
    }
  });

  it("runs the CLI as a process with the same answer", () => {
    const sample = fixture.slice(0, 5);
    const out = execFileSync(process.execPath, [libPath, "classify", "--root", repoRoot, "--json", ...sample.map((entry) => entry.path)], { encoding: "utf8" });
    JSON.parse(out).files.forEach((file, index) => assertClasses(file.classes, sample[index].classes, sample[index].path));
  });

  it("runs the CLI when invoked through a symlinked directory (macOS /tmp is one)", () => {
    const link = join(tempDir("sensitive-paths-link-"), "repo");
    symlinkSync(repoRoot, link, "dir");
    const script = join(link, MATCHER_PATH);
    const ok = spawnSync(process.execPath, [script, "classify", "--root", repoRoot, ".env.production", "docs/foo.md"], { encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^\.env\.production: .*secrets/m);
    assert.match(ok.stdout, /^docs\/foo\.md: -$/m);
    const bad = spawnSync(process.execPath, [script, "classify", "--root", repoRoot, "--base-ref", "no-such-ref", ".env.production"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /does not resolve to a commit/);
  });
});

describe("matcher semantics", () => {
  const extraPaths = [
    "a", "auth", "x/auth", "auth/x", ".github", ".github/workflows", "deep/.config/.env", "keys", "x/keys",
    "scripts/deploy", "scripts/deployment/x/y.sh", "supabase/config.toml.bak", "src/AUTH.ts", "token.yaml",
    "tokens.js", "token.txt", "rls", "src/curls.ts", "a_rls_b.sql", "Cargo.lock", "infra", "infra/x", "migrations", "x/migrations/y",
  ];

  it("matches picomatch {dot, nocase} for every glob and path", needsPicomatch, () => {
    for (const { glob } of config.globs) {
      const regex = compileGlob(glob);
      const reference = picomatch(glob, PICOMATCH_OPTIONS);
      for (const file of [...fixture.map((entry) => entry.path), ...extraPaths]) {
        assert.equal(regex.test(file), reference(file), `${glob} vs ${JSON.stringify(file)}`);
      }
    }
  });

  it("matches dotfiles and nested **/.env", () => {
    const matcher = createMatcher(config);
    for (const file of [".env", "a/.env", "a/b/c/.env", "a/b/.env.test", ".envrc", "./.env", "a\\b\\.env"]) {
      assert.ok(matcher.classify(file).includes("secrets"), file);
    }
    assert.ok(matcher.classify(".github/workflows/x.yml").includes("infra_ci"));
    assert.equal(compileGlob("**/.env").test("a/b/.env"), true);
    assert.equal(compileGlob("**/.env").test(".env"), true);
    assert.equal(compileGlob("**/.env").test("a/.envx"), false);
  });

  it("ignores case so renamed or upper-case paths still match", () => {
    const matcher = createMatcher(config);
    assertClasses(matcher.classify("Supabase/Migrations/1_x.SQL"), ["schema", "migrations"], "upper-case migration");
    assert.ok(matcher.classify(".GITHUB/WORKFLOWS/CI.YML").includes("infra_ci"));
    assert.ok(matcher.classify("src/StripeClient.ts").includes("payments"));
    assert.ok(matcher.classify("Package.JSON").includes("deps"));
  });

  it("keeps a backslash as a file-name character and also matches it read as a separator", () => {
    const matcher = createMatcher(config);
    for (const [file, name] of [[".env\\production", "secrets"], ["Dockerfile\\prod", "infra_ci"], ["docker-compose\\x.yml", "infra_ci"], ["requirements\\dev.txt", "deps"]]) {
      assert.ok(matcher.classify(file).includes(name), file);
      if (picomatch) assert.ok(picomatchClasses(file).includes(name), `picomatch ${file}`);
      assert.equal(classifyPaths([file], config).files[0].path, file);
    }
    // Read with "\\" as separators too: a superset of picomatch on the raw name.
    assert.ok(matcher.classify("db\\migrations\\x.sql").includes("migrations"));
    assert.equal(normalizePath(".env\\production"), ".env\\production");
    assert.equal(normalizePath("./a/b"), "a/b");
    assert.equal(normalizePath("/.//a"), "a");
    const candidates = pathCandidates("a\\b\\.env");
    assert.ok(candidates.includes("a\\b\\.env") && candidates.includes("a/b/.env"));
  });

  it("matches every other reading of a path (trimmed, resolved, git-quoted)", () => {
    const matcher = createMatcher(config);
    for (const [file, name] of [
      [" .env", "secrets"],
      [".github//workflows/ci.yml", "infra_ci"],
      ["x/../.github/workflows/ci.yml", "infra_ci"],
      ["./.github/./workflows/ci.yml", "infra_ci"],
      ['"db/caf\\303\\251.sql"', "schema"],
      ['".github/workflows/tab\\tname.yml"', "infra_ci"],
    ]) {
      assert.ok(matcher.classify(file).includes(name), JSON.stringify(file));
    }
    assert.deepEqual(matcher.classify('"a\\qb.sql"'), [], "invalid git quoting is matched as given");
    assert.deepEqual(matcher.classify("src/lib/urls.ts"), []);
  });

  it("lets ** cross a newline in a name, where picomatch's does not (fail closed)", () => {
    const matcher = createMatcher(config);
    for (const [file, name] of [[".github/workflows/new\nline.yml", "infra_ci"], ["cfg/new\nline/.env", "secrets"], ["new\nline/a.sql", "schema"]]) {
      assert.ok(matcher.classify(file).includes(name), JSON.stringify(file));
    }
    if (picomatch) assert.equal(picomatch(".github/workflows/**", PICOMATCH_OPTIONS)(".github/workflows/new\nline.yml"), false);
  });

  it("exposes the same semantics to other gates through globMatcher", () => {
    const isUi = globMatcher(["src/components/**", "**/*.{css,scss}"]);
    assert.equal(isUi("src/components/Button.tsx"), true);
    assert.equal(isUi("SRC/Components/x.tsx"), true);
    assert.equal(isUi("styles/app.SCSS"), true);
    assert.equal(isUi("src/lib/x.ts"), false);
    assert.equal(globMatcher([])("anything"), false);
  });
});

describe("name-status parsing", () => {
  it("reads NUL-separated -z output, including rename and copy pairs", () => {
    assert.deepEqual(parseNameStatus(`M\0db/café.sql\0A\0.github/workflows/tab\tname.yml\0R100\0${MATCHER_PATH}\0x.mjs\0C75\0a.ts\0b.ts\0D\0q"x.sql\0`), [
      { status: "M", file: "db/café.sql" },
      { status: "A", file: ".github/workflows/tab\tname.yml" },
      { status: "D", file: MATCHER_PATH },
      { status: "A", file: "x.mjs" },
      { status: "A", file: "b.ts" },
      { status: "D", file: 'q"x.sql' },
    ]);
    assert.throws(() => parseNameStatus("M\0a.ts\0b.ts\0"), /expected a status/);
    assert.throws(() => parseNameStatus("R100\0a.ts\0"), /missing its path/);
  });

  it("unquotes the names git quotes in newline output", () => {
    const quoted = ['A\t".github/workflows/caf\\303\\251.yml"', 'A\t".github/workflows/tab\\tname.yml"', 'A\t"cfg/new\\nline/.env"', 'A\t"db/quote\\"name.sql"', "M\tplain.txt", "bare.md"].join("\n");
    assert.deepEqual(parseNameStatus(quoted), [
      { status: "A", file: ".github/workflows/café.yml" },
      { status: "A", file: ".github/workflows/tab\tname.yml" },
      { status: "A", file: "cfg/new\nline/.env" },
      { status: "A", file: 'db/quote"name.sql' },
      { status: "M", file: "plain.txt" },
      { status: "M", file: "bare.md" },
    ]);
    assert.equal(unquoteGitPath('"a\\\\b"'), "a\\b");
    assert.throws(() => unquoteGitPath('"a\\qb"'), /bad escape/);
  });

  it("reports names git would quote as sensitive (end to end through git diff -z)", () => {
    const special = [
      ...fixture.filter((entry) => /[^\x20-\x7e]|["\\\t]/.test(entry.path)),
      { path: "db/back\\slash.sql", classes: ["schema"] },
      { path: "cfg/new\nline/.env", classes: ["secrets"] },
    ];
    const dir = repoWithChange("sensitive-quoted-", (root) => {
      for (const { path } of special) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), "x\n");
      }
      writeFileSync(join(root, "plain.txt"), "x\n");
    });
    assert.equal(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: () => {} }), 0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    const classesOf = (file) => report.files.find((entry) => entry.path.normalize("NFC") === file.normalize("NFC"))?.classes;
    for (const entry of special) assertClasses(classesOf(entry.path), entry.classes, JSON.stringify(entry.path));
    assert.deepEqual(classesOf("plain.txt"), []);
    assert.equal(report.files.length, special.length + 1);
    writeFileSync(join(dir, "changed.txt"), git(dir, "diff", "--name-status", "--no-renames", "HEAD^1", "HEAD"));
    assert.equal(main(["report", "--root", dir, "--changed-files-from", "changed.txt", "--base-ref", "HEAD^1", "--json-out", "lines.json"], { stdout: () => {} }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "lines.json"), "utf8")).files, report.files);
  });
});

describe("AGENTS.md parity", () => {
  it("holds for the repository", () => {
    assert.deepEqual(checkAgentsParity(agentsText, config), []);
  });

  it("detects a glob missing from either side and a moved glob", () => {
    const extra = JSON.parse(withGlobs((globs) => globs.push({ glob: "**/*.p8", class: "secrets" })));
    assert.deepEqual(checkAgentsParity(agentsText, extra).length, 1);
    assert.match(checkAgentsParity(agentsText, extra)[0], /\*\*\/\*\.p8 \(secrets\) is in docs\/sensitive-paths\.json but not in the AGENTS\.md list/);
    const agents = agentsText.replace("`**/*.key`", "`**/*.key`, `**/*.p8`");
    assert.match(checkAgentsParity(agents, config)[0], /\*\*\/\*\.p8 \(secrets\) is in the AGENTS\.md list but not in/);
    const moved = agentsText.replace(", `**/*.key`", "").replace("`**/package.json`", "`**/package.json`, `**/*.key`");
    assert.equal(checkAgentsParity(moved, config).length, 2);
    assert.match(checkAgentsParity(agentsText.replace("<!-- sensitive-paths:begin -->", ""), config)[0], /missing the/);
  });

  it("renders the block from the JSON so parity can be restored mechanically", () => {
    const extra = JSON.parse(withGlobs((globs) => globs.push({ glob: "**/*.p8", class: "secrets" })));
    const rendered = replaceAgentsSensitiveBlock(agentsText, extra);
    assert.deepEqual(checkAgentsParity(rendered, extra), []);
    assert.equal(replaceAgentsSensitiveBlock(agentsText, config), agentsText, "the committed block is the rendered one");
    assert.equal(renderAgentsSensitiveList(config).split("\n").length, classNames(config).length);
  });
});

describe("gate loosening", () => {
  const codes = (result) => result.reasons.map((reason) => reason.code);

  it("does not flag an unchanged config or an added glob or class", () => {
    assert.equal(findGateLoosening({ baseText: configText, headText: configText }).detected, false);
    const added = withGlobs((globs, copy) => {
      globs.push({ glob: "**/*.p8", class: "secrets" });
      copy.classes.pii = { label: "PII" };
      globs.push({ glob: "**/pii/**", class: "pii" });
    });
    assert.deepEqual(findGateLoosening({ baseText: configText, headText: added }), { detected: false, reasons: [], requires: ["owner_approval", "opus_review"] });
  });

  it("flags a narrowed glob", () => {
    const narrowed = withGlobs((globs) => {
      globs.find((entry) => entry.glob === "**/migrations/**").glob = "**/migrations/*.sql";
    });
    const result = findGateLoosening({ baseText: configText, headText: narrowed });
    assert.equal(result.detected, true);
    assert.deepEqual(codes(result), [LOOSENING_GLOB_NARROWED]);
    assert.equal(result.reasons[0].glob, "**/migrations/**");
  });

  it("flags removed and reclassified globs, a removed class, and a deleted or invalid file", () => {
    const removed = withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1));
    assert.deepEqual(codes(findGateLoosening({ baseText: configText, headText: removed })), [LOOSENING_GLOB_REMOVED]);
    const moved = withGlobs((globs) => {
      globs.find((entry) => entry.glob === "**/*.pem").class = "infra_ci";
    });
    assert.deepEqual(codes(findGateLoosening({ baseText: configText, headText: moved })), [LOOSENING_GLOB_RECLASSIFIED]);
    const noDeps = withGlobs((globs, copy) => {
      delete copy.classes.deps;
      for (let k = globs.length - 1; k >= 0; k -= 1) if (globs[k].class === "deps") globs.splice(k, 1);
    });
    const depsCodes = codes(findGateLoosening({ baseText: configText, headText: noDeps }));
    assert.equal(depsCodes[0], LOOSENING_CLASS_REMOVED);
    assert.ok(depsCodes.slice(1).every((code) => code === LOOSENING_GLOB_REMOVED));
    assert.deepEqual(codes(findGateLoosening({ baseText: configText, headText: null })), [LOOSENING_CONFIG_REMOVED]);
    assert.deepEqual(codes(findGateLoosening({ baseText: configText, headText: "{" })), [LOOSENING_CONFIG_INVALID]);
  });

  it("flags edits to gate code but not its introduction", () => {
    for (const file of GATE_CODE_FILES) {
      assert.ok(existsSync(join(repoRoot, file)), `${file} exists`);
      assert.deepEqual(codes(findGateLoosening({ changedFiles: [{ status: "M", file }] })), [LOOSENING_MATCHER_CHANGED], file);
      assert.deepEqual(codes(findGateLoosening({ changedFiles: [{ status: "D", file }] })), [LOOSENING_MATCHER_CHANGED], file);
      assert.equal(findGateLoosening({ changedFiles: [{ status: "A", file }] }).detected, false, file);
    }
    assert.equal(findGateLoosening({ baseText: null, headText: configText }).detected, false);
  });

  it("puts the files that control the gates on the list, so editing any of them is sensitive", () => {
    const matcher = createMatcher(config);
    for (const file of [...GATE_CODE_FILES, SENSITIVE_PATHS_FILE, "AGENTS.md", "CLAUDE.md", "pstack.config.json", "scripts/lib/sensitive-paths.node-test.mjs", "scripts/sync-template.mjs"]) {
      assert.ok(matcher.classify(file).includes("infra_ci"), file);
    }
  });

  it("classifies with the base checkout's JSON and reports loosening (report mode)", () => {
    // The head drops the .env glob and adds a .env file in the same PR.
    const dir = repoWithChange("sensitive-report-", (root) => {
      writeFileSync(join(root, SENSITIVE_PATHS_FILE), withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1)));
      writeFileSync(join(root, ".env.local"), "PLACEHOLDER=1\n");
    });
    const lines = [];
    assert.equal(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: (line) => lines.push(line) }), 0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(report.config_source, "base");
    assert.ok(report.files.find((file) => file.path === ".env.local").classes.includes("secrets"));
    assert.equal(report.gate_loosening.detected, true);
    assert.ok(report.gate_loosening.reasons.some((reason) => reason.code === LOOSENING_GLOB_REMOVED && reason.glob === "**/.env*"));
    assert.ok(report.parity_errors.some((error) => /\*\*\/\.env\* \(secrets\) is in the AGENTS\.md list but not in/.test(error)));
    assert.match(lines.join("\n"), /^GATE LOOSENING: needs owner approval \+ Opus review \(report only, does not block\)/);
  });

  it("never falls back to the head list when an explicit --base-ref cannot be read", () => {
    const dir = repoWithChange("sensitive-base-ref-", (root) => {
      writeFileSync(join(root, SENSITIVE_PATHS_FILE), withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1)));
      writeFileSync(join(root, ".env.production"), "PLACEHOLDER=1\n");
    });
    for (const ref of ["no-such-ref", "", "  ", "-x", "HEAD~5"]) {
      assert.throws(() => readSensitivePathsText({ root: dir, ref }), BaseRefError, JSON.stringify(ref));
      assert.throws(() => loadSensitivePaths({ root: dir, ref }), (error) => error.code === BASE_REF_UNAVAILABLE, JSON.stringify(ref));
    }
    assert.equal(readSensitivePathsText({ root: dir, ref: "HEAD^1" }), configText);
    for (const ref of ["no-such-ref", ""]) {
      const out = [];
      const err = [];
      assert.equal(main(["classify", "--root", dir, "--base-ref", ref, ".env.production"], { stdout: (line) => out.push(line), stderr: (line) => err.push(line) }), 2);
      assert.deepEqual(out, []);
      assert.match(err.join("\n"), ref ? /does not resolve to a commit/ : /base ref is empty/);
      assert.equal(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", ref, "--json-out", "bad.json"], { stdout: (line) => out.push(line), stderr: () => {} }), 2);
      assert.equal(existsSync(join(dir, "bad.json")), false);
    }
    const proc = spawnSync(process.execPath, [libPath, "classify", "--root", dir, "--base-ref", "", ".env.production"], { encoding: "utf8" });
    assert.equal(proc.status, 2);
    assert.equal(proc.stdout, "");
    const json = [];
    assert.equal(main(["classify", "--root", dir, "--base-ref", "HEAD^1", "--json", ".env.production"], { stdout: (line) => json.push(line) }), 0);
    const parsed = JSON.parse(json.join("\n"));
    assert.equal(parsed.config_source, "base");
    assert.ok(parsed.classes.includes("secrets"));
  });

  it("uses the head list only when the base commit exists and has no list (the PR that adds it)", () => {
    const dir = repoWithChange(
      "sensitive-introduce-",
      (root) => {
        mkdirSync(join(root, "docs"), { recursive: true });
        writeFileSync(join(root, SENSITIVE_PATHS_FILE), configText);
        writeFileSync(join(root, ".env.local"), "PLACEHOLDER=1\n");
      },
      { baseList: false },
    );
    assert.equal(readSensitivePathsText({ root: dir, ref: "HEAD^1" }), null);
    const lines = [];
    assert.equal(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: (line) => lines.push(line) }), 0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(report.config_source, "head");
    assert.match(lines.join("\n"), /config from head/);
  });

  it("returns 2 on usage errors", () => {
    const errors = [];
    assert.equal(main(["report"], { stdout: () => {}, stderr: (line) => errors.push(line) }), 2);
    assert.equal(main(["nope"], { stdout: () => {}, stderr: (line) => errors.push(line) }), 2);
    assert.equal(errors.length, 2);
  });
});
