# ============================================================================
#  stop.ps1  -  stop whatever is listening on the given ports (default: 4173)
#
#  Usage
#    powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
#    ... -Ports 4173,8880,25503     # stop the whole stack
#    ... -WhatIf                    # only list the PIDs, kill nothing
#
#  Only processes that own the LISTENING socket of those ports are touched.
# ============================================================================
param(
  # string[] 收：`-File` 方式下 `-Ports 4173,8880` 会作为**一个字符串**传进来
  [string[]]$Ports = @('4173'),
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Stop-Port([string]$p) {
  $lines = netstat -ano -p tcp | Select-String (':' + $p + '\s') | Select-String 'LISTENING'
  if (-not $lines) { Write-Host ('[skip] port ' + $p + ' : nothing listening'); return }

  $procIds = @()
  foreach ($l in $lines) {
    $parts = ($l.ToString() -split '\s+') | Where-Object { $_ -ne '' }
    if ($parts.Length -ge 5) { $procIds += [int]$parts[-1] }
  }
  $procIds = $procIds | Sort-Object -Unique

  foreach ($procId in $procIds) {
    if ($WhatIf) {
      Write-Host ('[whatif] port ' + $p + ' -> pid ' + $procId)
    } else {
      Write-Host ('[kill] port ' + $p + ' -> pid ' + $procId)
      taskkill /F /PID $procId | Out-Null
    }
  }
}

foreach ($raw in $Ports) {
  foreach ($seg in ($raw -split ',')) {
    $p = $seg.Trim()
    if ($p -ne '') { Stop-Port $p }
  }
}

Write-Host 'done.'
