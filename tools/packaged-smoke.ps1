$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$executable = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot 'out\Balance Book-win32-x64\BalanceBook.exe')
)
$profiles = [System.IO.Path]::GetFullPath(
  (Join-Path $repositoryRoot 'tests\fixtures\bootstrap-profiles.json')
)
$temporaryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path ([System.IO.Path]::GetTempPath()) ('BalanceBookPackagedSmoke-' + [guid]::NewGuid().ToString('N')))
)
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Packaged executable not found: $executable"
}
if (-not (Test-Path -LiteralPath $profiles -PathType Leaf)) {
  throw "Synthetic profile fixture not found: $profiles"
}
if (
  -not $temporaryRoot.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not (Split-Path -Leaf $temporaryRoot).StartsWith('BalanceBookPackagedSmoke-')
) {
  throw 'Refusing to use an unsafe packaged-smoke temporary path.'
}

$previousDataDirectory = $env:BALANCE_BOOK_DATA_DIR
$previousProfiles = $env:BALANCE_BOOK_BOOTSTRAP_PROFILES
$process = $null
$preexistingProcessIds = @(
  Get-Process -Name 'BalanceBook' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $executable } |
    ForEach-Object { $_.Id }
)

try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  $env:BALANCE_BOOK_DATA_DIR = $temporaryRoot
  $env:BALANCE_BOOK_BOOTSTRAP_PROFILES = $profiles
  $process = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)

  do {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    $database = Get-ChildItem -LiteralPath $temporaryRoot -Filter '*.sqlite' -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
  } while (-not $process.HasExited -and -not $database -and (Get-Date) -lt $deadline)

  Start-Sleep -Seconds 2
  $process.Refresh()
  $database = Get-ChildItem -LiteralPath $temporaryRoot -Filter '*.sqlite' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($process.HasExited) {
    throw "Packaged application exited early with code $($process.ExitCode)."
  }
  if (-not $database) {
    throw 'Packaged application did not initialize its SQLite database.'
  }

  Write-Output 'Packaged application smoke test passed.'
}
finally {
  if ($process) {
    # Electron can leave renderer or utility children holding the SQLite WAL after its browser
    # process exits. Stop only processes from this exact package path that were absent at launch.
    $startedProcesses = @(
      Get-Process -Name 'BalanceBook' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $executable -and $_.Id -notin $preexistingProcessIds }
    )
    if ($startedProcesses.Count -gt 0) {
      $startedProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
      $deadline = (Get-Date).AddSeconds(5)
      do {
        Start-Sleep -Milliseconds 100
        $remaining = @(
          Get-Process -Name 'BalanceBook' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $executable -and $_.Id -notin $preexistingProcessIds }
        )
      } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    }
  }
  Start-Sleep -Seconds 2
  $env:BALANCE_BOOK_DATA_DIR = $previousDataDirectory
  $env:BALANCE_BOOK_BOOTSTRAP_PROFILES = $previousProfiles

  for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $temporaryRoot); $attempt++) {
    try {
      Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
    catch {
      if ($attempt -eq 9) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}
