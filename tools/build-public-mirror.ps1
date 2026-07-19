[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Destination,
  [string] $PublicRepository = 'https://github.com/15decesaremj/balance-book.git',
  [string] $CommitMessage = 'release: publish Balance Book 1.1.1 source',
  [string] $ExpectedSourceBranch = 'master',
  [switch] $AllowUnpushedLocalCandidate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$archivePath = [System.IO.Path]::GetFullPath(
  (Join-Path ([System.IO.Path]::GetTempPath()) ('BalanceBookPublicMirror-' + [guid]::NewGuid().ToString('N') + '.zip'))
)

if (
  $destinationPath -eq $repositoryRoot -or
  $repositoryRoot.StartsWith(($destinationPath.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
  $destinationPath.StartsWith(($repositoryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'The public-mirror destination cannot be the source repository, one of its parents, or one of its children.'
}
if (Test-Path -LiteralPath $destinationPath) {
  throw "Refusing to overwrite an existing public-mirror destination: $destinationPath"
}

$status = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the private development repository.' }
if ($status.Count -gt 0) { throw 'The private development repository must be clean before creating a public mirror.' }

$sourceBranch = (& git -C $repositoryRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceBranch -ne $ExpectedSourceBranch) {
  throw "Expected reviewed private source branch '$ExpectedSourceBranch'; found '$sourceBranch'."
}

$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$sourceTree = (& git -C $repositoryRoot rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the source commit and tree.' }

$upstreamResult = @(& git -C $repositoryRoot rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
$hasUpstream = $LASTEXITCODE -eq 0 -and $upstreamResult.Count -eq 1
$cachedUpstreamParity = $false
if ($hasUpstream) {
  $upstreamCommit = (& git -C $repositoryRoot rev-parse $upstreamResult[0]).Trim()
  $cachedUpstreamParity = $LASTEXITCODE -eq 0 -and $upstreamCommit -eq $sourceCommit
}
if (-not $cachedUpstreamParity -and -not $AllowUnpushedLocalCandidate) {
  throw 'The private source branch does not equal its cached upstream. Fetch, reconcile, and push it before creating a publishable mirror.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required to run the protected source-tree privacy check.' }
$protectedPatternPath = Join-Path $repositoryRoot '.privacy-patterns.local'
$protectedPatternCount = if (Test-Path -LiteralPath $protectedPatternPath -PathType Leaf) {
  @(Get-Content -LiteralPath $protectedPatternPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }).Count
}
else { 0 }
if ($protectedPatternCount -eq 0) {
  throw 'A present, nonempty .privacy-patterns.local review list is required before public mirror creation.'
}
Push-Location $repositoryRoot
try {
  & $node.Source (Join-Path $repositoryRoot 'tools\privacy-check\index.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'The private source tree failed its protected local-pattern privacy check.' }
}
finally {
  Pop-Location
}

try {
  & git -C $repositoryRoot archive --format=zip --output=$archivePath HEAD
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'Could not export the exact tracked source tree.'
  }

  New-Item -ItemType Directory -Path $destinationPath | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $destinationPath

  $prohibited = @(
    Get-ChildItem -LiteralPath $destinationPath -Recurse -File -Force |
      Where-Object {
        $relative = $_.FullName.Substring($destinationPath.TrimEnd('\').Length).TrimStart('\').Replace('\', '/')
        $relative -match '(^|/)(\.git|local-releases|local-release-work|private|out|\.vite|test-results|node_modules)(/|$)' -or
        $relative -match '\.(xlsx?|xlsm|sqlite3?|db|balancebook-backup|backup|pfx|p12|pem|key|exe|msi|msix|nupkg|zip|7z|asar|pak|dll|node)$'
      }
  )
  if ($prohibited.Count -gt 0) {
    throw "The exported tree contains prohibited paths: $($prohibited.FullName -join ', ')"
  }

  & git -C $destinationPath init -b main
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the clean-history public mirror.' }
  & git -C $destinationPath add --all
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage the public mirror.' }
  & git -C $destinationPath -c user.name='Balance Book contributors' -c user.email='noreply' commit -m $CommitMessage
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the public mirror root commit.' }
  & git -C $destinationPath remote add origin $PublicRepository
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure the public mirror remote.' }

  $mirrorTree = (& git -C $destinationPath rev-parse 'HEAD^{tree}').Trim()
  $commitCount = [int] ((& git -C $destinationPath rev-list --count HEAD).Trim())
  $branches = @(& git -C $destinationPath branch --format='%(refname:short)')
  $tags = @(& git -C $destinationPath tag --list)
  $mirrorStatus = @(& git -C $destinationPath status --porcelain=v1 --untracked-files=all)
  if ($mirrorTree -ne $sourceTree) { throw 'The public mirror tree does not exactly match the reviewed source tree.' }
  if ($commitCount -ne 1) { throw "Expected one public root commit; found $commitCount." }
  if ($branches.Count -ne 1 -or $branches[0] -ne 'main') { throw 'The public mirror must contain only the main branch.' }
  if ($tags.Count -ne 0) { throw 'The new public mirror must not inherit private development tags.' }
  if ($mirrorStatus.Count -ne 0) { throw 'The new public mirror worktree is not clean.' }

  Push-Location $destinationPath
  try {
    & $node.Source (Join-Path $destinationPath 'tools\privacy-check\index.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The public mirror privacy check failed.' }
    & $node.Source (Join-Path $destinationPath 'tools\privacy-check\index.mjs') --history --pattern-file $protectedPatternPath
    if ($LASTEXITCODE -ne 0) { throw 'The complete public mirror history failed protected privacy review.' }
  }
  finally {
    Pop-Location
  }

  [pscustomobject]@{
    Destination = $destinationPath
    PrivateSourceCommit = $sourceCommit
    SourceTree = $sourceTree
    PublicRootCommit = (& git -C $destinationPath rev-parse HEAD).Trim()
    PublicRepository = $PublicRepository
    Branch = 'main'
    PrivateSourceBranch = $sourceBranch
    CachedPrivateUpstreamParity = $cachedUpstreamParity
    LiveRemoteParityVerified = $false
    LocalCandidateOnly = -not $cachedUpstreamParity
    CommitCount = $commitCount
    Tags = $tags.Count
    Clean = $true
  }
}
finally {
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}
