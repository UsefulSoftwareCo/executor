# Windows companion to election-cold-start.test.ts: the Phase 1 daemon election,
# proven on real Windows. The vitest cli-windows target provisions via EC2; this
# script is the same probe, run by hand against any reachable Windows guest (e.g.
# a long-lived dockur/QEMU box) when avoiding cloud spend.
#
# How to run:
#   1. cross-build the binary:  cd apps/cli; bun run src/build.ts binary --target executor-windows-x64
#   2. push the bin dir to the guest C:\ed (scp the dist bin dir to Administrator@<guest>:C:/ed/)
#   3. push + run this script:  ssh Administrator@<guest> 'powershell -ExecutionPolicy Bypass -File C:\ed\probe.ps1'
#
# Expected (matches Linux/macOS): one winner spawns, the rest attach, all succeed.
#   PROBE_SUMMARY-cold ok=6 n=6 spawned=1 manifests=1 port=4788 health=200
#   PROBE_SUMMARY-warm ok=6 n=6 spawned=0 manifests=1 port=4788 health=200
param([int]$N = 6)
$Exe = "C:\ed\executor.exe"
$D = "C:\Users\administrator\eprobe"
$ErrorActionPreference = "SilentlyContinue"

function Run-Wave($label) {
  $procs = @()
  for ($i = 1; $i -le $N; $i++) {
    $o = "$D\out-$label-$i.txt"; $e = "$D\err-$label-$i.txt"
    $p = Start-Process -FilePath $Exe -ArgumentList "tools", "search", "p$i" `
      -PassThru -NoNewWindow -RedirectStandardOutput $o -RedirectStandardError $e
    $procs += $p
  }
  foreach ($p in $procs) { [void]$p.WaitForExit(120000) }
  # Success signal is the round-trip result in the client's stdout, not the
  # Start-Process ExitCode (which comes back null under -NoNewWindow on PS 5.1).
  # The election winner prints "Starting daemon" to STDERR; losers attach silently.
  $ok = 0; $spawned = 0
  for ($i = 1; $i -le $N; $i++) {
    if (Select-String -Path "$D\out-$label-$i.txt" -Pattern '"total"' -Quiet) { $ok++ }
    $sp = (Select-String -Path "$D\out-$label-$i.txt" -Pattern "Starting daemon" -Quiet) `
      -or (Select-String -Path "$D\err-$label-$i.txt" -Pattern "Starting daemon" -Quiet)
    if ($sp) { $spawned++ }
  }
  $manifests = (Get-ChildItem "$D\daemon-active-*" -EA SilentlyContinue | Measure-Object).Count
  $port = ""
  $pf = Get-ChildItem "$D\daemon-localhost-*.json" -EA SilentlyContinue | Select-Object -First 1
  if ($pf) { $port = (Get-Content $pf.FullName -Raw | ConvertFrom-Json).port }
  $health = "000"
  if ($port) {
    try { $health = [string](Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$port/api/health").StatusCode } catch { $health = "ERR" }
  }
  Write-Output "PROBE_SUMMARY-$label ok=$ok n=$N spawned=$spawned manifests=$manifests port=$port health=$health"
}

Remove-Item -Recurse -Force $D -EA SilentlyContinue
New-Item -ItemType Directory -Force -Path $D | Out-Null
$env:EXECUTOR_DATA_DIR = $D
$env:EXECUTOR_SCOPE_DIR = $D
Run-Wave "cold"
Run-Wave "warm"
$am = Get-ChildItem "$D\daemon-active-*" -EA SilentlyContinue | Select-Object -First 1
if ($am) { $dp = (Get-Content $am.FullName -Raw | ConvertFrom-Json).pid; if ($dp) { Stop-Process -Id $dp -Force -EA SilentlyContinue } }
