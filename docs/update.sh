#!/usr/bin/env bash
# Copies the stardoc output over the checked-in docs/defs.md.
set -euo pipefail
cp -f "$1" "${BUILD_WORKSPACE_DIRECTORY}/docs/defs.md"
chmod 644 "${BUILD_WORKSPACE_DIRECTORY}/docs/defs.md"
echo "updated docs/defs.md"
