[CmdletBinding()]
param(
  [string] $Version,
  [string] $AppDirectory,
  [string] $OutputDirectory,
  [switch] $AllowUnsigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
$desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\package.json') | ConvertFrom-Json
if (-not $Version) { $Version = $rootPackage.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be a three-part numeric version; received '$Version'."
}
if ($rootPackage.version -ne $Version -or $desktopPackage.version -ne $Version) {
  throw "Root ($($rootPackage.version)) and desktop ($($desktopPackage.version)) versions must both equal $Version."
}
if ($rootPackage.name -ne 'balance-book-mvp') {
  throw "The stable Squirrel identity requires package name 'balance-book-mvp'."
}

if (-not $AppDirectory) { $AppDirectory = Join-Path $repositoryRoot 'out\Balance Book-win32-x64' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repositoryRoot 'out\make\squirrel.windows\x64' }
$AppDirectory = [System.IO.Path]::GetFullPath($AppDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $AppDirectory -PathType Container)) {
  throw "Packaged x64 application was not found: $AppDirectory"
}

$appExecutable = Join-Path $AppDirectory 'BalanceBook.exe'
$nativeDatabase = Join-Path $AppDirectory 'resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
foreach ($requiredFile in @($appExecutable, $nativeDatabase)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Packaged application is incomplete: $requiredFile"
  }
}
$appVersion = (Get-Item -LiteralPath $appExecutable).VersionInfo.ProductVersion
if ($appVersion -notmatch ('^' + [regex]::Escape($Version) + '(?:\.0)?$')) {
  throw "Packaged application product version '$appVersion' does not match $Version."
}

$vendorDirectory = Join-Path $repositoryRoot 'node_modules\electron-winstaller\vendor'
$resourceDirectory = Join-Path $repositoryRoot 'node_modules\electron-winstaller\resources'
$rcedit = Join-Path $vendorDirectory 'rcedit.exe'
$nuget = Join-Path $vendorDirectory 'nuget.exe'
$squirrel = Join-Path $vendorDirectory 'Squirrel.exe'
$icon = Join-Path $repositoryRoot 'assets\balance-book.ico'
$loadingGif = Join-Path $resourceDirectory 'install-spinner.gif'
foreach ($requiredTool in @($rcedit, $nuget, $squirrel, $icon, $loadingGif)) {
  if (-not (Test-Path -LiteralPath $requiredTool -PathType Leaf)) {
    throw "Offline Squirrel input was not found: $requiredTool"
  }
}

if ([bool] $env:WINDOWS_CERTIFICATE_FILE -xor [bool] $env:WINDOWS_CERTIFICATE_PASSWORD) {
  throw 'WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must either both be set or both be absent.'
}
if ($env:WINDOWS_CERTIFICATE_FILE -and -not (Test-Path -LiteralPath $env:WINDOWS_CERTIFICATE_FILE -PathType Leaf)) {
  throw 'WINDOWS_CERTIFICATE_FILE does not identify a readable certificate file.'
}
$signingConfigured = [bool] ($env:WINDOWS_CERTIFICATE_FILE -and $env:WINDOWS_CERTIFICATE_PASSWORD)
$signTool = $null
if ($signingConfigured) {
  $windowsKitsBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $signTool = Get-ChildItem -LiteralPath $windowsKitsBin -Directory -ErrorAction Stop |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $signTool) { throw 'The Windows SDK x64 signtool.exe was not found.' }
  & $signTool sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' /f $env:WINDOWS_CERTIFICATE_FILE /p $env:WINDOWS_CERTIFICATE_PASSWORD $appExecutable
  if ($LASTEXITCODE -ne 0) { throw "Packaged application signing failed with exit code $LASTEXITCODE." }
  $appSignature = Get-AuthenticodeSignature -LiteralPath $appExecutable
  if (
    $appSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    -not $appSignature.TimeStamperCertificate
  ) {
    throw 'The packaged application did not retain a valid timestamped Authenticode signature.'
  }
}

$stagingBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stagingRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $stagingBase ('BalanceBookSquirrel-' + [guid]::NewGuid().ToString('N')))
)
if (
  -not $stagingRoot.StartsWith($stagingBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not (Split-Path -Leaf $stagingRoot).StartsWith('BalanceBookSquirrel-')
) {
  throw 'Refusing to use an unsafe offline Squirrel staging directory.'
}

$stagedApp = Join-Path $stagingRoot 'app'
$nugetShadow = Join-Path $stagingRoot 'nuget-shadow'
$nugetOutput = Join-Path $stagingRoot 'nuget'
$releaseOutput = Join-Path $stagingRoot 'release'
$squirrelToolDirectory = Join-Path $stagingRoot 'squirrel-tool'
$nuspecPath = Join-Path $stagingRoot 'balance_book_mvp.nuspec'

function ConvertTo-XmlText([string] $Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

function ConvertTo-WindowsCommandLineArgument([AllowEmptyString()][string] $Argument) {
  if ($null -eq $Argument -or $Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }

  $quoted = [System.Text.StringBuilder]::new()
  [void] $quoted.Append('"')
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq [char] 92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char] 34) {
      [void] $quoted.Append([char] 92, (($backslashes * 2) + 1))
      [void] $quoted.Append([char] 34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void] $quoted.Append([char] 92, $backslashes)
      $backslashes = 0
    }
    [void] $quoted.Append($character)
  }
  if ($backslashes -gt 0) {
    [void] $quoted.Append([char] 92, ($backslashes * 2))
  }
  [void] $quoted.Append('"')
  return $quoted.ToString()
}

function Invoke-WaitedExecutable([string] $Path, [string[]] $Arguments) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Path
  $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')
  $startInfo.WorkingDirectory = Split-Path -Parent $Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start native release tool: $Path" }
    $process.WaitForExit()
    return $process.ExitCode
  }
  finally {
    $process.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Path $stagingRoot | Out-Null
  Copy-Item -LiteralPath $AppDirectory -Destination $stagedApp -Recurse
  New-Item -ItemType Directory -Path $nugetShadow, $nugetOutput, $releaseOutput, $squirrelToolDirectory | Out-Null
  Get-ChildItem -LiteralPath $vendorDirectory -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $squirrelToolDirectory -Recurse
  }
  $squirrelTool = Join-Path $squirrelToolDirectory 'Squirrel.exe'

  $stagedSquirrel = Join-Path $stagedApp 'Squirrel.exe'
  Copy-Item -LiteralPath $squirrel -Destination $stagedSquirrel
  & $rcedit $stagedSquirrel --set-icon $icon
  if ($LASTEXITCODE -ne 0) { throw "rcedit failed with exit code $LASTEXITCODE." }

  $authors = ConvertTo-XmlText ([string] $rootPackage.author)
  $description = ConvertTo-XmlText ([string] $rootPackage.description)
  $title = ConvertTo-XmlText ([string] $rootPackage.productName)
  $projectUrl = ConvertTo-XmlText ([string] $rootPackage.homepage)
  $copyright = ConvertTo-XmlText 'Copyright (c) 2026 Balance Book contributors'
  $nuspec = @"
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">
  <metadata>
    <id>balance_book_mvp</id>
    <title>$title</title>
    <version>$Version</version>
    <authors>$authors</authors>
    <owners>$authors</owners>
    <projectUrl>$projectUrl</projectUrl>
    <licenseUrl>https://opensource.org/license/mit</licenseUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <description>$description</description>
    <copyright>$copyright</copyright>
    <tags>finance cash-flow local-first desktop windows</tags>
  </metadata>
  <files>
    <file src="locales\**" target="lib\net45\locales" />
    <file src="resources\**" target="lib\net45\resources" />
    <file src="*.bin" target="lib\net45" />
    <file src="*.dll" target="lib\net45" />
    <file src="*.pak" target="lib\net45" />
    <file src="*.exe.config" target="lib\net45" />
    <file src="*.exe.sig" target="lib\net45" />
    <file src="icudtl.dat" target="lib\net45\icudtl.dat" />
    <file src="Squirrel.exe" target="lib\net45\Squirrel.exe" />
    <file src="LICENSE" target="lib\net45\LICENSE" />
    <file src="LICENSES.chromium.html" target="lib\net45\LICENSES.chromium.html" />
    <file src="version" target="lib\net45\version" />
    <file src="BalanceBook.exe" target="lib\net45\BalanceBook.exe" />
    <file src="vk_swiftshader_icd.json" target="lib\net45\vk_swiftshader_icd.json" />
  </files>
