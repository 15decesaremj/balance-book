[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Destination,
  [string] $PublicRepository = 'https://github.com/15decesaremj/balance-book.git',
  [string] $PrivateRepository = 'https://github.com/15decesaremj/balance-book-mvp.git',
  [string] $ExpectedSourceBranch = 'master',
  [string] $ExpectedPublicBranch = 'main',
  [string] $CommitMessage,
  [switch] $AllowUnpushedLocalCandidate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'publication-helpers.ps1')

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$token = [guid]::NewGuid().ToString('N')
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "BalanceBookPublicSync-$token.zip"))
$stagingPath = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "BalanceBookPublicSync-$token"))

if (
  $destinationPath -eq $repositoryRoot -or
  $repositoryRoot.StartsWith(($destinationPath.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
  $destinationPath.StartsWith(($repositoryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw 'The public mirror cannot be the private source repository, one of its parents, or one of its children.'
}
if (-not (Test-Path -LiteralPath (Join-Path $destinationPath '.git') -PathType Container)) {
  throw "Destination is not an existing public-mirror Git repository: $destinationPath"
}
if (
  -not $stagingPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
  -not (Split-Path -Leaf $stagingPath).StartsWith('BalanceBookPublicSync-')
) {
  throw 'Refusing to use an unsafe public-sync staging path.'
}

function Get-GitOutput([string] $Repository, [string[]] $Arguments) {
  $output = @(& git -C $Repository @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "Git command failed in ${Repository}: git $($Arguments -join ' ')" }
  $output
}

foreach ($repository in @(
  @{ Path = $repositoryRoot; Branch = $ExpectedSourceBranch; Label = 'private source' },
  @{ Path = $destinationPath; Branch = $ExpectedPublicBranch; Label = 'public mirror' }
)) {
  $status = @(Get-GitOutput $repository.Path @('status', '--porcelain=v1', '--untracked-files=all'))
  if ($status.Count -gt 0) { throw "The $($repository.Label) worktree must be clean." }
  $branch = (Get-GitOutput $repository.Path @('branch', '--show-current') | Select-Object -First 1).Trim()
  if ($branch -ne $repository.Branch) {
    throw "Expected $($repository.Label) branch '$($repository.Branch)'; found '$branch'."
  }
}

$origin = (Get-GitOutput $destinationPath @('remote', 'get-url', 'origin') | Select-Object -First 1).Trim()
if ($origin.TrimEnd('/').Replace('.git', '') -ne $PublicRepository.TrimEnd('/').Replace('.git', '')) {
  throw "Public mirror origin '$origin' does not equal '$PublicRepository'."
}
$privateOrigin = (Get-GitOutput $repositoryRoot @('remote', 'get-url', 'origin') | Select-Object -First 1).Trim()
if ($privateOrigin.TrimEnd('/').Replace('.git', '') -ne $PrivateRepository.TrimEnd('/').Replace('.git', '')) {
  throw "Private source origin does not equal the expected private repository."
}

$sourceCommit = (Get-GitOutput $repositoryRoot @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
$sourceTree = (Get-GitOutput $repositoryRoot @('rev-parse', 'HEAD^{tree}') | Select-Object -First 1).Trim()
$privateUpstreamRef = @(Get-GitOutput $repositoryRoot @('for-each-ref', '--format=%(upstream)', "refs/heads/$ExpectedSourceBranch"))
$cachedPrivateUpstream = @()
if ($privateUpstreamRef.Count -eq 1 -and $privateUpstreamRef[0].Trim()) {
  $cachedPrivateUpstream = @(Get-GitOutput $repositoryRoot @('rev-parse', $privateUpstreamRef[0].Trim()))
}
$privateCachedParity = $cachedPrivateUpstream.Count -eq 1 -and $cachedPrivateUpstream[0].Trim() -eq $sourceCommit
$publicHead = (Get-GitOutput $destinationPath @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
$publicUpstreamRef = @(Get-GitOutput $destinationPath @('for-each-ref', '--format=%(upstream)', "refs/heads/$ExpectedPublicBranch"))
$cachedPublicUpstream = @()
if ($publicUpstreamRef.Count -eq 1 -and $publicUpstreamRef[0].Trim()) {
  $cachedPublicUpstream = @(Get-GitOutput $destinationPath @('rev-parse', $publicUpstreamRef[0].Trim()))
}
$publicCachedParity = $cachedPublicUpstream.Count -eq 1 -and $cachedPublicUpstream[0].Trim() -eq $publicHead
if ((-not $privateCachedParity -or -not $publicCachedParity) -and -not $AllowUnpushedLocalCandidate) {
  throw 'Private source and public mirror must each equal their cached upstream. Fetch, reconcile, and push before a publishable sync.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required for public-mirror privacy checks.' }
$protectedPatternPath = Join-Path $repositoryRoot '.privacy-patterns.local'
$protectedPatternCount = if (Test-Path -LiteralPath $protectedPatternPath -PathType Leaf) {
  @(Get-Content -LiteralPath $protectedPatternPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }).Count
}
else { 0 }
if ($protectedPatternCount -eq 0) {
  throw 'A present, nonempty .privacy-patterns.local review list is required before public mirror synchronization.'
}
Push-Location $repositoryRoot
try {
  & $node.Source (Join-Path $repositoryRoot 'tools\privacy-check\index.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'The private source tree failed its protected local-pattern privacy check.' }
}
finally {
  Pop-Location
}

$liveRemoteParityVerified = $false
if (-not $AllowUnpushedLocalCandidate) {
  $gitCommand = Get-Command git -ErrorAction SilentlyContinue
  if (-not $gitCommand) { throw 'Git is required for live remote-history verification.' }
  $remoteAudit = Invoke-PublicRemoteHistoryAudit `
    -RepositoryUrl $PublicRepository `
    -PrivateRepositoryUrl $PrivateRepository `
    -ExpectedBranch $ExpectedPublicBranch `
    -PrivateRepositoryPath $repositoryRoot `
    -PrivacyScriptPath (Join-Path $repositoryRoot 'tools\privacy-check\index.mjs') `
    -ProtectedPatternPath $protectedPatternPath `
    -GitExecutable $gitCommand.Source `
    -NodeExecutable $node.Source
  if ($remoteAudit.MainCommit -cne $publicHead) {
    throw 'The live public main branch does not equal the local public mirror head.'
  }
  $privateRemoteHead = @(Get-GitOutput $repositoryRoot @('ls-remote', '--heads', 'origin', "refs/heads/$ExpectedSourceBranch"))
  if (
    $privateRemoteHead.Count -ne 1 -or
    $privateRemoteHead[0] -notmatch '^(?<ObjectId>[0-9a-fA-F]{40})\s+refs/heads/.+$' -or
    $Matches.ObjectId -cne $sourceCommit
  ) {
    throw 'The live private source branch does not equal the local reviewed source commit.'
  }
  $liveRemoteParityVerified = $true
}

$rootCount = (Get-GitOutput $destinationPath @('rev-list', '--max-parents=0', '--all', '--count') | Select-Object -First 1).Trim()
if ($rootCount -ne '1') { throw "Public mirror must descend from exactly one sanitized root; found $rootCount." }
$publicCommitsBefore = @(Get-GitOutput $destinationPath @('rev-list', '--all'))
$publicMainCommits = @(Get-GitOutput $destinationPath @('rev-list', $ExpectedPublicBranch))
if ((($publicCommitsBefore | Sort-Object) -join "`n") -ne (($publicMainCommits | Sort-Object) -join "`n")) {
  throw 'Public refs expose commits that are not reachable from the reviewed main branch.'
}
$publicLocalBranches = @(Get-GitOutput $destinationPath @('for-each-ref', '--format=%(refname:short)', 'refs/heads'))
if ($publicLocalBranches.Count -ne 1 -or $publicLocalBranches[0] -ne $ExpectedPublicBranch) {
  throw 'The public mirror must contain only the reviewed main local branch.'
}
$publicRemoteBranches = @(Get-GitOutput $destinationPath @('for-each-ref', '--format=%(refname:short)', 'refs/remotes'))
$unexpectedRemoteBranches = @($publicRemoteBranches | Where-Object { $_ -notin @('origin/HEAD', "origin/$ExpectedPublicBranch") })
if ($unexpectedRemoteBranches.Count -gt 0) {
  throw "Public mirror exposes unexpected remote branches: $($unexpectedRemoteBranches -join ', ')"
}
foreach ($tagName in @(Get-GitOutput $destinationPath @('tag', '--list'))) {
  & git -C $destinationPath merge-base --is-ancestor $tagName $ExpectedPublicBranch
  if ($LASTEXITCODE -ne 0) { throw "Public tag '$tagName' is not contained in reviewed main history." }
}
$privateCommits = @(Get-GitOutput $repositoryRoot @('rev-list', '--all'))
if (@(Compare-Object $publicCommitsBefore $privateCommits -IncludeEqual -ExcludeDifferent).Count -gt 0) {
  throw 'The public mirror shares commit objects with private development history.'
}
Push-Location $destinationPath
try {
  & $node.Source (Join-Path $destinationPath 'tools\privacy-check\index.mjs') --history --pattern-file $protectedPatternPath
  if ($LASTEXITCODE -ne 0) { throw 'Existing public mirror history failed protected privacy review.' }
}
finally {
  Pop-Location
}

try {
  & git -C $repositoryRoot archive --format=zip --output=$archivePath HEAD
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'Could not export the exact private tracked source tree.'
  }
  New-Item -ItemType Directory -Path $stagingPath | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingPath

  $fileListPath = Join-Path $stagingPath '.public-sync-file-list'
  $relativeFiles = @(
    Get-ChildItem -LiteralPath $stagingPath -Recurse -File -Force | ForEach-Object {
      $_.FullName.Substring($stagingPath.TrimEnd('\').Length).TrimStart('\').Replace('\', '/')
    }
  )
  [System.IO.File]::WriteAllLines($fileListPath, $relativeFiles, [System.Text.UTF8Encoding]::new($false))
  Push-Location $stagingPath
  try {
    & $node.Source (Join-Path $stagingPath 'tools\privacy-check\index.mjs') --file-list $fileListPath
    if ($LASTEXITCODE -ne 0) { throw 'The exported public source tree failed its generic privacy check.' }
  }
  finally {
    Pop-Location
  }
  Remove-Item -LiteralPath $fileListPath -Force

  & git -C $destinationPath rm -r -q -- .
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage removal of the prior public source tree.' }
  foreach ($sourceFile in @(Get-ChildItem -LiteralPath $stagingPath -Recurse -File -Force)) {
    $relative = $sourceFile.FullName.Substring($stagingPath.TrimEnd('\').Length).TrimStart('\')
    $target = Join-Path $destinationPath $relative
    $targetDirectory = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container)) {
      New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    }
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $target
  }
  & git -C $destinationPath add --all
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage the new public source tree.' }

  $staged = @(& git -C $destinationPath diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the staged public source update.' }
  $createdCommit = $false
  if ($staged.Count -gt 0) {
    if (-not $CommitMessage) {
      $version = (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json).version
      $CommitMessage = "release: synchronize Balance Book $version source"
    }
    & git -C $destinationPath -c user.name='Balance Book contributors' -c user.email='noreply' commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) { throw 'Could not commit the public source update.' }
    $createdCommit = $true
  }

  $mirrorTree = (Get-GitOutput $destinationPath @('rev-parse', 'HEAD^{tree}') | Select-Object -First 1).Trim()
  if ($mirrorTree -ne $sourceTree) { throw 'The synchronized public tree does not exactly match the reviewed private source tree.' }
  $mirrorStatus = @(Get-GitOutput $destinationPath @('status', '--porcelain=v1', '--untracked-files=all'))
  if ($mirrorStatus.Count -gt 0) { throw 'The synchronized public mirror is not clean.' }
  Push-Location $destinationPath
  try {
    & $node.Source (Join-Path $destinationPath 'tools\privacy-check\index.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The committed public mirror failed its generic privacy check.' }
    & $node.Source (Join-Path $destinationPath 'tools\privacy-check\index.mjs') --history --pattern-file $protectedPatternPath
    if ($LASTEXITCODE -ne 0) { throw 'The complete synchronized public history failed protected privacy review.' }
  }
  finally {
    Pop-Location
  }

  [pscustomobject]@{
    Destination = $destinationPath
    PrivateSourceCommit = $sourceCommit
    SourceTree = $sourceTree
    PublicCommit = (Get-GitOutput $destinationPath @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
    CommitCreated = $createdCommit
    CachedPrivateUpstreamParity = $privateCachedParity
    CachedPublicUpstreamParity = $publicCachedParity
    LiveRemoteParityVerified = $liveRemoteParityVerified
    PushRequired = $createdCommit
    Publishable = $privateCachedParity -and $publicCachedParity -and $liveRemoteParityVerified -and -not $createdCommit
  }
}
finally {
  if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  if (
    (Test-Path -LiteralPath $stagingPath -PathType Container) -and
    $stagingPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $stagingPath).StartsWith('BalanceBookPublicSync-')
  ) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
  }
}
