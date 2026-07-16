[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string] $HandoffDirectory,
  [string] $ExpectedVersion,
  [string] $SquirrelArtifactDirectory,
  [string] $MetadataPath,
  [ValidateSet('public-production', 'local-unsigned-candidate')]
  [string] $ReleaseClass,
  [string[]] $SkippedReleaseGates = @(),
  [switch] $AllowUnsigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
$desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\package.json') | ConvertFrom-Json
if (-not $ExpectedVersion) { $ExpectedVersion = $rootPackage.version }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "ExpectedVersion must be a three-part numeric version; received '$ExpectedVersion'."
}
if ($rootPackage.version -ne $ExpectedVersion -or $desktopPackage.version -ne $ExpectedVersion) {
  throw "Root ($($rootPackage.version)) and desktop ($($desktopPackage.version)) versions must both equal $ExpectedVersion."
}
if ($rootPackage.name -ne 'balance-book-mvp') {
  throw "The stable Squirrel identity requires package name 'balance-book-mvp'."
}
if (-not $ReleaseClass) {
  $ReleaseClass = if ($AllowUnsigned) { 'local-unsigned-candidate' } else { 'public-production' }
}
if ($ReleaseClass -eq 'public-production' -and $AllowUnsigned) {
  throw 'Public-production validation cannot allow unsigned executables.'
}
if ($ReleaseClass -eq 'public-production' -and $SkippedReleaseGates.Count -gt 0) {
  throw "Public-production validation cannot skip release gates: $($SkippedReleaseGates -join ', ')."
}
if ($ReleaseClass -eq 'local-unsigned-candidate' -and -not $AllowUnsigned) {
  throw 'A local unsigned candidate must explicitly use AllowUnsigned.'
}

$HandoffDirectory = [System.IO.Path]::GetFullPath($HandoffDirectory)
if (-not (Test-Path -LiteralPath $HandoffDirectory -PathType Container)) {
  throw "Handoff directory was not found: $HandoffDirectory"
}

$expectedNames = @(
  "1 - Install Balance Book V1 ($ExpectedVersion).exe",
  '2 - Uninstall Balance Book.exe',
  '3 - Balance Book V1 Private Backup.balancebook-backup'
)
$children = @(Get-ChildItem -LiteralPath $HandoffDirectory -Force)
$files = @($children | Where-Object { -not $_.PSIsContainer })
$directories = @($children | Where-Object { $_.PSIsContainer })
if ($files.Count -ne 3 -or $directories.Count -ne 0) {
  throw "The V1 handoff must contain exactly three files and no directories; found $($files.Count) file(s) and $($directories.Count) directory(ies)."
}
$nameDifferences = @(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $files.Name)
if ($nameDifferences.Count -ne 0) {
  throw "The V1 handoff file names do not match the exact release contract: $($files.Name -join ', ')"
}
if ($files | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 }) {
  throw 'The V1 handoff may not contain links or reparse points.'
}

function Get-VersionTriple([string] $Value) {
  $versionMatch = [regex]::Match($Value, '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)')
  if (-not $versionMatch.Success) { return $null }
  return '{0}.{1}.{2}' -f $versionMatch.Groups['major'].Value, $versionMatch.Groups['minor'].Value, $versionMatch.Groups['patch'].Value
}

function Get-SignatureRecord([string] $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if (-not $AllowUnsigned -and $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "A production release requires a valid Authenticode signature: $(Split-Path -Leaf $Path) is $($signature.Status)."
  }
  [ordered]@{
    status = [string] $signature.Status
    signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    timestampThumbprint = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Thumbprint } else { $null }
  }
}

function Get-PeMachine([string] $Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Not a Windows executable: $Path" }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0 -or $peOffset -gt ($stream.Length - 6)) { throw "Invalid PE header: $Path" }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
    return $reader.ReadUInt16()
  }
  finally {
    $stream.Dispose()
  }
}

$setupPath = Join-Path $HandoffDirectory $expectedNames[0]
$uninstallerPath = Join-Path $HandoffDirectory $expectedNames[1]
$backupPath = Join-Path $HandoffDirectory $expectedNames[2]

foreach ($executablePath in @($setupPath, $uninstallerPath)) {
  $versionInfo = (Get-Item -LiteralPath $executablePath).VersionInfo
  if ((Get-VersionTriple $versionInfo.FileVersion) -ne $ExpectedVersion) {
    throw "$(Split-Path -Leaf $executablePath) has file version '$($versionInfo.FileVersion)', expected $ExpectedVersion."
  }
  if ((Get-VersionTriple $versionInfo.ProductVersion) -ne $ExpectedVersion) {
    throw "$(Split-Path -Leaf $executablePath) has product version '$($versionInfo.ProductVersion)', expected $ExpectedVersion."
  }
}

$uninstallerMachine = Get-PeMachine $uninstallerPath
if ($uninstallerMachine -ne 0x8664) {
  throw ('The native uninstaller must be x64; PE machine value was 0x{0:X4}.' -f $uninstallerMachine)
}

