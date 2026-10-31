# ============================================================================
#  reset-memory.ps1  -  wipe the persona's learned memory, keep the seed memory
#
#  What it does
#    1. backs up the story-state file (if present)
#    2. POST {PersonaUrl}/reset      -> the persona keeps its seed memory files
#                                       (they live on the persona side, untouched)
#    3. resets backend/nori_script_state.json -> {}   (so script beats fire again)
#    4. prints before/after counters
#
#  Usage
#    powershell -ExecutionPolicy Bypass -File scripts\reset-memory.ps1
#    ... -PersonaUrl http://127.0.0.1:25503
#    ... -KeepStory          # do not reset script-beat bookkeeping
#    ... -DryRun             # show what would happen, change nothing
#
#  NOTE: this clears the *persona* memory (memories / links / facts / affect).
#        Seed memory (standard memory + seed cards) is re-loaded by the persona
#        itself on /reset, so it survives by design.
# ============================================================================
param(
  [string]$PersonaUrl = 'http://127.0.0.1:25503',
  [string]$StateFile,
  [switch]$KeepStory,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $StateFile) { $StateFile = Join-Path $Repo 'backend\nori_script_state.json' }

function Line($t) { Write-Host $t }

Line '============================================================'
Line (' Nori memory reset' + $(if ($DryRun) { '   [DRY RUN]' } else { '' }))
Line '============================================================'

# --- 1. backup -------------------------------------------------------------
if (Test-Path $StateFile) {
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $bak = Join-Path $Repo ('backend\_bak\reset-' + $stamp)
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $bak | Out-Null
    Copy-Item $StateFile (Join-Path $bak 'nori_script_state.json') -Force
    Line ('[1] backed up story state -> ' + $bak)
  } else {
    Line '[1] would back up story state (dry run)'
  }
} else {
  Line '[1] no story-state file (skipped)'
}

# --- 2. before -------------------------------------------------------------
$before = $null
try { $before = Invoke-RestMethod -Uri ($PersonaUrl + '/state') -TimeoutSec 5 } catch { }
if ($before) {
  Line ('[2] before: turns=' + $before.turns + ' act=' + $before.act +
        ' memories=' + $before.memories.Count + ' facts=' + $before.facts.Count)
} else {
  Line ('[2] before: persona unreachable at ' + $PersonaUrl)
}

# --- 3. reset --------------------------------------------------------------
if ($DryRun) {
  Line '[3] would POST ' + $PersonaUrl + '/reset (dry run)'
} else {
  try {
    $r = Invoke-RestMethod -Uri ($PersonaUrl + '/reset') -Method Post -Body '{}' `
           -ContentType 'application/json' -TimeoutSec 30
    Line ('[3] POST /reset -> ' + ($r | ConvertTo-Json -Compress))
  } catch {
    Line ('[3] POST /reset FAILED: ' + $_.Exception.Message)
  }
}

# --- 4. after --------------------------------------------------------------
if (-not $DryRun) {
  Start-Sleep -Milliseconds 300
  $after = $null
  try { $after = Invoke-RestMethod -Uri ($PersonaUrl + '/state') -TimeoutSec 5 } catch { }
  if ($after) {
    Line ('[4] after : turns=' + $after.turns + ' act=' + $after.act +
          ' memories=' + $after.memories.Count + ' seeded=' + $after.seeded)
  }
}

# --- 5. story bookkeeping --------------------------------------------------
if ($KeepStory) {
  Line '[5] script-beat bookkeeping kept (-KeepStory)'
} elseif ($DryRun) {
  Line '[5] would reset nori_script_state.json -> {} (dry run)'
} else {
  Set-Content -Path $StateFile -Value '{}' -Encoding ASCII
  Line '[5] nori_script_state.json -> {}   (restart the proxy to apply)'
}

Line ''
Line $(if ($DryRun) { 'DRY RUN complete - nothing was modified.' } else { 'DONE. Restart the proxy (scripts\n_guard_bg.bat), then reload the page.' })
Line '============================================================'
