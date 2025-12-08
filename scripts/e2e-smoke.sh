#!/usr/bin/env bash
# Minimal offline smoke test for cass-memory (bead cass_memory_system-7dlg)
# Runs: init -> context (offline) -> playbook add -> mark -> playbook list
# Logs each step as JSONL for debugging.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CM_BIN="${CM_BIN:-$ROOT/src/cm.ts}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/cm-e2e-$(date +%s)}"
LOG_FILE="$LOG_DIR/steps.jsonl"
ARTIFACTS="$LOG_DIR/artifacts"
mkdir -p "$LOG_DIR" "$ARTIFACTS"

# Helpers
timestamp() { date -Iseconds; }
log_step() {
  local step="$1" cmd="$2" exit="$3" duration="$4" stdout="$5" stderr="$6"
  cat <<JSON >>"$LOG_FILE"
{"t":"$(timestamp)","step":"$step","cmd":$cmd,"exit":$exit,"ms":$duration,"stdout":$stdout,"stderr":$stderr}
JSON
}

run_step() {
  local step="$1"; shift
  local start=$(date +%s%3N)
  # capture
  local out err
  out=$({ "$@" ; } 2> >(err=$(cat); typeset -p err >/tmp/errcap.$$) | tee /tmp/outcap.$$)
  # retrieve err captured
  if [[ -f /tmp/errcap.$$ ]]; then source /tmp/errcap.$$; fi
  local status=$?
  local end=$(date +%s%3N)
  local dur=$((end-start))
  # save artifacts
  echo "$out" > "$ARTIFACTS/${step}.out"
  echo "${err:-}" > "$ARTIFACTS/${step}.err"
  # truncate long outputs for log
  local to=$(printf '%s' "$out" | head -c 4000 | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  local te=$(printf '%s' "${err:-}" | head -c 4000 | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  local cmd_json
  cmd_json=$(python - <<PY
import json,sys
print(json.dumps(sys.argv[1:]))
PY
 "$@")
  log_step "$step" "$cmd_json" "$status" "$dur" "$to" "$te"
  return $status
}

# Use isolated HOME and disable cass/LLM
WORKDIR=$(mktemp -d)
export HOME="$WORKDIR"
export CASS_PATH="__missing__"
unset ANTHROPIC_API_KEY

echo "Running smoke in $WORKDIR; logs: $LOG_FILE"

run_step S1_init bun run "$CM_BIN" init
run_step S2_context bun run "$CM_BIN" context "hello world" --json
run_step S3_add_rule bun run "$CM_BIN" playbook add "Always write atomically" --category io --json
ID=$(bun run "$CM_BIN" playbook list --json | grep '\"id\"' | head -1 | cut -d '\"' -f4)
run_step S4_mark bun run "$CM_BIN" mark "$ID" --helpful --session smoke-1 --json
run_step S5_list bun run "$CM_BIN" playbook list --json

echo "Smoke completed. Artifacts in $LOG_DIR"
