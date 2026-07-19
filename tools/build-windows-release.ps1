[CmdletBinding()]
param(
  [string] $Version,
  [string] $BackupPath,
  [string] $OutputRoot,
  [string] $CandidateRoot,
  [switch] $SkipInstall,
  [switch] $SkipVerification,
  [switch] $SkipAudit,
  [switch] $SkipMake,
  [switch] $SkipPackagedSmoke,
  [switch] $OfflineSquirrel,
  [switch] $AllowUnsigned,
  [switch] $AllowDirty,
  [switch] $LocalUnsignedCandidate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPackagePath = Join-Path $repositoryRoot 'package.json'
$desktopPackagePath = Join-Path $repositoryRoot 'apps\desktop\package.json'
$rootPackage = Get-Content -Raw -LiteralPath $rootPackagePath | ConvertFrom-Json
$desktopPackage = Get-Content -Raw -LiteralPath $desktopPackagePath | ConvertFrom-Json
if (-not $Version) { $Version = $rootPackage.version }
if ($Version -notmatch '^1\.\d+\.\d+$') {
  throw "The V1 release lane requires a 1.x.y version; received '$Version'."
}
if ($rootPackage.version -ne $Version -or $desktopPackage.version -ne $Version) {
  throw "Root ($($rootPackage.version)) and desktop ($($desktopPackage.version)) versions must both equal $Version."
}
if ($rootPackage.name -ne 'balance-book-mvp') {
  throw "The stable Squirrel identity requires package name 'balance-book-mvp'."
}
if ([bool] $env:WINDOWS_CERTIFICATE_FILE -xor [bool] $env:WINDOWS_CERTIFICATE_PASSWORD) {
  throw 'WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must either both be set or both be absent.'
}
if ($env:WINDOWS_CERTIFICATE_FILE -and -not (Test-Path -LiteralPath $env:WINDOWS_CERTIFICATE_FILE -PathType Leaf)) {
  throw 'WINDOWS_CERTIFICATE_FILE does not identify a readable certificate file.'
}

if (-not $OutputRoot) { $OutputRoot = Join-Path $repositoryRoot 'local-releases' }
if (-not $CandidateRoot) { $CandidateRoot = Join-Path $repositoryRoot 'out\release-candidates' }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$CandidateRoot = [System.IO.Path]::GetFullPath($CandidateRoot)
$baseHandoffName = "Balance Book V1 - $Version"
$releaseClass = if ($LocalUnsignedCandidate) { 'local-unsigned-candidate' } else { 'public-production' }
$handoffName = if ($LocalUnsignedCandidate) { "$baseHandoffName - LOCAL UNSIGNED CANDIDATE" } else { $baseHandoffName }
$completeHandoffRoot = if ($LocalUnsignedCandidate) { Join-Path $OutputRoot 'candidates' } else { $OutputRoot }
$finalHandoffDirectory = Join-Path $completeHandoffRoot $handoffName
$candidateDirectory = Join-Path $CandidateRoot $handoffName
$metadataDirectory = Join-Path $OutputRoot 'metadata'

$skippedReleaseGates = @(
  if ($SkipInstall) { 'frozen-install' }
  if ($SkipVerification) { 'verify' }
  if ($SkipAudit) { 'production-audit' }
  if ($SkipMake) { 'make' }
  if ($SkipPackagedSmoke) { 'packaged-smoke' }
)
if ($LocalUnsignedCandidate -and -not $BackupPath) {
  throw 'LocalUnsignedCandidate requires BackupPath so the candidate contains the exact three-file handoff.'
}
if ($LocalUnsignedCandidate -and -not $AllowUnsigned) {
  throw 'LocalUnsignedCandidate requires AllowUnsigned so unsigned status is explicit.'
}
if ($LocalUnsignedCandidate -and -not $OfflineSquirrel) {
  throw 'LocalUnsignedCandidate requires OfflineSquirrel so the candidate can be rebuilt without Forge make.'
}
if (-not $LocalUnsignedCandidate -and $BackupPath -and $AllowUnsigned) {
  throw 'A complete unsigned handoff must use LocalUnsignedCandidate; public-production releases require valid signatures.'
}
if (-not $LocalUnsignedCandidate -and $BackupPath -and $AllowDirty) {
  throw 'A public-production handoff cannot use AllowDirty.'
}
if ($BackupPath -and $skippedReleaseGates.Count -gt 0 -and -not $LocalUnsignedCandidate) {
  throw "A complete V1 handoff cannot skip release gates: $($skippedReleaseGates -join ', ')."
}

$gitStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the release worktree.' }
if (-not $AllowDirty -and $gitStatus.Count -gt 0) {
  throw 'Release builds require a clean worktree. Use -AllowDirty only for an explicitly non-production candidate.'
}
$gitCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the release Git commit.' }
$gitTree = (& git -C $repositoryRoot rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the release Git tree.' }
$lockfileSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repositoryRoot 'pnpm-lock.yaml')).Hash

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand) { $pnpmCommand = Get-Command pnpm -ErrorAction Stop }

