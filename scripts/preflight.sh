#!/usr/bin/env bash
# Shared preflight: the same checks locally and in CI, driven by package.json.
# Usage: scripts/preflight.sh [stage ...]
#   No args runs pstack.config.json preflight.stages (default: typecheck lint test build).
#   A stage is an npm script name. A stage the project does not define prints
#   SKIP, unless it is listed in preflight.required (default: test), which FAILs.
# Exit codes: 0 pass, 1 code failure, 2 usage error. Each stage prints a
# "preflight: <stage> PASS|FAIL|SKIP" line so logs separate code failures from
# infra failures (install, network, runner), which fail before any stage starts.
set -uo pipefail

cd "$(dirname "$0")/.."

if ! command -v node > /dev/null 2>&1; then
  echo "preflight: node is not installed (infra failure, not a code failure)" >&2
  exit 2
fi
if [ ! -f package.json ]; then
  echo "preflight: no package.json in $(pwd)" >&2
  exit 2
fi

# Reads pstack.config.json (optional) and package.json; prints "stages" and
# "required" as space-separated lists, and the defined npm scripts.
read_config() {
  node --input-type=module -e '
    import { readFileSync, existsSync } from "node:fs";
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    let pre = {};
    if (existsSync("pstack.config.json")) pre = JSON.parse(readFileSync("pstack.config.json", "utf8")).preflight ?? {};
    const stages = pre.stages ?? ["typecheck", "lint", "test", "build"];
    const required = pre.required ?? ["test"];
    console.log(stages.join(" "));
    console.log(required.join(" "));
    console.log(Object.keys(pkg.scripts ?? {}).join(" "));
  '
}

if ! config="$(read_config)"; then
  echo "preflight: could not read package.json or pstack.config.json" >&2
  exit 2
fi
default_stages="$(sed -n 1p <<< "$config")"
required=" $(sed -n 2p <<< "$config") "
defined=" $(sed -n 3p <<< "$config") "

if [ $# -gt 0 ]; then
  stages=("$@")
else
  read -r -a stages <<< "$default_stages"
fi

for stage in "${stages[@]}"; do
  if ! [[ "$stage" =~ ^[A-Za-z0-9:_.-]+$ ]] || [ "$stage" = preflight ]; then
    echo "preflight: invalid stage '$stage'" >&2
    exit 2
  fi
done

status=0
for stage in "${stages[@]}"; do
  if [[ "$defined" != *" $stage "* ]]; then
    if [[ "$required" == *" $stage "* ]]; then
      echo "preflight: $stage FAIL (required, but package.json has no \"$stage\" script)"
      status=1
    else
      echo "preflight: $stage SKIP (no \"$stage\" script in package.json)"
    fi
    continue
  fi
  echo "preflight: $stage start"
  if npm run --silent "$stage"; then
    echo "preflight: $stage PASS"
  else
    echo "preflight: $stage FAIL"
    status=1
  fi
done

exit "$status"
