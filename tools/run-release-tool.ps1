param(
  [Parameter(Mandatory = $true)]
  [string]$Entry,

  [string]$NodePath,

  [string]$SecretFile,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ToolArguments
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$entryPath = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $Entry))
$toolsRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'tools')) + [System.IO.Path]::DirectorySeparatorChar

if (-not $entryPath.StartsWith($toolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Release-tool entry must be inside the repository tools directory.'
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "Release-tool entry was not found: $entryPath"
}

$node = if ($NodePath) {
  [System.IO.Path]::GetFullPath($NodePath)
} else {
  (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js was not found: $node" }
$outputName = ([System.IO.Path]::GetFileNameWithoutExtension($entryPath) + '.mjs')
$outputPath = Join-Path $repositoryRoot (Join-Path 'local-release-work\compiled-tools' $outputName)
$shim = Join-Path $repositoryRoot 'tools\vite-windows-realpath-shim.cjs'
$previousEntry = $env:BALANCE_BOOK_TOOL_ENTRY
$previousOutput = $env:BALANCE_BOOK_TOOL_OUTPUT
$previousNodeOptions = $env:NODE_OPTIONS
$previousBackupPassword = $env:BALANCE_BOOK_BACKUP_PASSWORD

try {
  if ($SecretFile) {
    $secretPath = [System.IO.Path]::GetFullPath($SecretFile)
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
      throw "Protected secret file was not found: $secretPath"
    }
    $securePassword = ConvertTo-SecureString (Get-Content -Raw -LiteralPath $secretPath)
    $credential = [System.Management.Automation.PSCredential]::new('BalanceBookBackup', $securePassword)
    $env:BALANCE_BOOK_BACKUP_PASSWORD = $credential.GetNetworkCredential().Password
  }
  $env:BALANCE_BOOK_TOOL_ENTRY = $entryPath
  $env:BALANCE_BOOK_TOOL_OUTPUT = $outputName
  $env:NODE_OPTIONS = "--require=$shim"
  & $node (Join-Path $repositoryRoot 'node_modules\vite\bin\vite.js') build --config (Join-Path $repositoryRoot 'vite.tooling.config.ts') --logLevel error
  if ($LASTEXITCODE -ne 0) { throw "Release-tool build failed with exit code $LASTEXITCODE." }
  & $node $outputPath @ToolArguments
  if ($LASTEXITCODE -ne 0) { throw "Release tool failed with exit code $LASTEXITCODE." }
}
finally {
  $env:BALANCE_BOOK_TOOL_ENTRY = $previousEntry
  $env:BALANCE_BOOK_TOOL_OUTPUT = $previousOutput
  $env:NODE_OPTIONS = $previousNodeOptions
  $env:BALANCE_BOOK_BACKUP_PASSWORD = $previousBackupPassword
}
