param(
  [string] $IdentityPath = 'store\identity.json',
  [ValidateSet('Store', 'LocalTest')]
  [string] $Configuration = 'Store',
  [switch] $AllowDirty,
  [switch] $SkipPackageBuild,
  [switch] $RunWack
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot

function Resolve-RepositoryPath {
  param([Parameter(Mandatory = $true)][string] $Path)
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $Path))
}

function Assert-Matches {
  param(
    [Parameter(Mandatory = $true)][string] $Value,
    [Parameter(Mandatory = $true)][string] $Pattern,
    [Parameter(Mandatory = $true)][string] $Label
  )
  if ($Value -notmatch $Pattern) {
    throw "$Label is not valid."
  }
}

function Xml-Escape {
  param([Parameter(Mandatory = $true)][string] $Value)
  return [System.Security.SecurityElement]::Escape($Value)
}

$IdentityPath = Resolve-RepositoryPath $IdentityPath
if (-not (Test-Path -LiteralPath $IdentityPath -PathType Leaf)) {
  throw "Store identity file not found: $IdentityPath"
}
$identity = Get-Content -Raw -LiteralPath $IdentityPath | ConvertFrom-Json
$requiredFields = @(
  'packageName',
  'publisher',
  'publisherDisplayName',
  'applicationId',
  'displayName',
  'description'
)
foreach ($field in $requiredFields) {
  $value = [string] $identity.$field
  if ([string]::IsNullOrWhiteSpace($value) -or $value -like 'REQUIRED_*') {
    throw "Store identity field '$field' must come from the selected configuration."
  }
}
Assert-Matches ([string] $identity.packageName) '^[A-Za-z0-9.-]{3,50}$' 'Package name'
Assert-Matches ([string] $identity.applicationId) '^[A-Za-z][A-Za-z0-9.]{0,63}$' 'Application ID'
Assert-Matches ([string] $identity.publisher) '^(?:CN|O|OU|L|S|C|E|DC|OID\.[0-9.]+)=' 'Publisher'
if ($Configuration -eq 'Store') {
  $productId = [string] $identity.productId
  if ($productId -notmatch '^[A-Z0-9]{12}$') {
    throw 'The production Store product ID must be copied exactly from Partner Center.'
  }
}

$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') |
  ConvertFrom-Json
$desktopPackage = Get-Content -Raw -LiteralPath (
  Join-Path $repositoryRoot 'apps\desktop\package.json'
) | ConvertFrom-Json
$semanticVersion = [string] $rootPackage.version
if ($desktopPackage.version -ne $semanticVersion) {
  throw 'The root and desktop package versions do not match.'
}
if ($semanticVersion -notmatch '^([1-9][0-9]{0,4})\.([0-9]{1,5})\.([0-9]{1,5})$') {
  throw 'The application version must be a three-part SemVer that maps to an MSIX DotQuad.'
}
$versionParts = @([int] $Matches[1], [int] $Matches[2], [int] $Matches[3])
if (($versionParts | Where-Object { $_ -gt 65535 }).Count -gt 0) {
  throw 'Every semantic version component must fit the MSIX 0-65535 range.'
}
$msixVersion = "$($versionParts[0]).$($versionParts[1]).$($versionParts[2]).0"

$status = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the Git working tree.' }
if ($status.Count -gt 0 -and -not $AllowDirty) {
  throw 'Store packages require a clean working tree. Use -AllowDirty only for isolated local tests.'
}
$sourceCommit = (git rev-parse HEAD).Trim()
$sourceTree = (git write-tree).Trim()

