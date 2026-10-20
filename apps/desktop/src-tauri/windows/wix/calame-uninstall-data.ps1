# Removes the Calame data of the Windows account running it. Called only by the MSI
# uninstaller (calame-uninstall-data.wxs), as a deferred custom action impersonating the
# user who launched the uninstall, when that user ticked the data option. Any failure
# exits non-zero without deleting anything, which makes the MSI stop and roll back the
# uninstall with an error (Return="check") rather than hide it.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$DataDir
)

$ErrorActionPreference = 'Stop'
$BundleId = 'tech.calame.desktop'
$DataDirName = 'Calame'

function Get-NormalizedPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

# Profile of the account this script really runs as, never the one of whoever elevated the
# install: the folder shown in the uninstall dialog must be this account's own data folder.
$appData = [Environment]::GetFolderPath('ApplicationData')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $appData -or -not $localAppData) { exit 2 }
$expected = Join-Path $appData $DataDirName
if ((Get-NormalizedPath $DataDir) -ne (Get-NormalizedPath $expected)) { exit 3 }

# Stop this account's Calame app and Node server (the ones started from the install dir),
# so that calame.db is no longer open. Other accounts' processes are left alone.
$installRoot = (Get-NormalizedPath $InstallDir) + '\'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'calame-desktop.exe' OR Name = 'node.exe'" |
  Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) -and
    (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid -eq $me
  })
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($processes.Count -gt 0) { Start-Sleep -Seconds 2 }

if (Test-Path -LiteralPath $expected) {
  # A junction or link could point outside the profile: leave it alone.
  if ((Get-Item -LiteralPath $expected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 4 }
  # Renaming fails while a file inside is still open: calame.db and .calame-secret are then
  # both kept instead of being half-deleted.
  $trashName = "$DataDirName.uninstall-$([DateTime]::UtcNow.Ticks)"
  try {
    Rename-Item -LiteralPath $expected -NewName $trashName
  } catch {
    exit 5
  }
  Remove-Item -LiteralPath (Join-Path $appData $trashName) -Recurse -Force -ErrorAction SilentlyContinue
}

# Tauri shell data (WebView2 profile, cache) of the same account.
foreach ($dir in @((Join-Path $appData $BundleId), (Join-Path $localAppData $BundleId))) {
  if ((Test-Path -LiteralPath $dir) -and -not ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
exit 0
