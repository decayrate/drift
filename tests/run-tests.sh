#!/bin/bash
# Automated test runner for drift
# Starts a local server, opens the test page, checks results via Python

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Running drift tests..."

# Use Python to serve files and run the test in a headless-like way
python3 "$SCRIPT_DIR/run-tests.py" "$PROJECT_DIR"
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "All tests passed."
else
  echo "Tests failed!"
  exit 1
fi
