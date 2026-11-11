# Called by the model to restart its own server. The stop is delayed and detached
# so the current response can finish; start-llama.ps1 then starts it again.
$name = [IO.Path]::GetFileNameWithoutExtension($(if ($env:LLAMA_BIN) { $env:LLAMA_BIN } else { 'llama' }))
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "Start-Sleep -Seconds 3; Stop-Process -Name '$name' -Force"
Write-Output "llama server will restart in about 3 seconds"
