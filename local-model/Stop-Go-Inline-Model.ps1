[CmdletBinding()]
param()
& (Join-Path $PSScriptRoot 'Go-Inline-Model-Control.ps1') -Action Stop
