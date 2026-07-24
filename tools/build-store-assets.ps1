param(
  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$previousPngOutput = $env:BALANCE_BOOK_ICON_PNG_OUTPUT
try {
  $env:BALANCE_BOOK_ICON_PNG_OUTPUT = $OutputDirectory
  & node (Join-Path $repositoryRoot 'tools\build-icon.mjs')
  if ($LASTEXITCODE -ne 0) {
    throw 'Canonical icon rendering failed.'
  }
} finally {
  $env:BALANCE_BOOK_ICON_PNG_OUTPUT = $previousPngOutput
}

function Write-SquareLogo {
  param(
    [Parameter(Mandatory = $true)]
    [System.Drawing.Image] $Source,
    [Parameter(Mandatory = $true)]
    [int] $Size,
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  try {
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($Source, 0, 0, $Size, $Size)
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save(
      (Join-Path $OutputDirectory $Name),
      [System.Drawing.Imaging.ImageFormat]::Png
    )
  } finally {
    $bitmap.Dispose()
  }
}

function Write-WideLogo {
  param(
    [Parameter(Mandatory = $true)]
    [System.Drawing.Image] $Source
  )

  $bitmap = [System.Drawing.Bitmap]::new(310, 150)
  try {
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($Source, 95, 15, 120, 120)
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save(
      (Join-Path $OutputDirectory 'Wide310x150Logo.png'),
      [System.Drawing.Imaging.ImageFormat]::Png
    )
  } finally {
    $bitmap.Dispose()
  }
}

$sourcePath = Join-Path $OutputDirectory 'balance-book-256.png'
$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  Write-SquareLogo -Source $source -Size 44 -Name 'Square44x44Logo.png'
  Write-SquareLogo -Source $source -Size 50 -Name 'StoreLogo.png'
  Write-SquareLogo -Source $source -Size 150 -Name 'Square150x150Logo.png'
  Write-WideLogo -Source $source
} finally {
  $source.Dispose()
}
Get-ChildItem -LiteralPath $OutputDirectory -Filter 'balance-book-*.png' | Remove-Item -Force
