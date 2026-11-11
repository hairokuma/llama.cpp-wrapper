#!/usr/bin/env bash
# Starts whisper-server (speech-to-text) on port 8081, used by the voice UI and voice-assistant.py.
# Override with $WHISPER_BIN / $WHISPER_MODEL.
set -eu
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/whisper"

BIN="${WHISPER_BIN:-}"
if [ -z "$BIN" ]; then
    for c in "$W/build/bin/whisper-server" "$W/bin/whisper-server" "$(command -v whisper-server || true)"; do
        if [ -n "$c" ] && [ -x "$c" ]; then BIN="$c"; break; fi
    done
fi
[ -n "$BIN" ] || { echo "whisper-server not found: build whisper.cpp into $W or set WHISPER_BIN" >&2; exit 1; }

exec "$BIN" -m "${WHISPER_MODEL:-$W/models/ggml-small-q5_1.bin}" \
    --host 127.0.0.1 \
    --port 8081 \
    -l auto \
    -t "$(nproc 2>/dev/null || echo 8)" \
    -nt
