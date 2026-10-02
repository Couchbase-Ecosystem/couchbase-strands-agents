#!/usr/bin/env bash
# Build the Python wheel, install only that wheel into a fresh virtualenv outside the repository and run
# examples/smoke_test.py with that interpreter, so the check uses the installed package the way a consumer
# would, not the source tree. examples/smoke_test.py needs a Couchbase cluster configured by COUCHBASE_*
# (see scripts/setup-live-couchbase.sh).
#
# Usage: scripts/smoke-test-python-package.sh [path/to/strands_couchbase-*.whl]   (builds the wheel when omitted)
# Env:   PYTHON (python3), the interpreter used to build and to create the virtualenv
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../python" && pwd)"
PYTHON="${PYTHON:-python3}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [[ $# -gt 0 ]]; then
  WHEEL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  (cd "$PACKAGE_DIR" && "$PYTHON" -m build --wheel --outdir "$WORK_DIR/dist" >/dev/null)
  WHEEL="$(ls "$WORK_DIR"/dist/*.whl)"
fi
echo "[smoke] wheel: $WHEEL"

"$PYTHON" -m venv "$WORK_DIR/venv"
VENV_PYTHON="$WORK_DIR/venv/bin/python"
"$VENV_PYTHON" -m pip install --quiet --upgrade pip
"$VENV_PYTHON" -m pip install --quiet "$WHEEL"

# Run from outside the repository so nothing on sys.path can resolve to the source tree.
cd "$WORK_DIR"
"$VENV_PYTHON" - <<'PY'
import sysconfig
from pathlib import Path

import strands_couchbase

module = Path(strands_couchbase.__file__).resolve()
site_packages = Path(sysconfig.get_paths()["purelib"]).resolve()
if site_packages not in module.parents:
    raise SystemExit(f"[smoke] strands_couchbase imported from {module}, not from {site_packages}")
print(f"[smoke] strands_couchbase imported from {module}")
PY

"$VENV_PYTHON" "$PACKAGE_DIR/examples/smoke_test.py"
echo "[smoke] examples/smoke_test.py ran against Couchbase from the installed wheel"