Push-Location $repositoryRoot
try {
  if (-not $SkipInstall) {
    & $pnpmCommand.Source install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Frozen dependency installation failed with exit code $LASTEXITCODE." }
  }
  if (-not $SkipVerification) {
    & $pnpmCommand.Source verify
    if ($LASTEXITCODE -ne 0) { throw "Release verification failed with exit code $LASTEXITCODE." }
  }
  if (-not $SkipAudit) {
    & $pnpmCommand.Source audit --prod --audit-level high
    if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed with exit code $LASTEXITCODE." }
  }
  if (-not $SkipMake) {
    if ($OfflineSquirrel) {
      & $pnpmCommand.Source package
      if ($LASTEXITCODE -ne 0) { throw "Production package creation failed with exit code $LASTEXITCODE." }
      & (Join-Path $PSScriptRoot 'build-squirrel-offline.ps1') -Version $Version -AllowUnsigned:$AllowUnsigned | Out-Null
    } else {
      & $pnpmCommand.Source make
      if ($LASTEXITCODE -ne 0) { throw "Squirrel release creation failed with exit code $LASTEXITCODE." }
    }
  }
  if (-not $SkipPackagedSmoke) {
    & (Join-Path $PSScriptRoot 'packaged-smoke.ps1')
    if ($LASTEXITCODE -ne 0) { throw "Packaged executable smoke failed with exit code $LASTEXITCODE." }
  }
}
finally {
  Pop-Location
}

$squirrelDirectory = Join-Path $repositoryRoot 'out\make\squirrel.windows\x64'
$setupSource = Join-Path $squirrelDirectory "Balance Book-$Version Setup.exe"
$packagePath = Join-Path $squirrelDirectory "balance_book_mvp-$Version-full.nupkg"
$releasesPath = Join-Path $squirrelDirectory 'RELEASES'
foreach ($artifact in @($setupSource, $packagePath, $releasesPath)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Expected Squirrel V1 artifact was not found: $artifact"
  }
}

$package = Get-Item -LiteralPath $packagePath
$expectedReleaseLine = '{0} {1} {2}' -f (Get-FileHash -Algorithm SHA1 -LiteralPath $packagePath).Hash, $package.Name, $package.Length
$actualReleaseLine = [string] (Get-Content -LiteralPath $releasesPath | Where-Object { $_.Trim() } | Select-Object -First 1)
if ($actualReleaseLine -ne $expectedReleaseLine) {
  throw 'Squirrel RELEASES does not exactly match the full package hash, name, and length.'
}

$uninstallerBuildPath = Join-Path $repositoryRoot 'out\release-tools\windows-uninstaller\Uninstall Balance Book.exe'
$shouldSignUninstaller = [bool] ($env:WINDOWS_CERTIFICATE_FILE -and $env:WINDOWS_CERTIFICATE_PASSWORD)
$uninstallerBuild = & (Join-Path $PSScriptRoot 'windows-uninstaller\build-windows-uninstaller.ps1') -Version $Version -OutputPath $uninstallerBuildPath -Sign:$shouldSignUninstaller
if (-not $uninstallerBuild) { throw 'The native uninstaller build did not return validation evidence.' }

