# Install Executor on Windows, with no Node.js needed:
#
#   irm https://executor.sh/docs/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://executor.sh/docs/install.ps1))) 2.0.0-beta.16
#
# It downloads the release archive from the public GitHub release, checks it against the
# release's SHA256SUMS, unpacks it into %USERPROFILE%\.executor\v2\runtime\versions\<version>,
# points the runtime\current junction at it and adds runtime\current to your user PATH. The
# version it replaces stays as `previous`, so `executor upgrade --rollback` can switch back. A
# running background Executor is stopped first; the next `executor` command starts it on the new
# version.
#
# Settings: EXECUTOR_VERSION (or the first argument), EXECUTOR_INSTALL_DIR, EXECUTOR_DOWNLOAD_URL,
# EXECUTOR_NPM_REGISTRY, and EXECUTOR_NO_MODIFY_PATH=1 to leave PATH alone.
param([string]$Version = $env:EXECUTOR_VERSION)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string]$Message) {
  [Console]::Error.WriteLine("executor install: $Message")
  exit 1
}

$repository = "UsefulSoftwareCo/executor"
$download = if ($env:EXECUTOR_DOWNLOAD_URL) { $env:EXECUTOR_DOWNLOAD_URL.TrimEnd("/") } else { "https://github.com/$repository/releases/download" }
$registry = if ($env:EXECUTOR_NPM_REGISTRY) { $env:EXECUTOR_NPM_REGISTRY.TrimEnd("/") } else { "https://registry.npmjs.org" }
$root = if ($env:EXECUTOR_INSTALL_DIR) { $env:EXECUTOR_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".executor\v2\runtime" }
$Version = if ($Version) { $Version.TrimStart("v") } else { "" }

# Windows on ARM runs the x64 build under emulation.
$arch = "x64"
$platform = "win32"

if (-not $Version) {
  # npm's dist-tags name the current releases. `latest` still names Executor 1 until Executor 2
  # is stable, so it is used only once it names a version 2 release.
  try { $tags = Invoke-RestMethod -Uri "$registry/-/package/executor/dist-tags" }
  catch { Fail "could not read the current release from $registry." }
  $Version = if ("$($tags.latest)" -like "2.*") { "$($tags.latest)" } else { "$($tags.beta)" }
  if (-not $Version) { Fail "$registry lists no Executor 2 release." }
}
if ($Version -notmatch '^[0-9A-Za-z.-]+$') { Fail "$Version is not an Executor version." }

$file = "executor-$Version-$platform-$arch.tgz"
$base = "$download/executor@$Version"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("executor-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  Write-Host "Downloading Executor $Version for $platform/$arch"
  try { Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $temporary "SHA256SUMS") -UseBasicParsing }
  catch { Fail "could not download SHA256SUMS for $Version from $base." }
  $expected = $null
  foreach ($line in Get-Content (Join-Path $temporary "SHA256SUMS")) {
    if ($line -match '^([0-9a-f]{64}) [ *](\./)?(.+)$' -and $Matches[3] -eq $file) { $expected = $Matches[1]; break }
  }
  if (-not $expected) { Fail "release $Version has no $file." }
  $archive = Join-Path $temporary $file
  try { Invoke-WebRequest -Uri "$base/$file" -OutFile $archive -UseBasicParsing }
  catch { Fail "could not download $file from $base." }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "$file does not match the release's SHA256SUMS (expected $expected, got $actual). Nothing was installed."
  }

  # Windows' own tar; a relative archive path, as Git's GNU tar reads a drive letter as a host.
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  Push-Location $temporary
  try { & $tar -xzf $file; if ($LASTEXITCODE -ne 0) { Fail "could not unpack $file." } }
  finally { Pop-Location }
  $unpacked = Join-Path $temporary "package"
  $reported = & (Join-Path $unpacked "executor.exe") --version 2>$null
  if ("$reported".Trim() -ne "executor v$Version") {
    Fail "the downloaded Executor did not start on this machine. Nothing was installed."
  }

  # A background Executor may run from a version this replaces or removes, and Windows cannot
  # remove the files of a running program, so the installed Executor stops it first, as
  # `executor upgrade` does. A version from before the background service has no
  # `executor service` and runs none; a development build's runs from its checkout and is left
  # alone. This script does not start it again: a server started from here would hold this shell's
  # inheritable handles, such as the pipe a caller reads its output from, for as long as it runs.
  $installed = Join-Path $root "current\executor.exe"
  if (Test-Path $installed) {
    # Its errors, such as from a version without `executor service`, only leave it running.
    $ErrorActionPreference = "Continue"
    $status = "$(& $installed service status 2>$null)"
    # A registered server prints its URL, version and process, whether it answers or not.
    if ($status -match 'http://\S+ \(version [^,]+, process \d+\)' -and $status -notmatch '\(version 0\.0\.0-dev,') {
      & $installed service stop *> $null
      if ($LASTEXITCODE -eq 0) { Write-Host "Stopped the background Executor; the next executor command starts it on $Version." }
      else { Write-Host "The background Executor did not stop. Run executor service restart once the install is done." }
    }
    $ErrorActionPreference = "Stop"
  }

  $versions = Join-Path $root "versions"
  New-Item -ItemType Directory -Force -Path $versions | Out-Null
  $destination = Join-Path $versions $Version
  if (Test-Path $destination) { Remove-Item -Recurse -Force $destination }
  Move-Item $unpacked $destination

  $current = Join-Path $root "current"
  $previous = Join-Path $root "previous"
  $replaced = $null
  if (Test-Path $current) {
    $replaced = Split-Path -Leaf (Get-Item $current).Target
    # Removing a junction leaves the version it points at.
    (Get-Item $current).Delete()
  }
  New-Item -ItemType Junction -Path $current -Target $destination | Out-Null
  if ($replaced -and $replaced -ne $Version -and (Test-Path (Join-Path $versions $replaced))) {
    if (Test-Path $previous) { (Get-Item $previous).Delete() }
    New-Item -ItemType Junction -Path $previous -Target (Join-Path $versions $replaced) | Out-Null
  }
  $keep = @($Version)
  if (Test-Path $previous) { $keep += Split-Path -Leaf (Get-Item $previous).Target }
  foreach ($directory in Get-ChildItem -Directory $versions) {
    # A version that is still running stays until a later install.
    if ($keep -notcontains $directory.Name) { Remove-Item -Recurse -Force $directory.FullName -ErrorAction SilentlyContinue }
  }

  Write-Host "Installed Executor $Version in $destination"
  if ($replaced -and $replaced -ne $Version) {
    Write-Host "Executor $replaced stays installed: run executor upgrade --rollback to switch back."
  }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ($userPath) { $userPath.Split(";") } else { @() }
  if ($entries -contains $current) {
    Write-Host "Run: executor"
  } elseif ($env:EXECUTOR_NO_MODIFY_PATH -eq "1") {
    Write-Host "Add $current to your PATH, then run: executor"
  } else {
    [Environment]::SetEnvironmentVariable("Path", (@($entries | Where-Object { $_ }) + $current) -join ";", "User")
    Write-Host "Added $current to your user PATH. Open a new terminal, then run: executor"
  }
} finally {
  Remove-Item -Recurse -Force $temporary -ErrorAction SilentlyContinue
}
