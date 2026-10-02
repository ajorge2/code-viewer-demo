#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
venv_path="$repo_root/.tools/intent-audit-venv"
requirements="$repo_root/experiments/intent-algebra/requirements-audit-notebook.txt"

python3 -m venv "$venv_path"
"$venv_path/bin/python" -m pip install --upgrade pip
"$venv_path/bin/python" -m pip install -r "$requirements"

echo "Audit environment ready."
echo "Launch with: $venv_path/bin/jupyter lab $repo_root/experiments/intent-algebra/notebooks/01_steps_1_2_calibration_audit.ipynb"
