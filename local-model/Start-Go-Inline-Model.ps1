[CmdletBinding()]
param(
  [string]$ServerPath = '',
  [string]$ModelPath = '',
  [ValidateRange(1024,65535)][int]$Port = 18080,
  [ValidateRange(0,999)][int]$GpuLayers = 99
)
& (Join-Path $PSScriptRoot 'Go-Inline-Model-Control.ps1') -Action Start -ServerPath $ServerPath -ModelPath $ModelPath -Port $Port -GpuLayers $GpuLayers
