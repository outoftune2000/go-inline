[CmdletBinding()]
param(
  [ValidateSet('Menu','Start','Stop','Status','Download')][string]$Action = 'Menu',
  [string]$ServerPath = '',
  [string]$ModelPath = '',
  [ValidateRange(1024,65535)][int]$Port = 18080,
  [ValidateRange(0,999)][int]$GpuLayers = 99,
  [string]$RuntimeDirectory = ''
)
$ErrorActionPreference = 'Stop'
$localConfig = Join-Path $PSScriptRoot '..\.local-model.json'
if (!$RuntimeDirectory -and (Test-Path -LiteralPath $localConfig)) {
  $RuntimeDirectory = [string](Get-Content -Raw -LiteralPath $localConfig | ConvertFrom-Json).runtimeDirectory
}
if (!$RuntimeDirectory) { $RuntimeDirectory = Join-Path $PSScriptRoot '..\work' }
$workDirectory = [System.IO.Path]::GetFullPath($RuntimeDirectory)
if (!$ServerPath) { $ServerPath = Join-Path $workDirectory 'llamacpp\llama-server.exe' }
$defaultModel = Join-Path $workDirectory 'models\qwen2.5-coder-1.5b-base-q4_k_m.gguf'
if (!$ModelPath) { $ModelPath = $defaultModel }
$stateFile = Join-Path $workDirectory 'llama-server-state.json'
$pidFile = Join-Path $workDirectory 'llama-server.pid'

function Get-OwnedServer {
  $saved = $null
  if (Test-Path -LiteralPath $stateFile) {
    $saved = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
    $serverId = [int]$saved.ProcessId
    $expectedPath = [string]$saved.ServerPath
    $expectedPort = [int]$saved.Port
  } elseif (Test-Path -LiteralPath $pidFile) {
    $serverId = [int](Get-Content -LiteralPath $pidFile)
    $expectedPath = [System.IO.Path]::GetFullPath($ServerPath)
    $expectedPort = $Port
  } else { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId" -ErrorAction SilentlyContinue
  if (!$process) { return $null }
  if (!$process.ExecutablePath -or ![string]::Equals($process.ExecutablePath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Verbose 'Ignoring a stale PID belonging to another application.'
    return $null
  }
  if ($process.CommandLine -notmatch ('--port\s+' + $expectedPort + '(?:\s|$)')) { return $null }
  if ($saved -and ([string]$process.CreationDate.ToUniversalTime().Ticks -ne [string]$saved.CreationTicks)) { return $null }
  return [pscustomobject]@{ Process=$process; Port=$expectedPort; Model=$(if ($saved) { $saved.ModelPath } else { 'original local model' }) }
}

function Show-ModelStatus {
  $owned = Get-OwnedServer
  if (!$owned) { Write-Host 'UNLOADED - no managed model is running.'; return }
  $health = 'loading or unavailable'
  try { if ((Invoke-RestMethod "http://127.0.0.1:$($owned.Port)/health" -TimeoutSec 2).status -eq 'ok') { $health = 'ready' } } catch { }
  Write-Host "LOADED - PID $($owned.Process.ProcessId), $health"
  Write-Host "Model: $($owned.Model)"
  Write-Host "Endpoint: http://127.0.0.1:$($owned.Port)"
}

function Stop-Model {
  $owned = Get-OwnedServer
  if (!$owned) { Write-Host 'Already unloaded.'; return }
  $live = Get-Process -Id $owned.Process.ProcessId -ErrorAction SilentlyContinue
  if ($live) {
    # CIM timestamps have microsecond precision; Process.StartTime also has sub-microsecond ticks.
    if ([Math]::Abs($live.StartTime.ToUniversalTime().Ticks - $owned.Process.CreationDate.ToUniversalTime().Ticks) -gt 10) { throw 'Process identity changed; nothing was stopped.' }
    $live.Kill()
    if (!$live.WaitForExit(10000)) { throw 'Server did not stop within ten seconds.' }
  }
  Write-Host 'UNLOADED - server stopped; model RAM and GPU allocations are released.'
  Write-Host 'Downloaded model files remain on disk for next time.'
}

function Get-DefaultModel {
  $checksum = 'a9ccb6be802412e61e1acbee6287a23b11e56e94718560f910075c64b6194910'
  if (Test-Path -LiteralPath $defaultModel -PathType Leaf) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $defaultModel).Hash -ne $checksum) {
      throw "Checksum mismatch for $defaultModel. Move that file aside before downloading a fresh copy."
    }
    Write-Host "Verified model already available at $defaultModel"
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $defaultModel) | Out-Null
  $partial = "$defaultModel.$([guid]::NewGuid()).partial"
  $url = 'https://github.com/outoftune2000/go-inline/releases/download/local-model-1.5b/qwen2.5-coder-1.5b-base-q4_k_m.gguf'
  try {
    Write-Host 'Downloading Qwen2.5-Coder 1.5B Base Q4_K_M (986 MB)...'
    curl.exe --fail --location --retry 2 --output $partial $url
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Try again or use the upstream link in local-model/README.md.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash -ne $checksum) { throw 'Downloaded model failed SHA-256 verification.' }
    [System.IO.File]::Move($partial, $defaultModel)
    Write-Host "Verified model saved to $defaultModel"
  } finally {
    if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial }
  }
}

