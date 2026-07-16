[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string] $SetupPath,
  [string] $ExpectedVersion,
  [string] $UninstallerPath,
  [ValidateSet('InspectOnly', 'DisposableUser')]
  [string] $Mode = 'InspectOnly',
  [ValidateSet('Installed', 'Uninstalled')]
  [string] $FinalState = 'Uninstalled',
  [string] $ExpectedInstallRoot,
  [string] $ExpectedDataDirectory,
  [string] $ConfirmDisposableUser,
  [int] $TimeoutSeconds = 90,
  [switch] $AllowUnsigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
if (-not $ExpectedVersion) { $ExpectedVersion = $rootPackage.version }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "ExpectedVersion must be a three-part numeric version; received '$ExpectedVersion'."
}

$SetupPath = [System.IO.Path]::GetFullPath($SetupPath)
if (-not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) {
  throw "Squirrel Setup was not found: $SetupPath"
}
if ($UninstallerPath) {
  $UninstallerPath = [System.IO.Path]::GetFullPath($UninstallerPath)
  if (-not (Test-Path -LiteralPath $UninstallerPath -PathType Leaf)) {
    throw "Native uninstaller was not found: $UninstallerPath"
  }
}

function Get-VersionTriple([string] $Value) {
  $versionMatch = [regex]::Match($Value, '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)')
  if (-not $versionMatch.Success) { return $null }
  return '{0}.{1}.{2}' -f $versionMatch.Groups['major'].Value, $versionMatch.Groups['minor'].Value, $versionMatch.Groups['patch'].Value
}

