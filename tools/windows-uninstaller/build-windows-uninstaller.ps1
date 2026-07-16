[CmdletBinding()]
param(
  [string] $Version,
  [string] $OutputPath,
  [switch] $Sign
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rootPackagePath = Join-Path $repositoryRoot 'package.json'
if (-not $Version) {
  $Version = (Get-Content -Raw -LiteralPath $rootPackagePath | ConvertFrom-Json).version
}

$match = [regex]::Match($Version, '^(?<major>\d{1,5})\.(?<minor>\d{1,5})\.(?<patch>\d{1,5})$')
if (-not $match.Success) {
  throw "Uninstaller version must be a three-part numeric version; received '$Version'."
}
$versionParts = @(
  [int] $match.Groups['major'].Value,
  [int] $match.Groups['minor'].Value,
  [int] $match.Groups['patch'].Value,
  0
)
if ($versionParts | Where-Object { $_ -gt 65535 }) {
  throw 'Each Windows file-version component must be at most 65535.'
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $repositoryRoot 'out\release-tools\windows-uninstaller\Uninstall Balance Book.exe'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  throw 'Visual Studio Installer vswhere.exe was not found.'
}
$visualStudioPath = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $visualStudioPath) {
  throw 'A Visual Studio installation with the x64 C++ toolchain is required.'
}
$vsDevCmd = Join-Path $visualStudioPath 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
  throw "Visual Studio developer environment was not found at $vsDevCmd."
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $temporaryBase ('BalanceBookUninstallerBuild-' + [guid]::NewGuid().ToString('N')))
)
if (
  -not $temporaryDirectory.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not (Split-Path -Leaf $temporaryDirectory).StartsWith('BalanceBookUninstallerBuild-')
) {
  throw 'Refusing to use an unsafe uninstaller build directory.'
}

New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$objectPath = Join-Path $temporaryDirectory 'uninstall-balance-book.obj'
$resourcePath = Join-Path $temporaryDirectory 'uninstall-balance-book.res'
$unsignedPath = Join-Path $temporaryDirectory 'Uninstall Balance Book.exe'
$commandPath = Join-Path $temporaryDirectory 'build.cmd'
$sourcePath = Join-Path $PSScriptRoot 'uninstall-balance-book.cpp'
$resourceSourcePath = Join-Path $PSScriptRoot 'uninstall-balance-book.rc'

$commands = @(
  '@echo off',
  ('call "{0}" -no_logo -arch=x64 -host_arch=x64' -f $vsDevCmd),
  'if errorlevel 1 exit /b %errorlevel%',
  ('rc.exe /nologo /dAPP_VERSION_MAJOR={0} /dAPP_VERSION_MINOR={1} /dAPP_VERSION_PATCH={2} /dAPP_VERSION_BUILD=0 /fo "{3}" "{4}"' -f $versionParts[0], $versionParts[1], $versionParts[2], $resourcePath, $resourceSourcePath),
  'if errorlevel 1 exit /b %errorlevel%',
  ('cl.exe /nologo /std:c++17 /EHsc /O2 /GL /MT /GS /guard:cf /sdl /W4 /WX /DUNICODE /D_UNICODE /DNOMINMAX /Brepro /Fo"{0}" /c "{1}"' -f $objectPath, $sourcePath),
  'if errorlevel 1 exit /b %errorlevel%',
  ('link.exe /NOLOGO /OUT:"{0}" /MACHINE:X64 /SUBSYSTEM:WINDOWS,10.00 /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /GUARD:CF /CETCOMPAT /Brepro "{1}" "{2}" user32.lib shell32.lib ole32.lib' -f $unsignedPath, $objectPath, $resourcePath),
  'exit /b %errorlevel%'
)
[System.IO.File]::WriteAllLines($commandPath, $commands, [System.Text.Encoding]::ASCII)

try {
  Push-Location $repositoryRoot
  try {
    & $env:ComSpec /d /s /c "`"$commandPath`""
    if ($LASTEXITCODE -ne 0) {
      throw "Native uninstaller compilation failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $unsignedPath -PathType Leaf)) {
    throw 'Native uninstaller compilation did not produce an executable.'
  }
  Copy-Item -LiteralPath $unsignedPath -Destination $OutputPath -Force

  if ($Sign) {
    if (-not $env:WINDOWS_CERTIFICATE_FILE -or -not $env:WINDOWS_CERTIFICATE_PASSWORD) {
      throw 'Signing requires WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD.'
    }
    $windowsKitsBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signTool = Get-ChildItem -LiteralPath $windowsKitsBin -Directory -ErrorAction Stop |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if (-not $signTool) { throw 'The Windows SDK x64 signtool.exe was not found.' }
    & $signTool sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' /f $env:WINDOWS_CERTIFICATE_FILE /p $env:WINDOWS_CERTIFICATE_PASSWORD $OutputPath
    if ($LASTEXITCODE -ne 0) { throw "Uninstaller signing failed with exit code $LASTEXITCODE." }
  }

  $file = Get-Item -LiteralPath $OutputPath
  if ($file.VersionInfo.ProductVersion -ne "$Version.0") {
    throw "Compiled uninstaller has product version '$($file.VersionInfo.ProductVersion)', expected '$Version.0'."
  }

  $stream = [System.IO.File]::OpenRead($OutputPath)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset + 4
    $machine = $reader.ReadUInt16()
  }
  finally {
    $stream.Dispose()
  }
  if ($machine -ne 0x8664) {
    throw ('Compiled uninstaller is not x64; PE machine value was 0x{0:X4}.' -f $machine)
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $OutputPath
  [pscustomobject]@{
    Path = $OutputPath
    Version = $Version
    Architecture = 'x64'
    SizeBytes = $file.Length
    Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash
    SignatureStatus = [string] $signature.Status
  }
}
finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
