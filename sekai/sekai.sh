#!/usr/bin/env bash
# sekai — shell wrapper for the Node API entrypoint.
# Usage: ./sekai.sh [--port 8787] [--host 127.0.0.1]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/index.js" "$@"
