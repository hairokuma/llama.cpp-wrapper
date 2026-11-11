# Starts the llama server and restarts it whenever it exits (stop with Ctrl+C).
#   .\scripts\start-llama.ps1                          built-in web UI
#   .\scripts\start-llama.ps1 -CustomUi                custom web UI (voice mode + automatic AGENTS.md loading)
#   .\scripts\start-llama.ps1 -Model D:\models\x.gguf  use a specific model
# Model: -Model, else $env:LLAMA_MODEL, else the first .gguf in models\.
# Binary: $env:LLAMA_BIN, else `llama` from PATH.
param(
    [switch]$CustomUi,
    [string]$Model = $env:LLAMA_MODEL
)
$root = Split-Path $PSScriptRoot -Parent  # repo folder
$llama = if ($env:LLAMA_BIN) { $env:LLAMA_BIN } else { 'llama' }

if (-not $Model) {
    $Model = Get-ChildItem "$root\models\*.gguf" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Model -or -not (Test-Path $Model)) {
    Write-Error "No model found: pass -Model <file.gguf>, set LLAMA_MODEL or put a .gguf into $root\models\"
    exit 1
}

# Chat template = the model's own + OS/date/time info (see app\chat-template.jinja), rendered by the server
# for every request, so any client gets it without tools. Passed via env vars to avoid JSON quoting issues.
$os = Get-CimInstance Win32_OperatingSystem
$env:LLAMA_ARG_CHAT_TEMPLATE_FILE = "$root\app\chat-template.jinja"
$env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = @{ env_os = "$($os.Caption) $($os.Version)" } | ConvertTo-Json -Compress

while ($true) {
    $ui = @()
    if ($CustomUi) {
        # rebuild the custom web UI copy (follows llama updates); fall back to the built-in UI
        python "$root\app\build-voice-ui.py"
        if ($LASTEXITCODE -eq 0) {
            $ui = @('--path', "$root\app\.webui")
        } else {
            Write-Warning "building the custom web UI failed - using the built-in UI"
        }
    }
    # mcp.json -> app\.mcp.resolved.json (paths and Windows npx wrapper filled in)
    python "$root\app\prepare-mcp.py"
    if ($LASTEXITCODE -ne 0) { exit 1 }

    # Optional: add these two flags below to not stop when the context fills up *while* the model writes a reply.
    #   --context-shift --keep -1
    # When the KV cache is full the server keeps the prompt (--keep -1 = whole prompt), throws away about half
    # of the reply generated so far and lets the model continue - it silently forgets the beginning of its own
    # answer (reasoning, tool results). Does NOT help when the chat history itself is bigger than -c: the UI
    # re-sends the whole conversation every turn and the server rejects it. For that use compaction
    # (/compact in the UI, automatic with -CustomUi via app\voice-ui\autocompact.js).
    & $llama serve -m $Model `
        -c 64000 `
        --host 127.0.0.1 `
        --port 8080 `
        --load-mode none `
        --tools all `
        --mcp-servers-config "$root\app\.mcp.resolved.json" `
        --ui-config-file "$root\ui-config.json" `
        --reasoning-format deepseek `
        --log-prompts-dir "$root\.prompt-logs" `
        @ui
    Write-Host "llama exited with code $LASTEXITCODE - restarting in 3 seconds (Ctrl+C to stop)"
    Start-Sleep -Seconds 3
}
