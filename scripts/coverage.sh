#!/usr/bin/env bash
# Run bun test with coverage and emit artifacts with consistent naming.
# Usage: LOG_DIR=/tmp/cm-coverage-123 ./scripts/coverage.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/cm-coverage-$(date +%s)}"
ARTIFACTS="$LOG_DIR/artifacts"
mkdir -p "$ARTIFACTS"

echo "Running coverage; artifacts in $LOG_DIR"

start=$(date +%s%3N)

# bun coverage output goes to stdout; capture and also tee to file
if bun test --coverage | tee "$ARTIFACTS/coverage.txt"; then
  status=0
else
  status=$?
fi

end=$(date +%s%3N)
dur=$((end-start))

# Summarize (very lightweight): grab totals line if present
summary=$(grep -E "Statements|All files" "$ARTIFACTS/coverage.txt" || true)
cat <<JSON >"$LOG_DIR/summary.json"
{
  "exit_code": $status,
  "duration_ms": $dur,
  "summary": "$(echo "$summary" | tr '\n' ' ' | sed 's/\"/\\\"/g')",
  "coverage_report": "$ARTIFACTS/coverage.txt"
}
JSON

echo "Done. Exit $status, duration ${dur}ms"
exit $status
