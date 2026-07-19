[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $SetupPath,
  [Parameter(Mandatory = $true)]
  [string] $UninstallerPath,
  [Parameter(Mandatory = $true)]
  [string] $PackagedExecutablePath,
  [Parameter(Mandatory = $true)]
  [string] $SquirrelArtifactDirectory,
  [Parameter(Mandatory = $true)]
  [string] $BuildMetadataPath,
  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory,
  [Parameter(Mandatory = $true)]
  [string] $ExpectedPublisher,
  [Parameter(Mandatory = $true)]
  [string] $ExpectedPublisherThumbprint,
  [string] $ExpectedSourceBranch = 'main'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$setupSource = [System.IO.Path]::GetFullPath($SetupPath)
$uninstallerSource = [System.IO.Path]::GetFullPath($UninstallerPath)
$packagedExecutableSource = [System.IO.Path]::GetFullPath($PackagedExecutablePath)
$squirrelPath = [System.IO.Path]::GetFullPath($SquirrelArtifactDirectory)
$buildMetadataSource = [System.IO.Path]::GetFullPath($BuildMetadataPath)
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$utf8 = [System.Text.UTF8Encoding]::new($false)

if (
  $outputPath -eq $repositoryRoot -or
  $repositoryRoot.StartsWith(($outputPath.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
  $outputPath.StartsWith(($repositoryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'OutputDirectory cannot be the public source repository, one of its parents, or one of its children.'
}
if (Test-Path -LiteralPath $outputPath) {
  throw "Refusing to overwrite an existing public-release directory: $outputPath"
}
foreach ($inputPath in @($setupSource, $uninstallerSource, $packagedExecutableSource)) {
  if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    throw "Required public-release input does not exist: $inputPath"
  }
}
if (-not (Test-Path -LiteralPath $buildMetadataSource -PathType Leaf)) {
  throw "BuildMetadataPath does not exist: $buildMetadataSource"
}
if (-not (Test-Path -LiteralPath $squirrelPath -PathType Container)) {
  throw "SquirrelArtifactDirectory does not exist: $squirrelPath"
}

$status = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the public source repository.' }
if ($status.Count -gt 0) { throw 'The public source repository must be clean before release assembly.' }
$branch = (& git -C $repositoryRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne $ExpectedSourceBranch) {
  throw "Expected public source branch '$ExpectedSourceBranch'; found '$branch'."
}
$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$sourceTree = (& git -C $repositoryRoot rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the exact public source commit and tree.' }

$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
$desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\package.json') | ConvertFrom-Json
$version = [string] $rootPackage.version
if ($version -ne [string] $desktopPackage.version -or $version -notmatch '^1\.\d+\.\d+$') {
  throw "Root and desktop packages must identify the same V1 SemVer version; found '$version' and '$($desktopPackage.version)'."
}

function Get-VersionTriple([System.IO.FileInfo] $File) {
  $raw = if ($File.VersionInfo.ProductVersion) { $File.VersionInfo.ProductVersion } else { $File.VersionInfo.FileVersion }
  try {
    $parsed = [version] $raw
    "$($parsed.Major).$($parsed.Minor).$($parsed.Build)"
  }
  catch {
    ''
  }
}

function Assert-PublicExecutable([string] $Path, [string] $Label) {
  $file = Get-Item -LiteralPath $Path
  $fileVersion = Get-VersionTriple $file
  if ($fileVersion -ne $version) {
    throw "$Label version '$fileVersion' does not equal package version '$version'."
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$Label must have a valid Authenticode signature; found '$($signature.Status)'."
  }
  if ($signature.SignerCertificate.Subject -cne $ExpectedPublisher) {
    throw "$Label is not signed by the expected publisher '$ExpectedPublisher'."
  }
  if ($signature.SignerCertificate.Thumbprint -ine $ExpectedPublisherThumbprint.Replace(' ', '')) {
    throw "$Label signer thumbprint does not equal the reviewed publisher certificate thumbprint."
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "$Label does not have a trusted timestamp certificate."
  }
  [pscustomobject]@{
    File = $file
    Signature = $signature
    Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
  }
}

$setupEvidence = Assert-PublicExecutable $setupSource 'Setup'
$uninstallerEvidence = Assert-PublicExecutable $uninstallerSource 'Uninstall helper'
$packagedEvidence = Assert-PublicExecutable $packagedExecutableSource 'Packaged application'

try {
  $buildMetadata = Get-Content -Raw -LiteralPath $buildMetadataSource | ConvertFrom-Json
}
catch {
  throw 'BuildMetadataPath is not valid release-candidate JSON.'
}
if (
  $buildMetadata.format -ne 'balance-book-windows-release-candidate' -or
  $buildMetadata.metadataVersion -ne 1 -or
  $buildMetadata.releaseClass -ne 'signed-binary-candidate' -or
  $buildMetadata.version -ne $version -or
  $buildMetadata.gitCommit -ne $sourceCommit -or
  $buildMetadata.gitTree -ne $sourceTree -or
  $buildMetadata.lockfileSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repositoryRoot 'pnpm-lock.yaml')).Hash -or
  $buildMetadata.worktreeDirty -or
  @($buildMetadata.skippedReleaseGates).Count -ne 0 -or
  $buildMetadata.setupSignatureStatus -ne 'Valid' -or
  $buildMetadata.uninstallerSignatureStatus -ne 'Valid'
) {
  throw 'Build metadata does not prove a clean, complete, signed build from the exact public source commit and tree.'
}
$metadataFileHashes = @($buildMetadata.files | ForEach-Object { $_.sha256 })
if ($setupEvidence.Sha256 -notin $metadataFileHashes -or $uninstallerEvidence.Sha256 -notin $metadataFileHashes) {
  throw 'Build metadata does not identify the exact Setup and uninstall helper bytes supplied to the assembler.'
}
if (
  $buildMetadata.packagedExecutable.name -ne $packagedEvidence.File.Name -or
  $buildMetadata.packagedExecutable.sha256 -ne $packagedEvidence.Sha256
) {
  throw 'Build metadata does not identify the exact packaged application supplied to the assembler.'
}

$squirrelSetup = Join-Path $squirrelPath "Balance Book-$version Setup.exe"
$squirrelPackage = Join-Path $squirrelPath "balance_book_mvp-$version-full.nupkg"
$squirrelReleases = Join-Path $squirrelPath 'RELEASES'
foreach ($artifact in @($squirrelSetup, $squirrelPackage, $squirrelReleases)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Required Squirrel artifact is missing: $artifact"
  }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $squirrelSetup).Hash -ne $setupEvidence.Sha256) {
  throw 'SetupPath is not byte-identical to the Setup in SquirrelArtifactDirectory.'
}
$packageFile = Get-Item -LiteralPath $squirrelPackage
$expectedReleaseLine = '{0} {1} {2}' -f (Get-FileHash -Algorithm SHA1 -LiteralPath $packageFile.FullName).Hash, $packageFile.Name, $packageFile.Length
$actualReleaseLine = [string] (Get-Content -LiteralPath $squirrelReleases | Where-Object { $_.Trim() } | Select-Object -First 1)
if ($actualReleaseLine -ne $expectedReleaseLine) {
  throw 'Squirrel RELEASES does not exactly bind the full package hash, name, and length.'
}
if (
  $buildMetadata.squirrelPackage.name -ne $packageFile.Name -or
  $buildMetadata.squirrelPackage.sizeBytes -ne $packageFile.Length -or
  $buildMetadata.squirrelPackage.sha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $packageFile.FullName).Hash -or
  $buildMetadata.squirrelPackage.releasesLine -ne $actualReleaseLine
) {
  throw 'Build metadata does not identify the exact Squirrel package and RELEASES evidence supplied to the assembler.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageArchive = [System.IO.Compression.ZipFile]::OpenRead($packageFile.FullName)
try {
  $payloadEntries = @(
    $packageArchive.Entries | Where-Object {
      $_.FullName.Replace('\', '/').Equals(
        "lib/net45/$($packagedEvidence.File.Name)",
        [System.StringComparison]::OrdinalIgnoreCase
      )
    }
  )
  if ($payloadEntries.Count -ne 1) {
    throw 'The Squirrel package does not contain exactly one expected packaged application executable.'
  }
  $payloadStream = $payloadEntries[0].Open()
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $payloadHash = ([BitConverter]::ToString($sha.ComputeHash($payloadStream))).Replace('-', '')
    }
    finally {
      $sha.Dispose()
    }
  }
  finally {
    $payloadStream.Dispose()
  }
  if ($payloadHash -ne $packagedEvidence.Sha256) {
    throw 'PackagedExecutablePath is not byte-identical to the application payload inside the Squirrel package.'
  }
}
finally {
  $packageArchive.Dispose()
}