& (Join-Path $PSScriptRoot 'installer-lifecycle-smoke.ps1') -SetupPath $setupSource -UninstallerPath $uninstallerBuildPath -ExpectedVersion $Version -Mode InspectOnly -AllowUnsigned:$AllowUnsigned | Out-Null

$setupSignature = Get-AuthenticodeSignature -LiteralPath $setupSource
$uninstallerSignature = Get-AuthenticodeSignature -LiteralPath $uninstallerBuildPath
$packagedExecutablePath = Join-Path $repositoryRoot 'out\Balance Book-win32-x64\BalanceBook.exe'
if (-not (Test-Path -LiteralPath $packagedExecutablePath -PathType Leaf)) {
  throw "Expected packaged application executable was not found: $packagedExecutablePath"
}
$packagedExecutable = Get-Item -LiteralPath $packagedExecutablePath
if (-not $AllowUnsigned) {
  foreach ($signatureRecord in @(
    @{ Name = 'Squirrel Setup'; Signature = $setupSignature },
    @{ Name = 'native uninstaller'; Signature = $uninstallerSignature }
  )) {
    if ($signatureRecord.Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "Production release requires a valid Authenticode signature: $($signatureRecord.Name) is $($signatureRecord.Signature.Status)."
    }
  }
}

$installerName = "1 - Install Balance Book V1 ($Version).exe"
$uninstallerName = '2 - Uninstall Balance Book.exe'
$backupName = '3 - Balance Book V1 Private Backup.balancebook-backup'

if (-not $BackupPath) {
  if (Test-Path -LiteralPath $candidateDirectory) {
    throw "Refusing to overwrite an existing release candidate: $candidateDirectory"
  }
  New-Item -ItemType Directory -Path $candidateDirectory -Force | Out-Null
  Copy-Item -LiteralPath $setupSource -Destination (Join-Path $candidateDirectory $installerName)
  Copy-Item -LiteralPath $uninstallerBuildPath -Destination (Join-Path $candidateDirectory $uninstallerName)

  $candidateFiles = @(Get-ChildItem -LiteralPath $candidateDirectory -File | Sort-Object Name)
  $candidateMetadata = [ordered]@{
    format = 'balance-book-windows-release-candidate'
    metadataVersion = 1
    completeHandoff = $false
    releaseClass = if ($AllowUnsigned) { 'local-unsigned-binary-candidate' } else { 'signed-binary-candidate' }
    productionReady = $false
    missing = $backupName
    product = 'Balance Book'
    releaseLabel = 'V1'
    version = $Version
    installerIdentity = 'balance_book_mvp'
    squirrelBuildMode = if ($OfflineSquirrel) { 'offline-direct-squirrel' } else { 'electron-forge' }
    architecture = 'x64'
    gitCommit = $gitCommit
    gitTree = $gitTree
    lockfileSha256 = $lockfileSha256
    worktreeDirty = $gitStatus.Count -gt 0
    skippedReleaseGates = @($skippedReleaseGates)
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    setupSignatureStatus = [string] $setupSignature.Status
    uninstallerSignatureStatus = [string] $uninstallerSignature.Status
    packagedExecutable = [ordered]@{
      name = $packagedExecutable.Name
      sizeBytes = $packagedExecutable.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedExecutable.FullName).Hash
    }
    squirrelPackage = [ordered]@{
      name = $package.Name
      sizeBytes = $package.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $package.FullName).Hash
      releasesLine = $actualReleaseLine
    }
    files = @($candidateFiles | ForEach-Object {
      [ordered]@{ name = $_.Name; sizeBytes = $_.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash }
    })
  }
  $candidateMetadataDirectory = Join-Path $CandidateRoot 'metadata'
  New-Item -ItemType Directory -Path $candidateMetadataDirectory -Force | Out-Null
  $candidateMetadataPath = Join-Path $candidateMetadataDirectory "Balance Book V1 - $Version.candidate.json"
  [System.IO.File]::WriteAllText(
    $candidateMetadataPath,
    (($candidateMetadata | ConvertTo-Json -Depth 7) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  [pscustomobject]@{
    CompleteHandoff = $false
    CandidateDirectory = $candidateDirectory
    MetadataPath = $candidateMetadataPath
    MissingFile = $backupName
  }
  return
}

$BackupPath = [System.IO.Path]::GetFullPath($BackupPath)
if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
  throw "Encrypted backup was not found: $BackupPath"
}
if ([System.IO.Path]::GetExtension($BackupPath) -ine '.balancebook-backup') {
  throw 'BackupPath must use the .balancebook-backup extension.'
}
if (Test-Path -LiteralPath $finalHandoffDirectory) {
  throw "Refusing to overwrite an existing V1 handoff: $finalHandoffDirectory"
}