</package>
"@
  [System.IO.File]::WriteAllText($nuspecPath, $nuspec, [System.Text.UTF8Encoding]::new($false))

  # NuGet 2.x uses System.IO.Packaging isolated storage once a single payload
  # exceeds 10 MiB. That makes packaging brittle in locked-down build agents.
  # Let NuGet create and validate the exact package shape against a zero-byte
  # shadow tree, then stream the real bytes into a new archive without buffering
  # the Electron executable in isolated storage.
  $payloadFiles = @(Get-ChildItem -LiteralPath $stagedApp -File -Recurse | Sort-Object FullName)
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stagedApp -Force -Recurse |
      Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "The packaged application contains reparse points; first item: $($reparsePoints[0].FullName)"
  }
  foreach ($payloadFile in $payloadFiles) {
    $relativePath = $payloadFile.FullName.Substring($stagedApp.Length).TrimStart('\')
    $shadowPath = Join-Path $nugetShadow $relativePath
    $shadowParent = Split-Path -Parent $shadowPath
    if (-not (Test-Path -LiteralPath $shadowParent -PathType Container)) {
      New-Item -ItemType Directory -Path $shadowParent -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($shadowPath, [byte[]]::new(0))
  }

  & $nuget pack $nuspecPath `
    -BasePath $nugetShadow `
    -OutputDirectory $nugetOutput `
    -NoDefaultExcludes `
    -NoPackageAnalysis `
    -NonInteractive `
    -Verbosity normal
  if ($LASTEXITCODE -ne 0) { throw "NuGet pack failed with exit code $LASTEXITCODE." }
  $inputPackage = Join-Path $nugetOutput "balance_book_mvp.$Version.nupkg"
  if (-not (Test-Path -LiteralPath $inputPackage -PathType Leaf)) {
    throw "NuGet did not create the expected package: $inputPackage"
  }

  $expectedPayloadByEntry = @{}
  foreach ($payloadFile in $payloadFiles) {
    $relativePath = $payloadFile.FullName.Substring($stagedApp.Length).TrimStart('\').Replace('\', '/')
    $entryName = "lib/net45/$relativePath"
    if ($expectedPayloadByEntry.ContainsKey($entryName)) {
      throw "Duplicate NuGet payload path: $entryName"
    }
    $expectedPayloadByEntry[$entryName] = $payloadFile
  }

  $skeletonArchive = [System.IO.Compression.ZipFile]::OpenRead($inputPackage)
  try {
    $skeletonPayloadNames = @(
      $skeletonArchive.Entries |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Where-Object { $_.StartsWith('lib/net45/', [System.StringComparison]::OrdinalIgnoreCase) }
    )
    $missingPayloadNames = @($expectedPayloadByEntry.Keys | Where-Object { $_ -notin $skeletonPayloadNames })
    $unexpectedPayloadNames = @($skeletonPayloadNames | Where-Object { -not $expectedPayloadByEntry.ContainsKey($_) })
    if ($missingPayloadNames.Count -gt 0 -or $unexpectedPayloadNames.Count -gt 0) {
      throw "NuGet package shape mismatch. Missing: $($missingPayloadNames -join ', '); unexpected: $($unexpectedPayloadNames -join ', ')."
    }

    $hydratedPackage = "$inputPackage.hydrating"
    $hydratedStream = [System.IO.File]::Open(
      $hydratedPackage,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    try {
      $hydratedArchive = [System.IO.Compression.ZipArchive]::new(
        $hydratedStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $true
      )
      try {
        foreach ($metadataEntry in $skeletonArchive.Entries) {
          $normalizedEntryName = $metadataEntry.FullName.Replace('\', '/')
          if ($normalizedEntryName.StartsWith('lib/net45/', [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
          }
          $newMetadataEntry = $hydratedArchive.CreateEntry(
            $normalizedEntryName,
            [System.IO.Compression.CompressionLevel]::Optimal
          )
          $newMetadataEntry.LastWriteTime = $metadataEntry.LastWriteTime
          $metadataInput = $metadataEntry.Open()
          $metadataOutput = $newMetadataEntry.Open()
          try { $metadataInput.CopyTo($metadataOutput, 1MB) }
          finally {
            $metadataOutput.Dispose()
            $metadataInput.Dispose()
          }
        }

        foreach ($entryName in @($expectedPayloadByEntry.Keys | Sort-Object)) {
          $payloadFile = $expectedPayloadByEntry[$entryName]
          $payloadEntry = $hydratedArchive.CreateEntry(
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
          )
          $payloadEntry.LastWriteTime = [DateTimeOffset] $payloadFile.LastWriteTime
          $payloadInput = $payloadFile.OpenRead()
          $payloadOutput = $payloadEntry.Open()
          try { $payloadInput.CopyTo($payloadOutput, 1MB) }
          finally {
            $payloadOutput.Dispose()
            $payloadInput.Dispose()
          }
        }
      }
      finally {
        $hydratedArchive.Dispose()
      }
    }
    finally {
      $hydratedStream.Dispose()
    }
  }
  finally {
    $skeletonArchive.Dispose()
  }

  $hydratedPackage = "$inputPackage.hydrating"
  $validationArchive = [System.IO.Compression.ZipFile]::OpenRead($hydratedPackage)
  try {
    $validationPayload = @(
      $validationArchive.Entries |
        Where-Object { $_.FullName.StartsWith('lib/net45/', [System.StringComparison]::OrdinalIgnoreCase) }
    )
    if ($validationPayload.Count -ne $expectedPayloadByEntry.Count) {
      throw "Hydrated NuGet payload count $($validationPayload.Count) does not match $($expectedPayloadByEntry.Count)."
    }
    foreach ($payloadEntry in $validationPayload) {
      $entryName = $payloadEntry.FullName.Replace('\', '/')
      if (-not $expectedPayloadByEntry.ContainsKey($entryName)) {
        throw "Hydrated NuGet package contains an unexpected payload: $entryName"
      }
      $payloadFile = $expectedPayloadByEntry[$entryName]
      if ($payloadEntry.Length -ne $payloadFile.Length) {
        throw "Hydrated NuGet payload length does not match source: $entryName"
      }
      $payloadStream = $payloadEntry.Open()
      $sha256 = [System.Security.Cryptography.SHA256]::Create()
      try {
        $entryHash = [BitConverter]::ToString($sha256.ComputeHash($payloadStream)).Replace('-', '')
      }
      finally {
        $sha256.Dispose()
        $payloadStream.Dispose()
      }
      $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $payloadFile.FullName).Hash
      if ($entryHash -ne $sourceHash) {
        throw "Hydrated NuGet payload hash does not match source: $entryName"
      }
    }
  }
  finally {
    $validationArchive.Dispose()
  }
  Remove-Item -LiteralPath $inputPackage -Force
  Move-Item -LiteralPath $hydratedPackage -Destination $inputPackage

  $squirrelArguments = @(
    '--releasify', $inputPackage,
    '--releaseDir', $releaseOutput,
    '--loadingGif', $loadingGif,
    '--setupIcon', $icon,
    '--no-msi',
    '--no-delta'
  )
  $savedSquirrelTemp = $env:SQUIRREL_TEMP
  try {
    $env:SQUIRREL_TEMP = Join-Path $stagingRoot 'squirrel-temp'
    $squirrelExitCode = Invoke-WaitedExecutable -Path $squirrelTool -Arguments $squirrelArguments
  }
  finally {
    if ($null -eq $savedSquirrelTemp) {
      Remove-Item Env:SQUIRREL_TEMP -ErrorAction SilentlyContinue
    }
    else {
      $env:SQUIRREL_TEMP = $savedSquirrelTemp
    }
  }
  if ($squirrelExitCode -ne 0) { throw "Squirrel releasify failed with exit code $squirrelExitCode." }

  $unfixedSetup = Join-Path $releaseOutput 'Setup.exe'
  $setupName = "Balance Book-$Version Setup.exe"
  $setupPath = Join-Path $releaseOutput $setupName
  if (-not (Test-Path -LiteralPath $unfixedSetup -PathType Leaf)) {
    throw 'Squirrel did not create Setup.exe.'
  }
  Move-Item -LiteralPath $unfixedSetup -Destination $setupPath
  if ($signingConfigured) {
    & $signTool sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' /f $env:WINDOWS_CERTIFICATE_FILE /p $env:WINDOWS_CERTIFICATE_PASSWORD $setupPath
    if ($LASTEXITCODE -ne 0) { throw "Setup signing failed with exit code $LASTEXITCODE." }
  }

  $fullPackageName = "balance_book_mvp-$Version-full.nupkg"
  $fullPackagePath = Join-Path $releaseOutput $fullPackageName
  $releasesPath = Join-Path $releaseOutput 'RELEASES'
  foreach ($artifact in @($setupPath, $fullPackagePath, $releasesPath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "Squirrel did not create the expected artifact: $artifact"
    }
  }
  $releaseLine = [string] (Get-Content -LiteralPath $releasesPath | Where-Object { $_.Trim() } | Select-Object -First 1)
  $fullPackage = Get-Item -LiteralPath $fullPackagePath
  $expectedReleaseLine = '{0} {1} {2}' -f (Get-FileHash -Algorithm SHA1 -LiteralPath $fullPackagePath).Hash, $fullPackageName, $fullPackage.Length
  if ($releaseLine -ne $expectedReleaseLine) {
    throw 'Offline Squirrel RELEASES does not match the full package hash, name, and length.'
  }

  $setupVersion = (Get-Item -LiteralPath $setupPath).VersionInfo.ProductVersion
  if ($setupVersion -notmatch ('^' + [regex]::Escape($Version) + '(?:\.0)?$')) {
    throw "Squirrel Setup product version '$setupVersion' does not match $Version."
  }
  $setupSignature = Get-AuthenticodeSignature -LiteralPath $setupPath
  if (-not $AllowUnsigned -and $setupSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Offline Squirrel Setup requires a valid Authenticode signature; received $($setupSignature.Status)."
  }
  if (-not $AllowUnsigned -and -not $setupSignature.TimeStamperCertificate) {
    throw 'Offline Squirrel Setup requires a trusted timestamp signature.'
  }

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  foreach ($artifact in @($setupPath, $fullPackagePath, $releasesPath)) {
    Copy-Item -LiteralPath $artifact -Destination (Join-Path $OutputDirectory (Split-Path -Leaf $artifact)) -Force
  }

  [pscustomobject]@{
    BuildMode = 'offline-direct-squirrel'
    Version = $Version
    InstallerIdentity = 'balance_book_mvp'
    Architecture = 'x64'
    AppDirectory = $AppDirectory
    OutputDirectory = $OutputDirectory
    SetupPath = Join-Path $OutputDirectory $setupName
    PackagePath = Join-Path $OutputDirectory $fullPackageName
    ReleasesPath = Join-Path $OutputDirectory 'RELEASES'
    SetupSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $setupPath).Hash
    PackageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPackagePath).Hash
    SignatureStatus = [string] $setupSignature.Status
    SigningConfigured = $signingConfigured
  }
}
finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