$licenseSource = Join-Path $repositoryRoot 'LICENSE'
$noticesSource = Join-Path $repositoryRoot 'THIRD_PARTY_NOTICES.txt'
foreach ($legalPath in @($licenseSource, $noticesSource)) {
  if (-not (Test-Path -LiteralPath $legalPath -PathType Leaf)) {
    throw "Required legal notice is missing: $legalPath"
  }
}

New-Item -ItemType Directory -Path $outputPath | Out-Null
$setupName = "Balance-Book-$version-Setup.exe"
$uninstallerName = "Uninstall-Balance-Book-$version.exe"
$setupOutput = Join-Path $outputPath $setupName
$uninstallerOutput = Join-Path $outputPath $uninstallerName
Copy-Item -LiteralPath $setupSource -Destination $setupOutput
Copy-Item -LiteralPath $uninstallerSource -Destination $uninstallerOutput
Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $outputPath 'LICENSE.txt')
Copy-Item -LiteralPath $noticesSource -Destination (Join-Path $outputPath 'THIRD_PARTY_NOTICES.txt')

$readme = @"
Balance Book $version - signed Windows 11 x64 artifact set

These files passed assembly-time source, build-evidence, package, version, hash, signature, and notice checks. They are not a published release until every dependency, lifecycle, GitHub publication, fresh-download, and final Published Status gate also passes.

