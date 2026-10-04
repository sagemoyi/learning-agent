param([ValidateRange(1024,65535)][int]$Port = 16580)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mineruExe = Join-Path $projectRoot '.tools/mineru/Scripts/mineru-kit.exe'
if (!(Test-Path -LiteralPath $mineruExe)) { throw 'Local MinerU is missing. Install the verified version from README first.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/health" -TimeoutSec 5
  if ($health.features.output_formats -notcontains 'zip') { throw 'The local service does not support full result bundles.' }
  Write-Output "MinerU is already running on local port $Port, version $($health.version)"
  exit 0
}
$runtimeDir = Join-Path $projectRoot '.scratch/mineru-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$arguments = @('api-server', '--host', '127.0.0.1', '--port', "$Port", '--tier', 'standard', '--no-flash', '--no-advanced', '--upload-dir', 'uploads')
Start-Process -FilePath $mineruExe -ArgumentList $arguments -WorkingDirectory $runtimeDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.log') -RedirectStandardError (Join-Path $runtimeDir 'server.err') | Out-Null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/health" -TimeoutSec 1; Write-Output "MinerU started on local port $Port, version $($health.version)"; exit 0 } catch { Start-Sleep -Milliseconds 500 }
}
throw 'MinerU is not ready. Check startup logs in .scratch/mineru-runtime.'