$backupFile = Get-Item -LiteralPath $backupPath
if ($backupFile.Length -le 0 -or $backupFile.Length -gt (100 * 1024 * 1024)) {
  throw 'The encrypted backup is empty or exceeds the application 100 MiB limit.'
}
try {
  $backupEnvelope = Get-Content -Raw -LiteralPath $backupPath | ConvertFrom-Json
}
catch {
  throw 'The encrypted backup is not a valid Balance Book JSON envelope.'
}
if (
  $backupEnvelope.format -ne 'balance-book-encrypted-backup' -or
  $backupEnvelope.version -ne 2 -or
  $backupEnvelope.algorithm -ne 'aes-256-gcm' -or
  $backupEnvelope.kdf -ne 'scrypt'
) {
  throw 'The backup envelope has an unsupported format, version, algorithm, or key-derivation function.'
}
$expectedEnvelopeFields = @('algorithm', 'authTag', 'ciphertext', 'format', 'iv', 'kdf', 'kdfParameters', 'salt', 'version')
$actualEnvelopeFields = @($backupEnvelope.PSObject.Properties.Name | Sort-Object)
if (@(Compare-Object $expectedEnvelopeFields $actualEnvelopeFields).Count -ne 0) {
  throw 'The encrypted backup envelope has missing or unexpected fields.'
}
$expectedKdfFields = @('keyLength', 'N', 'p', 'r')
$actualKdfFields = @($backupEnvelope.kdfParameters.PSObject.Properties.Name | Sort-Object)
if (
  @(Compare-Object $expectedKdfFields $actualKdfFields).Count -ne 0 -or
  $backupEnvelope.kdfParameters.N -ne 32768 -or
  $backupEnvelope.kdfParameters.r -ne 8 -or
  $backupEnvelope.kdfParameters.p -ne 1 -or
  $backupEnvelope.kdfParameters.keyLength -ne 32
) {
  throw 'The encrypted backup envelope has unsupported scrypt parameters.'
}
$decodedFields = @{}
foreach ($field in @('salt', 'iv', 'authTag', 'ciphertext')) {
  $value = $backupEnvelope.$field
  if (-not ($value -is [string]) -or [string]::IsNullOrWhiteSpace($value)) {
    throw "The encrypted backup envelope is missing $field."
  }
  try { $decodedFields[$field] = [Convert]::FromBase64String($value) }
  catch { throw "The encrypted backup envelope has invalid base64 in $field." }
  if ([Convert]::ToBase64String($decodedFields[$field]) -cne $value) {
    throw "The encrypted backup envelope has non-canonical base64 in $field."
  }
}
if (
  $decodedFields.salt.Length -ne 16 -or
  $decodedFields.iv.Length -ne 12 -or
  $decodedFields.authTag.Length -ne 16 -or
  $decodedFields.ciphertext.Length -le 0
) {
  throw 'The encrypted backup envelope has an invalid salt, IV, authentication tag, or ciphertext length.'
}

