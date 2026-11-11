"""Writes app/.mcp.resolved.json (passed to the llama server) from the portable mcp.json in the repo folder.

- ${ROOT} becomes the repo folder, ${HOME} the user's home; other ${VAR} / $VAR are taken from the
  environment (e.g. "BRAVE_API_KEY": "${BRAVE_API_KEY}" keeps keys out of the repo).
- On Windows, npx/npm commands are wrapped as `cmd /c npx ...`: npx is a .cmd file there,
  which the server can't launch directly.

Run by scripts/start-llama.ps1 / .sh before every server start.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # app/
ROOT = HERE.parent                      # repo folder
SRC = ROOT / "mcp.json"
OUT = HERE / ".mcp.resolved.json"
CMD_WRAPPED = {"npx", "npm", "pnpm", "yarn"}


def expand(value):
    if not isinstance(value, str):
        return value
    value = value.replace("${ROOT}", ROOT.as_posix()).replace("${HOME}", Path.home().as_posix())
    return os.path.expandvars(value)


def main():
    cfg = json.loads(SRC.read_text(encoding="utf-8"))
    for name, server in cfg.get("mcpServers", {}).items():
        server["command"] = expand(server["command"])
        server["args"] = [expand(a) for a in server.get("args", [])]
        if "env" in server:
            server["env"] = {k: expand(v) for k, v in server["env"].items()}
        if os.name == "nt" and server["command"] in CMD_WRAPPED:
            server["args"] = ["/c", server["command"], *server["args"]]
            server["command"] = "cmd"
    OUT.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f"prepare-mcp: {SRC} is invalid: {e}")