1. Install with $setupName.
2. Uninstall with Windows Settings > Apps > Installed apps, or use $uninstallerName.
3. SHA256SUMS.txt covers every file in this folder except the checksum file itself.
4. Both executable files must show a valid Authenticode signature from this exact publisher:
   $ExpectedPublisher
   Certificate thumbprint: $($ExpectedPublisherThumbprint.Replace(' ', '').ToUpperInvariant())
5. This folder contains no workbook, database, export, screenshot, log, or user backup.

Source: https://github.com/15decesaremj/balance-book/tree/$sourceCommit
"@
[System.IO.File]::WriteAllText((Join-Path $outputPath 'README-FIRST.txt'), ($readme.Trim() + [Environment]::NewLine), $utf8)

$metadata = [ordered]@{
  format = 'balance-book-public-release'
  metadataVersion = 1
  product = 'Balance Book'
  version = $version
  platform = 'Windows 11 x64'
  sourceRepository = 'https://github.com/15decesaremj/balance-book'
  sourceCommit = $sourceCommit
  sourceTree = $sourceTree
  buildEvidence = [ordered]@{
    format = $buildMetadata.format
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $buildMetadataSource).Hash
    sourceCommit = $buildMetadata.gitCommit
    sourceTree = $buildMetadata.gitTree
  }
  lockfileSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repositoryRoot 'pnpm-lock.yaml')).Hash
  setup = [ordered]@{
    name = $setupName
    sha256 = $setupEvidence.Sha256
    signerSubject = $setupEvidence.Signature.SignerCertificate.Subject
    signerThumbprint = $setupEvidence.Signature.SignerCertificate.Thumbprint
  }
  uninstaller = [ordered]@{
    name = $uninstallerName
    sha256 = $uninstallerEvidence.Sha256
    signerSubject = $uninstallerEvidence.Signature.SignerCertificate.Subject
    signerThumbprint = $uninstallerEvidence.Signature.SignerCertificate.Thumbprint
  }
  packagedExecutable = [ordered]@{
    name = $packagedEvidence.File.Name
    sha256 = $packagedEvidence.Sha256
    signerSubject = $packagedEvidence.Signature.SignerCertificate.Subject
    signerThumbprint = $packagedEvidence.Signature.SignerCertificate.Thumbprint
  }
  squirrelPackage = [ordered]@{
    name = $packageFile.Name
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageFile.FullName).Hash
    releasesLine = $actualReleaseLine
  }
  artifactReady = $true
  assemblyStatus = 'validated-artifact-set'
  createdAtUtc = [DateTime]::UtcNow.ToString('o')
}
[System.IO.File]::WriteAllText(
  (Join-Path $outputPath 'RELEASE-METADATA.json'),
  (($metadata | ConvertTo-Json -Depth 7) + [Environment]::NewLine),
  $utf8
)

$hashFiles = @(Get-ChildItem -LiteralPath $outputPath -File | Sort-Object Name)
$hashLines = @($hashFiles | ForEach-Object {
  '{0} *{1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash, $_.Name
})
[System.IO.File]::WriteAllLines((Join-Path $outputPath 'SHA256SUMS.txt'), $hashLines, $utf8)

$finalNames = @(Get-ChildItem -LiteralPath $outputPath -File | Sort-Object Name | ForEach-Object { $_.Name })
$expectedNames = @(
  $setupName,
  $uninstallerName,
  'LICENSE.txt',
  'README-FIRST.txt',
  'RELEASE-METADATA.json',
  'SHA256SUMS.txt',
  'THIRD_PARTY_NOTICES.txt'
) | Sort-Object
if (($finalNames -join "`n") -ne ($expectedNames -join "`n")) {
  throw 'Public-release assembly produced an unexpected file set.'
}

[pscustomobject]@{
  OutputDirectory = $outputPath
  Version = $version
  SourceCommit = $sourceCommit
  SourceTree = $sourceTree
  Publisher = $ExpectedPublisher
  Files = $finalNames
  ArtifactReady = $true
  AssemblyStatus = 'Validated artifact set; final Published Status gates remain external'
}