function Start-Model([string]$SelectedModel) {
  if (Get-OwnedServer) { Write-Host 'A model is already running. Unload it first to switch models.'; Show-ModelStatus; return }
  if (!(Test-Path -LiteralPath $ServerPath -PathType Leaf)) { throw "llama-server not found: $ServerPath" }
  if (!(Test-Path -LiteralPath $SelectedModel -PathType Leaf)) { throw "Model not found: $SelectedModel. Use menu option 5 to download the 1.5B model." }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is used by another service. It has been left alone." }
  $resolvedServer = (Resolve-Path -LiteralPath $ServerPath).Path
  $resolvedModel = (Resolve-Path -LiteralPath $SelectedModel).Path
  New-Item -ItemType Directory -Force -Path $workDirectory | Out-Null
  $serverProcess = Start-Process -FilePath $resolvedServer -ArgumentList @('-m', ('"' + $resolvedModel + '"'), '--host', '127.0.0.1', '--port', "$Port", '-c', '8192', '-ngl', "$GpuLayers", '-np', '1') -WorkingDirectory (Split-Path -Parent $resolvedServer) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $workDirectory 'llama-server.stdout.log') -RedirectStandardError (Join-Path $workDirectory 'llama-server.stderr.log') -PassThru
  $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $($serverProcess.Id)"
  if (!$identity) { throw 'Server exited during startup. Check work\llama-server.stderr.log.' }
  [pscustomobject]@{ ProcessId=$serverProcess.Id; ServerPath=$resolvedServer; ModelPath=$resolvedModel; Port=$Port; CreationTicks=[string]$identity.CreationDate.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $stateFile
  $serverProcess.Id | Set-Content -LiteralPath $pidFile
  Write-Host 'Loading the model...'
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  while ($timer.Elapsed.TotalSeconds -lt 45) {
    if ($serverProcess.HasExited) { throw 'Server exited during loading. Check work\llama-server.stderr.log.' }
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2).status -eq 'ok') { Write-Host 'READY - select llama.cpp in Go Inline and start coding.'; return } } catch { }
    Start-Sleep -Milliseconds 300
  }
  Write-Host 'Still loading. Use Status to check again, or Unload to stop.'
}

switch ($Action) {
  'Start' { Start-Model $ModelPath }
  'Stop' { Stop-Model }
  'Status' { Show-ModelStatus }
  'Download' { Get-DefaultModel }
  'Menu' {
    while ($true) {
      Write-Host "`nGo Inline - local model control"
      Write-Host '1. Load 1.5B model (recommended)'
      Write-Host '2. Load 7B model'
      Write-Host '3. Unload model / free GPU memory'
      Write-Host '4. Show status'
      Write-Host '5. Download and verify the 1.5B model'
      Write-Host '0. Exit menu (keeps current model state)'
      $choice = Read-Host 'Choose'
      try {
        switch ($choice) {
          '1' { Start-Model $ModelPath }
          '2' { Start-Model (Join-Path $workDirectory 'models\qwen2.5-coder-7b-base-q4_k_m.gguf') }
          '3' { Stop-Model }
          '4' { Show-ModelStatus }
          '5' { Get-DefaultModel }
          '0' { return }
          default { Write-Host 'Choose 0, 1, 2, 3, 4, or 5.' }
        }
      } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
    }
  }
}