$squirrelValidated = $false
$packagedExecutableRecord = $null
if (-not $SquirrelArtifactDirectory) {
  $defaultSquirrelDirectory = Join-Path $repositoryRoot 'out\make\squirrel.windows\x64'
  if (Test-Path -LiteralPath $defaultSquirrelDirectory -PathType Container) {
    $SquirrelArtifactDirectory = $defaultSquirrelDirectory
  }
}
if ($SquirrelArtifactDirectory) {
  $SquirrelArtifactDirectory = [System.IO.Path]::GetFullPath($SquirrelArtifactDirectory)
  $packagePath = Join-Path $SquirrelArtifactDirectory "balance_book_mvp-$ExpectedVersion-full.nupkg"
  $releasesPath = Join-Path $SquirrelArtifactDirectory 'RELEASES'
  $sourceSetupPath = Join-Path $SquirrelArtifactDirectory "Balance Book-$ExpectedVersion Setup.exe"
  foreach ($artifact in @($packagePath, $releasesPath, $sourceSetupPath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "Expected Squirrel artifact was not found: $artifact"
    }
  }
  $releaseLine = (Get-Content -LiteralPath $releasesPath | Where-Object { $_.Trim() } | Select-Object -First 1)
  $package = Get-Item -LiteralPath $packagePath
  $expectedReleaseLine = '{0} {1} {2}' -f (Get-FileHash -Algorithm SHA1 -LiteralPath $packagePath).Hash, $package.Name, $package.Length
  if ($releaseLine -ne $expectedReleaseLine) {
    throw 'Squirrel RELEASES does not exactly match the full V1 package hash, name, and length.'
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceSetupPath).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $setupPath).Hash) {
    throw 'The handoff installer is not byte-identical to the validated Squirrel Setup artifact.'
  }

  $packageArchive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
  try {
    foreach ($noticeEntryName in @(
      'lib/net45/resources/LICENSE',
      'lib/net45/resources/THIRD_PARTY_NOTICES.txt'
    )) {
      $noticeEntries = @(
        $packageArchive.Entries | Where-Object {
          $_.FullName.Replace('\', '/').Equals(
            $noticeEntryName,
            [System.StringComparison]::OrdinalIgnoreCase
          )
        }
      )
      if ($noticeEntries.Count -ne 1 -or $noticeEntries[0].Length -le 0) {
        throw "Expected one non-empty $noticeEntryName payload in the Squirrel package."
      }
    }
    $packagedExecutableEntries = @(
      $packageArchive.Entries | Where-Object {
        $_.FullName.Replace('\', '/').Equals(
          'lib/net45/BalanceBook.exe',
          [System.StringComparison]::OrdinalIgnoreCase
        )
      }
    )
    if ($packagedExecutableEntries.Count -ne 1) {
      throw "Expected exactly one lib/net45/BalanceBook.exe payload; found $($packagedExecutableEntries.Count)."
    }
    $packagedExecutableEntry = $packagedExecutableEntries[0]
    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $temporaryExecutable = [System.IO.Path]::GetFullPath(
      (Join-Path $temporaryBase ('BalanceBook-signature-' + [guid]::NewGuid().ToString('N') + '.exe'))
    )
    if (
      -not $temporaryExecutable.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $temporaryExecutable).StartsWith('BalanceBook-signature-')
    ) {
      throw 'Refusing to use an unsafe packaged-executable validation path.'
    }
    try {
      $entryStream = $null
      try {
        $entryStream = $packagedExecutableEntry.Open()
        $fileStream = $null
        try {
          $fileStream = [System.IO.File]::Open(
            $temporaryExecutable,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
          )
          $entryStream.CopyTo($fileStream, 1MB)
        }
        finally {
          if ($fileStream) { $fileStream.Dispose() }
        }
      }
      finally {
        if ($entryStream) { $entryStream.Dispose() }
      }
      $packagedVersionInfo = (Get-Item -LiteralPath $temporaryExecutable).VersionInfo
      if (
        (Get-VersionTriple $packagedVersionInfo.FileVersion) -ne $ExpectedVersion -or
        (Get-VersionTriple $packagedVersionInfo.ProductVersion) -ne $ExpectedVersion
      ) {
        throw 'The packaged BalanceBook.exe version does not match the release version.'
      }
      $packagedExecutableSignature = Get-SignatureRecord $temporaryExecutable
      $packagedExecutableRecord = [ordered]@{
        packageEntry = 'lib/net45/BalanceBook.exe'
        sizeBytes = $packagedExecutableEntry.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryExecutable).Hash
        fileVersion = $packagedVersionInfo.FileVersion
        productVersion = $packagedVersionInfo.ProductVersion
        signature = $packagedExecutableSignature
      }
    }
    finally {
      if (Test-Path -LiteralPath $temporaryExecutable -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryExecutable -Force
      }
    }
  }
  finally {
    $packageArchive.Dispose()
  }
  $squirrelValidated = $true
}

$setupSignature = Get-SignatureRecord $setupPath
$uninstallerSignature = Get-SignatureRecord $uninstallerPath
$fileRecords = foreach ($file in ($files | Sort-Object Name)) {
  $isExecutable = $file.Extension -ieq '.exe'
  $versionInfo = if ($isExecutable) { $file.VersionInfo } else { $null }
  [ordered]@{
    name = $file.Name
    sizeBytes = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
    fileVersion = if ($versionInfo) { $versionInfo.FileVersion } else { $null }
    productVersion = if ($versionInfo) { $versionInfo.ProductVersion } else { $null }
    signatureStatus = if ($file.FullName -eq $setupPath) { $setupSignature.status } elseif ($file.FullName -eq $uninstallerPath) { $uninstallerSignature.status } else { $null }
  }
}

$gitCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the release Git commit.' }
$gitStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
$metadata = [ordered]@{
  format = 'balance-book-windows-release-metadata'
  metadataVersion = 1
  product = 'Balance Book'
  releaseLabel = 'V1'
  releaseClass = $ReleaseClass
  productionReady = $ReleaseClass -eq 'public-production' -and $gitStatus.Count -eq 0
  version = $ExpectedVersion
  installerIdentity = 'balance_book_mvp'
  architecture = 'x64'
  minimumOperatingSystem = 'Windows 11 x64'
  gitCommit = $gitCommit
  worktreeDirty = $gitStatus.Count -gt 0
  validatedAtUtc = [DateTime]::UtcNow.ToString('o')
  signaturesRequired = -not $AllowUnsigned
  skippedReleaseGates = @($SkippedReleaseGates)
  squirrelArtifactsValidated = $squirrelValidated
  packagedExecutable = $packagedExecutableRecord
  setupSignature = $setupSignature
  uninstallerSignature = $uninstallerSignature
  files = @($fileRecords)
}

if ($MetadataPath) {
  $MetadataPath = [System.IO.Path]::GetFullPath($MetadataPath)
  $handoffPrefix = $HandoffDirectory.TrimEnd('\') + '\'
  if ($MetadataPath.StartsWith($handoffPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release metadata must remain outside the exact three-file handoff directory.'
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $MetadataPath) -Force | Out-Null
  [System.IO.File]::WriteAllText(
    $MetadataPath,
    (($metadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
}

[pscustomobject] $metadata