$outputRoot = Join-Path $repositoryRoot "out\store\$semanticVersion\$Configuration"
$stagingRoot = Join-Path $outputRoot 'staging'
$packagePath = Join-Path $outputRoot "BalanceBook_$($msixVersion)_x64.msix"
$uploadPath = Join-Path $outputRoot "BalanceBook_$($msixVersion)_x64.msixupload"
$metadataPath = Join-Path $outputRoot 'STORE-PACKAGE-METADATA.json'
if (Test-Path -LiteralPath $outputRoot) {
  Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
[System.IO.Directory]::CreateDirectory($stagingRoot) | Out-Null

$previousBuildChannel = $env:BALANCE_BOOK_BUILD_CHANNEL
$previousStoreDirectory = $env:BALANCE_BOOK_STORE_DATA_DIRECTORY
$previousLegacyDirectory = $env:BALANCE_BOOK_LEGACY_DATA_DIRECTORY
$previousProductId = $env:BALANCE_BOOK_STORE_PRODUCT_ID
$previousUpdatesEnabled = $env:BALANCE_BOOK_UPDATES_ENABLED
try {
  $env:BALANCE_BOOK_BUILD_CHANNEL = 'store'
  $env:BALANCE_BOOK_UPDATES_ENABLED = '0'
  if ($Configuration -eq 'LocalTest') {
    $env:BALANCE_BOOK_STORE_DATA_DIRECTORY = 'Balance Book Store Test'
    $env:BALANCE_BOOK_LEGACY_DATA_DIRECTORY = 'Balance Book Store Test Legacy'
    $env:BALANCE_BOOK_STORE_PRODUCT_ID = ''
  } else {
    $env:BALANCE_BOOK_STORE_DATA_DIRECTORY = 'Balance Book Store'
    $env:BALANCE_BOOK_LEGACY_DATA_DIRECTORY = 'Balance Book'
    $env:BALANCE_BOOK_STORE_PRODUCT_ID = [string] $identity.productId
  }
  if (-not $SkipPackageBuild) {
    & pnpm build:icon
    if ($LASTEXITCODE -ne 0) { throw 'Application icon generation failed.' }
    & pnpm exec electron-forge package --arch=x64
    if ($LASTEXITCODE -ne 0) { throw 'Electron production packaging failed.' }
  }
} finally {
  $env:BALANCE_BOOK_BUILD_CHANNEL = $previousBuildChannel
  $env:BALANCE_BOOK_STORE_DATA_DIRECTORY = $previousStoreDirectory
  $env:BALANCE_BOOK_LEGACY_DATA_DIRECTORY = $previousLegacyDirectory
  $env:BALANCE_BOOK_STORE_PRODUCT_ID = $previousProductId
  $env:BALANCE_BOOK_UPDATES_ENABLED = $previousUpdatesEnabled
}

$packagedApplication = Join-Path $repositoryRoot 'out\Balance Book-win32-x64'
if (-not (Test-Path -LiteralPath (Join-Path $packagedApplication 'BalanceBook.exe'))) {
  throw "The packaged Electron application was not found at $packagedApplication."
}
Copy-Item -LiteralPath $packagedApplication -Destination (Join-Path $stagingRoot 'app') -Recurse

$assetsDirectory = Join-Path $stagingRoot 'Assets'
& (Join-Path $PSScriptRoot 'build-store-assets.ps1') -OutputDirectory $assetsDirectory
if ($LASTEXITCODE -ne 0) { throw 'Store artwork generation failed.' }

$template = Get-Content -Raw -LiteralPath (
  Join-Path $repositoryRoot 'store\Package.appxmanifest.template.xml'
)
$replacements = [ordered] @{
  '{{PACKAGE_NAME}}' = Xml-Escape ([string] $identity.packageName)
  '{{PUBLISHER}}' = Xml-Escape ([string] $identity.publisher)
  '{{MSIX_VERSION}}' = $msixVersion
  '{{DISPLAY_NAME}}' = Xml-Escape ([string] $identity.displayName)
  '{{PUBLISHER_DISPLAY_NAME}}' = Xml-Escape ([string] $identity.publisherDisplayName)
  '{{DESCRIPTION}}' = Xml-Escape ([string] $identity.description)
  '{{APPLICATION_ID}}' = Xml-Escape ([string] $identity.applicationId)
}
foreach ($replacement in $replacements.GetEnumerator()) {
  $template = $template.Replace($replacement.Key, $replacement.Value)
}
if ($template -match '\{\{[A-Z0-9_]+\}\}') {
  throw 'The Store manifest still contains an unresolved token.'
}
$manifestPath = Join-Path $stagingRoot 'AppxManifest.xml'
[System.IO.File]::WriteAllText(
  $manifestPath,
  $template,
  [System.Text.UTF8Encoding]::new($false)
)

$makeAppx = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64\makeappx.exe'
$signTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe'
if (-not (Test-Path -LiteralPath $makeAppx)) { throw 'Windows SDK MakeAppx.exe is unavailable.' }
& $makeAppx pack /d $stagingRoot /p $packagePath /o
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx failed to create the MSIX package.' }

$testCertificateThumbprint = $null
if ($Configuration -eq 'LocalTest') {
  $certificate = $null
  try {
    $certificate = New-SelfSignedCertificate `
      -Type Custom `
      -Subject ([string] $identity.publisher) `
      -FriendlyName 'Balance Book local MSIX test only' `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -KeyUsage DigitalSignature `
      -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
    $testCertificateThumbprint = $certificate.Thumbprint
    $certificatePath = Join-Path $outputRoot 'LOCAL-TEST-CERTIFICATE.cer'
    Export-Certificate -Cert $certificate -FilePath $certificatePath | Out-Null
    & $signTool sign /fd SHA256 /sha1 $testCertificateThumbprint $packagePath
    if ($LASTEXITCODE -ne 0) { throw 'Local test signing failed.' }
    $signature = Get-AuthenticodeSignature -FilePath $packagePath
    if (
      -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Thumbprint -ne $testCertificateThumbprint -or
      $signature.Status -in @('NotSigned', 'HashMismatch')
    ) {
      throw 'The local test MSIX signature does not match its generated certificate.'
    }
  } finally {
    if ($certificate) {
      Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force
    }
  }
}

$temporaryZip = "$uploadPath.zip"
Compress-Archive -LiteralPath $packagePath -DestinationPath $temporaryZip -CompressionLevel Optimal
Move-Item -LiteralPath $temporaryZip -Destination $uploadPath

$validationRoot = Join-Path $outputRoot 'validated-unpack'
& $makeAppx unpack /p $packagePath /d $validationRoot /o
if ($LASTEXITCODE -ne 0) { throw 'The completed MSIX could not be unpacked for validation.' }
$validatedManifest = [xml] (Get-Content -Raw -LiteralPath (
  Join-Path $validationRoot 'AppxManifest.xml'
))
if ($validatedManifest.Package.Identity.Version -ne $msixVersion) {
  throw 'The validated MSIX version does not match the source version.'
}
if (-not (Test-Path -LiteralPath (Join-Path $validationRoot 'app\BalanceBook.exe'))) {
  throw 'The validated MSIX does not contain the Balance Book executable.'
}

if ($RunWack) {
  $appCert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
  $reportPath = Join-Path $outputRoot 'WACK-REPORT.xml'
  & $appCert reset
  if ($LASTEXITCODE -ne 0) { throw 'Windows App Certification Kit reset failed.' }
  & $appCert test -appxpackagepath $packagePath -reportoutputpath $reportPath
  if ($LASTEXITCODE -ne 0) { throw 'Windows App Certification Kit validation failed.' }
}

$metadata = [ordered] @{
  format = 'balance-book-store-package'
  formatVersion = 1
  configuration = $Configuration
  semanticVersion = $semanticVersion
  msixVersion = $msixVersion
  architecture = 'x64'
  packageName = [string] $identity.packageName
  publisher = [string] $identity.publisher
  publisherDisplayName = [string] $identity.publisherDisplayName
  applicationId = [string] $identity.applicationId
  productId = if ($Configuration -eq 'Store') { [string] $identity.productId } else { $null }
  sourceCommit = $sourceCommit
  sourceTree = $sourceTree
  workingTreeDirty = $status.Count -gt 0
  lockfileSha256 = (Get-FileHash (Join-Path $repositoryRoot 'pnpm-lock.yaml') -Algorithm SHA256).Hash
  packageFile = [System.IO.Path]::GetFileName($packagePath)
  packageSha256 = (Get-FileHash $packagePath -Algorithm SHA256).Hash
  uploadFile = [System.IO.Path]::GetFileName($uploadPath)
  uploadSha256 = (Get-FileHash $uploadPath -Algorithm SHA256).Hash
  storeManagedUpdates = $true
  githubUpdaterEnabled = $false
  locallySignedForTesting = $Configuration -eq 'LocalTest'
  localTestCertificateThumbprint = $testCertificateThumbprint
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
}
[System.IO.File]::WriteAllText(
  $metadataPath,
  (($metadata | ConvertTo-Json -Depth 6) + "`n"),
  [System.Text.UTF8Encoding]::new($false)
)
$metadata | ConvertTo-Json -Depth 6
