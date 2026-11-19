#!/usr/bin/env bash
# Start the real service (dev mode, token "dev") against the fake Hermes, signed in, serving ui/dist.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LANTERN_HOME="$(mktemp -d /tmp/hl-real-XXXX)"
export LANTERN_HOME
FAKE="http://127.0.0.1:${FAKE_PORT:-9461}"
for _ in $(seq 1 100); do curl -sf "$FAKE/api/status" >/dev/null && break; sleep 0.1; done
"$REPO/.venv/bin/lantern" setup "$FAKE" --no-signin >/dev/null
LANTERN_PASSWORD=pw "$REPO/.venv/bin/lantern" signin --username ada >/dev/null
exec "$REPO/.venv/bin/lantern" run --dev --port "${PORT:-8768}"