$temporaryBase = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'out\release-staging'))
New-Item -ItemType Directory -Path $temporaryBase -Force | Out-Null
$temporaryDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $temporaryBase ('BalanceBookV1-' + [guid]::NewGuid().ToString('N')))
)
if (
  -not $temporaryDirectory.StartsWith(($temporaryBase.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
  -not (Split-Path -Leaf $temporaryDirectory).StartsWith('BalanceBookV1-')
) {
  throw 'Refusing to use an unsafe V1 staging directory.'
}

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  Copy-Item -LiteralPath $setupSource -Destination (Join-Path $temporaryDirectory $installerName)
  Copy-Item -LiteralPath $uninstallerBuildPath -Destination (Join-Path $temporaryDirectory $uninstallerName)
  Copy-Item -LiteralPath $BackupPath -Destination (Join-Path $temporaryDirectory $backupName)

  & (Join-Path $PSScriptRoot 'validate-windows-release.ps1') -HandoffDirectory $temporaryDirectory -ExpectedVersion $Version -SquirrelArtifactDirectory $squirrelDirectory -ReleaseClass $releaseClass -SkippedReleaseGates $skippedReleaseGates -AllowUnsigned:$AllowUnsigned | Out-Null

  New-Item -ItemType Directory -Path $completeHandoffRoot -Force | Out-Null
  Move-Item -LiteralPath $temporaryDirectory -Destination $finalHandoffDirectory

  New-Item -ItemType Directory -Path $metadataDirectory -Force | Out-Null
  $metadataSuffix = if ($LocalUnsignedCandidate) { 'local-unsigned-candidate' } else { 'release' }
  $metadataPath = Join-Path $metadataDirectory "Balance Book V1 - $Version.$metadataSuffix.json"
  $validation = & (Join-Path $PSScriptRoot 'validate-windows-release.ps1') -HandoffDirectory $finalHandoffDirectory -ExpectedVersion $Version -SquirrelArtifactDirectory $squirrelDirectory -MetadataPath $metadataPath -ReleaseClass $releaseClass -SkippedReleaseGates $skippedReleaseGates -AllowUnsigned:$AllowUnsigned
  $hashManifestPath = Join-Path $metadataDirectory "Balance Book V1 - $Version.$metadataSuffix.sha256.txt"
  $hashLines = Get-ChildItem -LiteralPath $finalHandoffDirectory -File | Sort-Object Name | ForEach-Object {
    '{0} *{1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash, $_.Name
  }
  [System.IO.File]::WriteAllLines($hashManifestPath, $hashLines, [System.Text.UTF8Encoding]::new($false))

  [pscustomobject]@{
    CompleteHandoff = $true
    ReleaseClass = $releaseClass
    ProductionReady = -not $LocalUnsignedCandidate
    HandoffDirectory = $finalHandoffDirectory
    MetadataPath = $metadataPath
    HashManifestPath = $hashManifestPath
    Validation = $validation
  }
}
finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
