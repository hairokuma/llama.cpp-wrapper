#!/usr/bin/env bash
# Starts the llama server and restarts it whenever it exits (stop with Ctrl+C).
#   ./scripts/start-llama.sh                        built-in web UI
#   ./scripts/start-llama.sh --custom-ui            custom web UI (voice mode + automatic AGENTS.md loading)
#   ./scripts/start-llama.sh --model ~/models/x.gguf  use a specific model
# Model: --model, else $LLAMA_MODEL, else the first .gguf in models/.
# Binary: $LLAMA_BIN, else `llama` from PATH.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo folder
export LLAMA_BIN="${LLAMA_BIN:-llama}"   # exported: restart-llama.sh needs the process name
PYTHON="${PYTHON:-python3}"
MODEL="${LLAMA_MODEL:-}"
CUSTOM_UI=0

while [ $# -gt 0 ]; do
    case "$1" in
        --custom-ui) CUSTOM_UI=1 ;;
        --model) MODEL="${2:?--model needs a file}"; shift ;;
        -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ -z "$MODEL" ]; then
    MODEL="$(ls "$ROOT"/models/*.gguf 2>/dev/null | head -n 1)"
fi
if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
    echo "No model found: pass --model <file.gguf>, set LLAMA_MODEL or put a .gguf into $ROOT/models/" >&2
    exit 1
fi

# Chat template = the model's own + OS/date/time info (see app/chat-template.jinja), rendered by the server
# for every request, so any client gets it without tools.
if [ -r /etc/os-release ]; then OS_NAME="$(. /etc/os-release && echo "$PRETTY_NAME")"
elif command -v sw_vers >/dev/null; then OS_NAME="macOS $(sw_vers -productVersion)"
else OS_NAME="$(uname -sr)"; fi
export LLAMA_ARG_CHAT_TEMPLATE_FILE="$ROOT/app/chat-template.jinja"
export LLAMA_ARG_CHAT_TEMPLATE_KWARGS="$(python3 -c 'import json,sys; print(json.dumps({"env_os": sys.argv[1]}))' "$OS_NAME")"

trap 'exit 130' INT
while true; do
    ui=()
    if [ "$CUSTOM_UI" = 1 ]; then
        # rebuild the custom web UI copy (follows llama updates); fall back to the built-in UI
        if "$PYTHON" "$ROOT/app/build-voice-ui.py"; then
            ui=(--path "$ROOT/app/.webui")
        else
            echo "warning: building the custom web UI failed - using the built-in UI" >&2
        fi
    fi
    # mcp.json -> app/.mcp.resolved.json (paths filled in)
    "$PYTHON" "$ROOT/app/prepare-mcp.py" || exit 1

    # See start-llama.ps1 for the optional --context-shift --keep -1 flags.
    "$LLAMA_BIN" serve -m "$MODEL" \
        -c 64000 \
        --host 127.0.0.1 \
        --port 8080 \
        --load-mode none \
        --tools all \
        --mcp-servers-config "$ROOT/app/.mcp.resolved.json" \
        --ui-config-file "$ROOT/ui-config.json" \
        --reasoning-format deepseek \
        --log-prompts-dir "$ROOT/.prompt-logs" \
        ${ui[@]+"${ui[@]}"}
    echo "llama exited with code $? - restarting in 3 seconds (Ctrl+C to stop)"
    sleep 3
done
