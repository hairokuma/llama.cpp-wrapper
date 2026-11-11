#!/usr/bin/env bash
# Called by the model to restart its own server. The stop is delayed and detached
# so the current response can finish; start-llama.sh then starts it again.
name="$(basename "${LLAMA_BIN:-llama}")"
nohup sh -c "sleep 3; pkill -x '$name'" >/dev/null 2>&1 &
echo "llama server will restart in about 3 seconds"
