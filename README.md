# Local AI

Local LLM setup for Windows and Linux: [llama.cpp](https://github.com/ggml-org/llama.cpp) server with built-in tools,
MCP servers, a customized web UI with voice input/output (whisper.cpp) and automatic `AGENTS.md` loading.
All paths are relative to the repo folder; every script exists as `.ps1` (Windows) and `.sh` (Linux).


## setup

These are not in the repo (see `.gitignore`), install/download them yourself:

| what | where |
|---|---|
| `llama` server binary (llama.cpp, `llama serve`) | on `PATH`, or set `LLAMA_BIN` |
| model (`.gguf`) | `models/` (first `.gguf` is used), or set `LLAMA_MODEL`, or pass `-Model` / `--model` |
| Python 3 | `pip install -r requirements.txt` (scripts in `app/`) |
| `uv` (`uvx`) and Node.js (`npx`) | on `PATH`, used to start the MCP servers |
| whisper.cpp (voice only) | `whisper/` with `models/ggml-small-q5_1.bin` (see [voice assistant](#voice-assistant)) |

On Linux, make the scripts executable once: `chmod +x scripts/*.sh`.

Optional environment variables:

| variable | default | for |
|---|---|---|
| `LLAMA_BIN` | `llama` | llama server binary |
| `LLAMA_MODEL` | first `models/*.gguf` | model file |
| `WHISPER_BIN` | `whisper/bin/Release/whisper-server.exe` (Windows), `whisper/build/bin/whisper-server` (Linux) | whisper server binary |
| `WHISPER_MODEL` | `whisper/models/ggml-small-q5_1.bin` | whisper model |
| `PYTHON` | `python3` (Linux only) | Python interpreter |

Windows, set permanently: `setx LLAMA_MODEL "D:\models\Qwen3.8-35B-A3B-Q4_K_M.gguf"` (new terminal afterwards).
Linux: `export LLAMA_MODEL=~/models/...` in `~/.bashrc`.


## run

From the repo folder:

```POWERSHELL
# Windows - llama.cpp with auto-restart (built-in tools + MCP servers from mcp.json)
powershell -ExecutionPolicy Bypass -File .\scripts\start-llama.ps1                     # built-in web UI
powershell -ExecutionPolicy Bypass -File .\scripts\start-llama.ps1 -CustomUi           # custom web UI (voice + AGENTS.md)
powershell -ExecutionPolicy Bypass -File .\scripts\start-llama.ps1 -Model D:\x.gguf    # specific model
```

```bash
# Linux
./scripts/start-llama.sh
./scripts/start-llama.sh --custom-ui
./scripts/start-llama.sh --model ~/models/x.gguf
```

Then open http://127.0.0.1:8080.
The model can restart its own server (e.g. after editing `mcp.json`) with `scripts/restart-llama.ps1` / `scripts/restart-llama.sh`:

```POWERSHELL
powershell -ExecutionPolicy Bypass -File .\scripts\restart-llama.ps1
```

The tools work in the directory the start script was started from, or in the working directory set in the web UI.


## AGENTS.md

Put an `AGENTS.md` into a working directory to give the model instructions for that workspace.
With the custom UI, `app/voice-ui/agents.js` reads it before every request and adds it to the system message (reliable).
In the built-in UI the system message from `ui-config.json` only asks the model to read it with `read_file` (works only sometimes).


## OS, date and time

The start scripts run the server with `app/chat-template.jinja` (the model's own chat template plus an
"# Environment" block with OS, date and time zone in the system turn and the exact local time in front of the
latest user message). The server renders it for every request, so every client (built-in UI, custom UI, API)
gets it without tool calls. The OS is passed in via `LLAMA_ARG_CHAT_TEMPLATE_KWARGS` (`env_os`).
The template is copied from the Qwen GGUF - when switching to another model family, copy that model's template
(`curl http://127.0.0.1:8080/props` -> `chat_template`) and re-add the parts marked `[env]`.


## context full / compaction

Every turn re-sends the whole conversation (plus ~12k tokens of tool definitions), so long chats hit `-c` and stop.
`/compact` in the chat input summarizes older messages (Settings: "Compaction prompt", "Compaction preserved steps").
With the custom UI, `app/voice-ui/autocompact.js` does it automatically once a reply used 70% of the context
(log in the browser console, `[autocompact]`). Change the threshold in the browser console:
`localStorage.setItem("autocompact.threshold", "0.6")`. It cannot compact in the middle of a long tool loop - it waits until the loop ends.
`--context-shift` (see comment in `scripts/start-llama.ps1`) is no substitute: it only stretches a single reply.


## tools

### built-in (`--tools all`)

| tool | what it does |
|---|---|
| `read_file` | read a file, optionally a line range |
| `file_glob_search` | find files by glob pattern |
| `grep_search` | search file contents |
| `write_file` / `edit_file` | create or change files |
| `exec_shell_command` | run a shell command |
| `get_info` | OS and current working directory |

### MCP servers (`mcp.json`)

| server | tools | what it does |
|---|---|---|
| `web-search` | `search`, `fetch_content`, `expand_link` | DuckDuckGo web search and page fetching, no API key |
| `fetch` | `fetch` | download a URL and return it as Markdown |
| `playwright` | navigate, click, type, screenshot, ... | remote-control a browser (web pages, forms, testing) |
| `memory` | create/search/delete entities, relations, observations | persistent knowledge graph the model can remember things in |

MCP tools appear in the UI as `<server>_<tool>`, e.g. `web-search_search`.
Check what actually loaded: `Invoke-RestMethod http://127.0.0.1:8080/tools | % tool` (Linux: `curl -s http://127.0.0.1:8080/tools`).

`mcp.json` is written portably; before every start `app/prepare-mcp.py` turns it into `app/.mcp.resolved.json` for the server:

- `${ROOT}` → repo folder, `${HOME}` → home folder, other `${VAR}` → environment variable
  (so API keys stay out of the repo: `"BRAVE_API_KEY": "${BRAVE_API_KEY}"`).
- On Windows `npx`/`npm` become `cmd /c npx ...`: `npx` is a `.cmd` wrapper there that the server can't launch directly.

A server whose package is downloaded for the first time may miss the start - restart once more.

File access uses only the built-in tools. The MCP `filesystem` server was removed: it duplicated them, and the extra
tool definitions confused the model and used up context.
`time`, `context7`, `git`, `brave-search` and `github` are not loaded either (fewer tool definitions = more context).
Their configs are in `mcp.json.bak`; copy one into `mcp.json` to use it (`brave-search` and `github` need the API key
environment variable set).

### memory

A knowledge graph stored in `.memory.jsonl` in the repo folder (`MEMORY_FILE_PATH` in `mcp.json`), one JSON object per line:
**entities** (name, type, list of facts = *observations*) and **relations** between them (`from` → `relationType` → `to`).
It survives restarts and is shared by all conversations.

The model only uses it when asked - and may claim "saved" without calling a tool, so name the tools:

```text
Use the memory tools (memory_create_entities, memory_create_relations) to store:
I work as a software developer, I prefer short answers, and I am building a local llama.cpp setup.
```

```text
What do you know about me? Check your memory.            (new chat -> memory_read_graph / memory_search_nodes)
Add to my memory that I switched to Qwen 3.8.            (memory_add_observations)
Forget that I prefer short answers.                      (memory_delete_observations)
```

Look at or reset it directly: open / delete `.memory.jsonl`.


## voice assistant

Mic → whisper.cpp (small multilingual model, CPU) → llama server → speech (German/English voice picked automatically).
Speech-to-text needs whisper-server running.

whisper.cpp setup:

- **Windows:** unzip the `whisper-bin-x64.zip` release from [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) into `whisper\`
- **Linux:** `git clone https://github.com/ggml-org/whisper.cpp whisper && cmake -S whisper -B whisper/build && cmake --build whisper/build -j --config Release`
- model: download `ggml-small-q5_1.bin` from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) into `whisper/models/`

```POWERSHELL
powershell -ExecutionPolicy Bypass -File .\scripts\start-whisper.ps1     # Windows
./scripts/start-whisper.sh                                       # Linux
```

**In the web UI** (http://127.0.0.1:8080, start with `-CustomUi` / `--custom-ui`): mic button bottom right (or Ctrl+Space),
speaker button toggles reading replies aloud, Esc stops speaking.
The start script runs `app/build-voice-ui.py` before each start: it copies the server's built-in UI to `app/.webui/` and injects
`app/voice-ui/voice.js`, `app/voice-ui/agents.js` and `app/voice-ui/autocompact.js` (edit those files, then restart the server).

**Standalone, without browser:** `python app/voice-assistant.py`. Speaks with the Windows voices, on Linux with `espeak-ng`
(`sudo apt install espeak-ng libportaudio2`).


## repo layout

| path | what |
|---|---|
| `scripts/start-llama.*`, `scripts/restart-llama.*` | start (with auto-restart) / restart the llama server |
| `scripts/start-whisper.*` | start whisper-server (speech-to-text, port 8081) |
| `mcp.json`, `mcp.json.bak` | active MCP servers / configs of unused ones |
| `ui-config.json` | web UI settings and system message |
| `app/build-voice-ui.py`, `app/voice-ui/` | custom web UI build script and the scripts it injects |
| `app/prepare-mcp.py` | resolves `mcp.json` into `app/.mcp.resolved.json` for the current OS |
| `app/voice-assistant.py` | standalone voice assistant |
| `requirements.txt` | Python packages |
| `models/` | put `.gguf` models here |
| `app/.webui/`, `app/.mcp.resolved.json`, `whisper/`, `.prompt-logs/`, `.memory.jsonl` | generated files, binaries, runtime data - git-ignored |
