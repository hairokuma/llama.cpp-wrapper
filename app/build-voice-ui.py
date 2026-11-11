"""Builds app/.webui/ = the llama server's built-in web UI + the scripts in voice-ui/, served via `llama serve --path`.

Starts a temporary model-less llama server on a spare port, mirrors the UI files listed in its
service worker, injects the voice-ui/ scripts and bumps the service worker revision so browsers pick it up.
Run by scripts/start-llama.ps1 / .sh before every server start, so the copy follows llama updates.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
OUT = HERE / ".webui"
# injected into index.html; agents.js adds the working directory's AGENTS.md to the system message,
# autocompact.js compacts the conversation when the context gets full
SCRIPTS = [HERE / "voice-ui" / n for n in ("voice.js", "agents.js", "autocompact.js")]
PORT = 8089
LLAMA = os.environ.get("LLAMA_BIN", "llama")  # llama.exe on Windows is found as "llama" too
BASE = f"http://127.0.0.1:{PORT}/"
EXTRA = ["sw.js", "openjpeg.wasm", "diagram.svg", "favicon.png"]  # referenced but not precached


def fetch(path):
    r = requests.get(BASE + path, timeout=30)
    return r.content if r.ok else None


# (name, pattern, replacement, what breaks if it no longer matches) - minified names vary between builds
PATCHES = [
    # Finished reasoning sections start expanded like running ones (setting "showThoughtInProgress").
    # Upstream only expands REASONING_PENDING: `t.type===la.REASONING_PENDING?n:!1`.
    (
        "reasoning-expand",
        re.compile(r"(\w+)\.type===(\w+)\.REASONING_PENDING\?(\w+):!1"),
        r"(\1.type===\2.REASONING_PENDING||\1.type===\2.REASONING)?\3:!1",
        "finished reasoning stays collapsed",
    ),
    # Expose the UI's "/compact" action as window.__llamaCompact for voice-ui\autocompact.js.
    # Upstream: `onCompact:()=>dn.compactConversation()`.
    (
        "expose-compact",
        re.compile(r"onCompact:\(\)=>(\w+)\.compactConversation\(\)"),
        r"onCompact:(window.__llamaCompact=()=>\1.compactConversation(),()=>\1.compactConversation())",
        "no automatic compaction",
    ),
]


def patch_bundle(tmp, sw):
    """Applies PATCHES to the UI's JS files; returns sw.js with new revisions for changed files."""
    hits = {name: 0 for name, *_ in PATCHES}
    for js in (tmp / "_app").rglob("*.js"):
        src = js.read_text(encoding="utf-8")
        new = src
        for name, pattern, repl, _ in PATCHES:
            new, n = pattern.subn(repl, new)
            hits[name] += n
        if new == src:
            continue
        js.write_text(new, encoding="utf-8")
        url = js.relative_to(tmp).as_posix()
        rev = hashlib.md5(new.encode()).hexdigest()
        # precached with revision:null (immutable) - set a revision so browsers fetch the patched copy
        sw = re.sub(rf'(\{{url:"{re.escape(url)}",revision:)(null|"[^"]*")', rf'\g<1>"{rev}"', sw)
    for name, _, _, broken in PATCHES:
        if not hits[name]:
            print(f"warning: {name} patch did not match (llama UI changed?) - {broken}")
    return sw


def main():
    server = subprocess.Popen(
        [LLAMA, "serve", "--host", "127.0.0.1", "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                sw = requests.get(BASE + "sw.js", timeout=2).text
                break
            except requests.ConnectionError:
                time.sleep(0.2)
        else:
            sys.exit(f"temporary {LLAMA} server did not start")

        files = re.findall(r'url:"([^"]+)"', sw) + [w + ".js" for w in re.findall(r'"\./(workbox-[\w-]+)"', sw)]
        tmp = OUT.with_name(".webui.tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        for f in dict.fromkeys(files + EXTRA):
            data = fetch("" if f == "./" else f)
            if data is None:
                continue
            dest = tmp / ("index.html" if f == "./" else f)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
    finally:
        server.kill()

    (tmp / "voice").mkdir()
    index = (tmp / "index.html").read_text(encoding="utf-8")
    for js in SCRIPTS:
        data = js.read_bytes()
        (tmp / "voice" / js.name).write_bytes(data)
        tag = f'<script src="./voice/{js.name}?v={hashlib.md5(data).hexdigest()[:8]}"></script>'
        index = index.replace("</head>", f"\t{tag}\n\t</head>", 1)
    (tmp / "index.html").write_text(index, encoding="utf-8")

    # new revision for "./" so the service worker re-caches the modified page
    rev = hashlib.md5(index.encode()).hexdigest()
    sw = (tmp / "sw.js").read_text(encoding="utf-8")
    sw = re.sub(r'(\{url:"\./",revision:")[^"]*', rf"\g<1>{rev}", sw)
    sw = patch_bundle(tmp, sw)
    (tmp / "sw.js").write_text(sw, encoding="utf-8")

    shutil.rmtree(OUT, ignore_errors=True)
    tmp.rename(OUT)
    print(f"voice UI built in {OUT} ({sum(1 for _ in OUT.rglob('*'))} files)")


if __name__ == "__main__":
    main()