function Assert-Executable([string] $Path, [string] $Label) {
  $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
  if ((Get-VersionTriple $versionInfo.FileVersion) -ne $ExpectedVersion) {
    throw "$Label file version '$($versionInfo.FileVersion)' does not match $ExpectedVersion."
  }
  if ((Get-VersionTriple $versionInfo.ProductVersion) -ne $ExpectedVersion) {
    throw "$Label product version '$($versionInfo.ProductVersion)' does not match $ExpectedVersion."
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if (-not $AllowUnsigned -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$Label requires a valid Authenticode signature; received $($signature.Status)."
  }
  [pscustomobject]@{
    Path = $Path
    FileVersion = $versionInfo.FileVersion
    ProductVersion = $versionInfo.ProductVersion
    Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    SignatureStatus = [string] $signature.Status
  }
}

$setupEvidence = Assert-Executable $SetupPath 'Squirrel Setup'
$uninstallerEvidence = if ($UninstallerPath) { Assert-Executable $UninstallerPath 'native uninstaller' } else { $null }
if ($Mode -eq 'InspectOnly') {
  [pscustomobject]@{
    Mode = $Mode
    MutatedCurrentUser = $false
    ExpectedVersion = $ExpectedVersion
    Setup = $setupEvidence
    Uninstaller = $uninstallerEvidence
  }
  return
}

if ($ConfirmDisposableUser -ne 'THIS IS A DISPOSABLE WINDOWS PROFILE') {
  throw 'DisposableUser mode requires -ConfirmDisposableUser "THIS IS A DISPOSABLE WINDOWS PROFILE".'
}

$defaultInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'balance_book_mvp'))
$defaultDataDirectory = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Balance Book'))
if (-not $ExpectedInstallRoot) { $ExpectedInstallRoot = $defaultInstallRoot }
if (-not $ExpectedDataDirectory) { $ExpectedDataDirectory = $defaultDataDirectory }
$ExpectedInstallRoot = [System.IO.Path]::GetFullPath($ExpectedInstallRoot)
$ExpectedDataDirectory = [System.IO.Path]::GetFullPath($ExpectedDataDirectory)
if (-not $ExpectedInstallRoot.Equals($defaultInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Squirrel uses the fixed current-user balance_book_mvp install root; custom install roots are not supported.'
}
if (-not $ExpectedDataDirectory.Equals($defaultDataDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The lifecycle smoke requires the standard current-user Balance Book data directory.'
}

$markerPath = Join-Path $env:USERPROFILE '.balance-book-disposable-release-test'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
  throw "DisposableUser mode requires marker file $markerPath."
}
$markerValue = (Get-Content -Raw -LiteralPath $markerPath).Trim()
if ($markerValue -ne 'BALANCE BOOK DISPOSABLE PROFILE') {
  throw 'The disposable-profile marker has the wrong value.'
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\balance_book_mvp'
if (
  (Test-Path -LiteralPath $ExpectedInstallRoot) -or
  (Test-Path -LiteralPath $ExpectedDataDirectory) -or
  (Test-Path -LiteralPath $uninstallKey)
) {
  throw 'DisposableUser mode refuses any Windows profile with an existing Balance Book installation or data directory.'
}

function Wait-Until([scriptblock] $Condition, [string] $FailureMessage) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw $FailureMessage
}

function Get-InstalledProcesses {
  $prefix = $ExpectedInstallRoot.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Close-InstalledApplication {
  foreach ($processRecord in (Get-InstalledProcesses)) {
    $process = Get-Process -Id $processRecord.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { [void] $process.CloseMainWindow() }
  }
  $deadline = (Get-Date).AddSeconds(20)
  do {
    if ((Get-InstalledProcesses).Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'Balance Book did not close gracefully; the disposable lifecycle test will not force-terminate it.'
}

function Assert-InstalledState {
  $installedExecutable = Join-Path $ExpectedInstallRoot "app-$ExpectedVersion\BalanceBook.exe"
  $stableLauncher = Join-Path $ExpectedInstallRoot 'BalanceBook.exe'
  Wait-Until { Test-Path -LiteralPath $installedExecutable -PathType Leaf } 'The expected versioned executable was not installed.'
  Wait-Until { Test-Path -LiteralPath $stableLauncher -PathType Leaf } 'The stable Squirrel launcher was not installed.'
  Wait-Until { Test-Path -LiteralPath $uninstallKey } 'Add/Remove Programs registration was not created.'
  $uninstallRecord = Get-ItemProperty -LiteralPath $uninstallKey
  if ($uninstallRecord.DisplayVersion -ne $ExpectedVersion) {
    throw "Add/Remove Programs reports version '$($uninstallRecord.DisplayVersion)', expected $ExpectedVersion."
  }
  if ((Get-VersionTriple (Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductVersion) -ne $ExpectedVersion) {
    throw 'The installed versioned executable has the wrong product version.'
  }
  $installedSignature = Get-AuthenticodeSignature -LiteralPath $installedExecutable
  if (-not $AllowUnsigned -and $installedSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "The installed BalanceBook.exe requires a valid Authenticode signature; received $($installedSignature.Status)."
  }

  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Balance Book.lnk'
  Wait-Until { Test-Path -LiteralPath $desktopShortcut -PathType Leaf } 'The desktop shortcut was not created.'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  if (-not ([System.IO.Path]::GetFullPath($shortcut.TargetPath)).Equals($stableLauncher, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The desktop shortcut does not target the stable latest-version launcher.'
  }
  $programsDirectory = [Environment]::GetFolderPath('Programs')
  $startMenuShortcuts = @(Get-ChildItem -LiteralPath $programsDirectory -Recurse -Filter 'Balance Book.lnk' -File -ErrorAction SilentlyContinue)
  if ($startMenuShortcuts.Count -ne 1) {
    throw "Expected exactly one Balance Book Start-menu shortcut; found $($startMenuShortcuts.Count)."
  }
  $startMenuShortcut = $shell.CreateShortcut($startMenuShortcuts[0].FullName)
  if (-not ([System.IO.Path]::GetFullPath($startMenuShortcut.TargetPath)).Equals($stableLauncher, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Start-menu shortcut does not target the stable latest-version launcher.'
  }
  return $stableLauncher
}

function Invoke-Setup {
  $process = Start-Process -FilePath $SetupPath -ArgumentList '--silent' -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Squirrel Setup returned exit code $($process.ExitCode)." }
  Assert-InstalledState
}

function Invoke-Uninstall([bool] $UseNativeHelper) {
  Close-InstalledApplication
  if ($UseNativeHelper) {
    $process = Start-Process -FilePath $UninstallerPath -ArgumentList '--silent' -PassThru -Wait
  } else {
    $updater = Join-Path $ExpectedInstallRoot 'Update.exe'
    if (-not (Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'Installed Squirrel updater was not found.' }
    $process = Start-Process -FilePath $updater -ArgumentList '--uninstall', '-s' -PassThru -Wait
  }
  if ($process.ExitCode -ne 0) { throw "Uninstaller returned exit code $($process.ExitCode)." }
  Wait-Until { -not (Test-Path -LiteralPath $uninstallKey) } 'Add/Remove Programs registration remained after uninstall.'
  Wait-Until { -not (Test-Path -LiteralPath $ExpectedInstallRoot) } 'The Squirrel application directory remained after uninstall.'
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Balance Book.lnk'
  Wait-Until { -not (Test-Path -LiteralPath $desktopShortcut) } 'The desktop shortcut remained after uninstall.'
  $programsDirectory = [Environment]::GetFolderPath('Programs')
  Wait-Until {
    @(Get-ChildItem -LiteralPath $programsDirectory -Recurse -Filter 'Balance Book.lnk' -File -ErrorAction SilentlyContinue).Count -eq 0
  } 'The Start-menu shortcut remained after uninstall.'
}

$firstStableLauncher = Invoke-Setup
if (-not (Test-Path -LiteralPath $ExpectedDataDirectory)) {
  Start-Process -FilePath $firstStableLauncher | Out-Null
}
$databasePath = Join-Path $ExpectedDataDirectory 'balance-book.sqlite'
Wait-Until { Test-Path -LiteralPath $databasePath -PathType Leaf } 'The installed application did not initialize its local database.'
Close-InstalledApplication
$databaseHashBeforeUninstall = (Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath).Hash

Invoke-Uninstall ([bool] $UninstallerPath)
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
  throw 'Uninstall removed the local database; user data must persist for reinstall.'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath).Hash -ne $databaseHashBeforeUninstall) {
  throw 'The local database changed while the application was uninstalled.'
}

$secondStableLauncher = Invoke-Setup
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
  throw 'Reinstall did not preserve the existing local database.'
}
Close-InstalledApplication

if ($FinalState -eq 'Uninstalled') {
  Invoke-Uninstall $false
  if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
    throw 'Final disposable cleanup removed the preserved local database.'
  }
}

[pscustomobject]@{
  Mode = $Mode
  MutatedCurrentUser = $true
  DisposableMarker = $markerPath
  Version = $ExpectedVersion
  InstallRoot = $ExpectedInstallRoot
  DataDirectory = $ExpectedDataDirectory
  FinalState = $FinalState
  NativeUninstallerExercised = [bool] $UninstallerPath
  SetupSha256 = $setupEvidence.Sha256
  UninstallerSha256 = if ($uninstallerEvidence) { $uninstallerEvidence.Sha256 } else { $null }
}
