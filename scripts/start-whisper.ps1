# Starts whisper-server (speech-to-text) on port 8081, used by the voice UI and voice-assistant.py.
# Override with $env:WHISPER_BIN / $env:WHISPER_MODEL.
$w = Join-Path (Split-Path $PSScriptRoot -Parent) "whisper"
$bin = if ($env:WHISPER_BIN) { $env:WHISPER_BIN } else { "$w\bin\Release\whisper-server.exe" }
$model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "$w\models\ggml-small-q5_1.bin" }
& $bin -m $model `
    --host 127.0.0.1 `
    --port 8081 `
    -l auto `
    -t 8 `
    -nt
