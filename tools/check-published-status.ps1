[CmdletBinding()]
param(
  [string] $PublicRepository = '15decesaremj/balance-book',
  [string] $PrivateRepository = '15decesaremj/balance-book-mvp',
  [string] $ExpectedBranch = 'main',
  [string] $PrivateExpectedBranch = 'master',
  [Parameter(Mandatory = $true)]
  [string] $PrivateRepositoryPath,
  [Parameter(Mandatory = $true)]
  [string] $ReleaseDirectory,
  [Parameter(Mandatory = $true)]
  [string] $ExpectedPublisher,
  [Parameter(Mandatory = $true)]
  [string] $ExpectedPublisherThumbprint,
  [string] $InstalledExecutable,
  [ValidateSet('beta', 'stable')]
  [string] $Channel = 'stable',
  [switch] $SkipSourceVerification,
  [switch] $SkipRemote
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'publication-helpers.ps1')

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateRoot = [System.IO.Path]::GetFullPath($PrivateRepositoryPath)
$releasePath = [System.IO.Path]::GetFullPath($ReleaseDirectory)
$protectedPatternPath = Join-Path $privateRoot '.privacy-patterns.local'
$protectedPatternCount = if (Test-Path -LiteralPath $protectedPatternPath -PathType Leaf) {
  @(Get-Content -LiteralPath $protectedPatternPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }).Count
}
else { 0 }
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$evidence = [System.Collections.Generic.List[string]]::new()
$head = ''
$version = ''
$expectedPublicAssetNames = @()
$remoteRelease = $null
$releaseFiles = @()
$allExecutablesSigned = $true

foreach ($sourcePath in @($repositoryRoot, $privateRoot)) {
  if (
    $releasePath -eq $sourcePath -or
    $releasePath.StartsWith(($sourcePath.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'ReleaseDirectory must be outside both source repositories so a download cannot dirty either tree.'
  }
}

function Add-Failure([string] $Message) {
  $failures.Add($Message)
}

if ($protectedPatternCount -eq 0) {
  Add-Failure 'A present, nonempty private .privacy-patterns.local review list is required for publication.'
}

function Invoke-Captured([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory = $repositoryRoot) {
  Push-Location $WorkingDirectory
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = @(& $FilePath @Arguments 2>&1)
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    [pscustomobject]@{
      ExitCode = $exitCode
      Output = ($output -join [Environment]::NewLine).Trim()
    }
  }
  finally {
    Pop-Location
  }
}

function Get-ManifestEntries([string] $ManifestPath) {
  $entries = @{}
  foreach ($line in Get-Content -LiteralPath $ManifestPath) {
    if (-not $line.Trim()) { continue }
    if ($line -notmatch '^([A-Fa-f0-9]{64})\s+\*?(.+)$') {
      throw "Invalid SHA-256 manifest line: $line"
    }
    if ($entries.ContainsKey($Matches[2])) {
      throw "Duplicate SHA-256 manifest entry: $($Matches[2])"
    }
    $entries[$Matches[2]] = $Matches[1].ToUpperInvariant()
  }
  $entries
}

function Get-NormalizedFileVersion([System.IO.FileInfo] $File) {
  $raw = if ($File.VersionInfo.ProductVersion) { $File.VersionInfo.ProductVersion } else { $File.VersionInfo.FileVersion }
  try {
    $parsed = [version] $raw
    "$($parsed.Major).$($parsed.Minor).$($parsed.Build)"
  }
  catch {
    ''
  }
}

function Test-SignedExecutable(
  [System.IO.FileInfo] $File,
  [string] $Publisher,
  [string] $PublisherThumbprint,
  [bool] $RequireSignature
) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    if ($RequireSignature) {
      Add-Failure "$($File.Name) signature status is $($signature.Status)."
    }
    else {
      $warnings.Add("$($File.Name) signature status is $($signature.Status).")
    }
    return $false
  }
  if (-not $Publisher -or $signature.SignerCertificate.Subject -cne $Publisher) {
    Add-Failure "$($File.Name) is not signed by the expected publisher '$Publisher'."
    return $false
  }
  if ($signature.SignerCertificate.Thumbprint -ine $PublisherThumbprint.Replace(' ', '')) {
    Add-Failure "$($File.Name) signer thumbprint does not equal the reviewed publisher certificate thumbprint."
    return $false
  }
  if (-not $signature.TimeStamperCertificate) {
    Add-Failure "$($File.Name) does not have a trusted timestamp certificate."
    return $false
  }
  $evidence.Add("$($File.Name) has a valid expected-publisher signature and timestamp.")
  return $true
}

Push-Location $repositoryRoot
try {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Add-Failure 'Git is not installed or available on PATH.'
  }
  else {
    $worktree = Invoke-Captured $git.Source @('status', '--porcelain=v1', '--untracked-files=all')
    if ($worktree.ExitCode -ne 0) {
      Add-Failure 'The public source working tree could not be inspected.'
    }
    elseif ($worktree.Output) {
      Add-Failure 'The public source working tree is not clean.'
    }
    else {
      $evidence.Add('Public source working tree is clean.')
    }

    $branchResult = Invoke-Captured $git.Source @('branch', '--show-current')
    $branch = $branchResult.Output
    if ($branchResult.ExitCode -ne 0 -or $branch -ne $ExpectedBranch) {
      Add-Failure "Expected public branch '$ExpectedBranch'; found '$branch'."
    }
    else {
      $evidence.Add("Public branch is $branch.")
    }

    $headResult = Invoke-Captured $git.Source @('rev-parse', 'HEAD')
    $head = $headResult.Output
    if ($headResult.ExitCode -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
      Add-Failure 'The exact public source commit could not be resolved.'
      $head = ''
    }

    $publicRootCount = Invoke-Captured $git.Source @('rev-list', '--max-parents=0', '--all', '--count')
    if ($publicRootCount.ExitCode -ne 0 -or $publicRootCount.Output -ne '1') {
      Add-Failure "The clean-history public mirror must contain exactly one sanitized root; found '$($publicRootCount.Output)'."
    }
    else {
      $evidence.Add('Public mirror history descends from one sanitized root.')
    }

    $trackedResult = Invoke-Captured $git.Source @('ls-files')
    if ($trackedResult.ExitCode -ne 0) {
      Add-Failure 'Tracked public files could not be enumerated.'
    }
    else {
      $prohibited = @(
        $trackedResult.Output -split "`r?`n" |
          Where-Object {
            $_ -match '(^|/)(local-releases|local-release-work|private|release|releases|out|\.vite|test-results|node_modules)(/|$)' -or
            $_ -match '\.(xlsx?|xlsm|sqlite3?|sqlite-wal|sqlite-shm|sqlite-journal|db|db-wal|db-shm|balancebook-backup|backup|pfx|p12|pem|key|exe|msi|msix|nupkg|zip|7z|asar|pak|dll|node)$'
          }
      )
      if ($prohibited.Count -gt 0) {
        Add-Failure "Prohibited private or generated paths are tracked: $($prohibited -join ', ')"
      }
      else {
        $evidence.Add('No prohibited private or generated public path is tracked.')
      }
    }

    if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) {
      Add-Failure "Private repository path does not exist: $privateRoot"
    }
    else {
      $privateStatus = Invoke-Captured $git.Source @('status', '--porcelain=v1', '--untracked-files=all') $privateRoot
      if ($privateStatus.ExitCode -ne 0 -or $privateStatus.Output) {
        Add-Failure 'The private development repository is not clean.'
      }
      $privateBranch = Invoke-Captured $git.Source @('branch', '--show-current') $privateRoot
      if ($privateBranch.ExitCode -ne 0 -or $privateBranch.Output -ne $PrivateExpectedBranch) {
        Add-Failure "Expected private branch '$PrivateExpectedBranch'; found '$($privateBranch.Output)'."
      }
      $privateHead = Invoke-Captured $git.Source @('rev-parse', 'HEAD') $privateRoot
      $privateUpstream = Invoke-Captured $git.Source @('rev-parse', '@{u}') $privateRoot
      if ($privateHead.ExitCode -ne 0 -or $privateUpstream.ExitCode -ne 0 -or $privateHead.Output -ne $privateUpstream.Output) {
        Add-Failure 'The private development branch is not synchronized with its configured upstream.'
      }
      $publicTree = Invoke-Captured $git.Source @('rev-parse', 'HEAD^{tree}')
      $privateTree = Invoke-Captured $git.Source @('rev-parse', 'HEAD^{tree}') $privateRoot
      if ($publicTree.ExitCode -ne 0 -or $privateTree.ExitCode -ne 0 -or $publicTree.Output -ne $privateTree.Output) {
        Add-Failure 'The public mirror tree does not exactly match the private reviewed source tree.'
      }
      else {
        $evidence.Add('Private and public source trees match exactly.')
      }
    }
  }

  $rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
  $desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\package.json') | ConvertFrom-Json
  $version = [string] $rootPackage.version
  if ($version -ne [string] $desktopPackage.version) {
    Add-Failure "Root version $version and desktop version $($desktopPackage.version) differ."
  }
  else {
    $evidence.Add("Package version is $version.")
  }
  $expectedPublicAssetNames = @(
    "Balance-Book-$version-Setup.exe",
    "Uninstall-Balance-Book-$version.exe",
    "balance_book_mvp-$version-full.nupkg",
    'LICENSE.txt',
    'README-FIRST.txt',
    'RELEASES',
    'RELEASE-METADATA.json',
    'SHA256SUMS.txt',
    'THIRD_PARTY_NOTICES.txt'
  ) | Sort-Object

  $expectedRepositoryUrl = "https://github.com/$PublicRepository"
  if (
    $rootPackage.repository.url -notlike "*$PublicRepository*" -or
    $rootPackage.bugs.url -notlike "$expectedRepositoryUrl*" -or
    $rootPackage.homepage -notlike "$expectedRepositoryUrl*"
  ) {
    Add-Failure "Package URLs do not all target $PublicRepository."
  }

  $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpm) { $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
  if (-not $pnpm) {
    Add-Failure 'pnpm is unavailable, so source verification could not run.'
  }
  elseif ($SkipSourceVerification) {
    Add-Failure 'Source verification was skipped; Published Status cannot be established.'
  }
  else {
    $verification = Invoke-Captured $pnpm.Source @('verify')
    if ($verification.ExitCode -ne 0) {
      Add-Failure 'The exact public source tree did not pass pnpm verify.'
    }
    else {
      $evidence.Add('The exact public source tree passed pnpm verify.')
    }
  }

  if ($pnpm -and (Test-Path -LiteralPath $privateRoot -PathType Container)) {
    $privatePrivacy = Invoke-Captured $pnpm.Source @('privacy:check') $privateRoot
    if ($privatePrivacy.ExitCode -ne 0) {
      Add-Failure 'The private reviewed tree did not pass its protected local-pattern privacy check.'
    }
    else {
      $evidence.Add('The private reviewed tree passed its protected local-pattern privacy check.')
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node -or $protectedPatternCount -eq 0) {
      Add-Failure 'Node.js and the protected pattern list are required for full public-history privacy review.'
    }
    else {
      $historyPrivacy = Invoke-Captured $node.Source @(
        (Join-Path $repositoryRoot 'tools\privacy-check\index.mjs'),
        '--history', '--pattern-file', $protectedPatternPath
      )
      if ($historyPrivacy.ExitCode -ne 0) {
        Add-Failure 'The complete reachable public Git history failed protected privacy review.'
      }
      else {
        $evidence.Add('The complete reachable public Git history passed protected privacy review.')
      }
    }
  }

  if ($git) {
    $publicCommits = @((Invoke-Captured $git.Source @('rev-list', '--all')).Output -split "`r?`n" | Where-Object { $_ })
    $mainCommits = @((Invoke-Captured $git.Source @('rev-list', $ExpectedBranch)).Output -split "`r?`n" | Where-Object { $_ })
    $publicCommitList = ($publicCommits | Sort-Object) -join "`n"
    $mainCommitList = ($mainCommits | Sort-Object) -join "`n"
    if ($publicCommitList -ne $mainCommitList) {
      Add-Failure 'Public refs expose commits that are not reachable from the reviewed main branch.'
    }
    $privateCommits = @((Invoke-Captured $git.Source @('rev-list', '--all') $privateRoot).Output -split "`r?`n" | Where-Object { $_ })
    if (@(Compare-Object $publicCommits $privateCommits -IncludeEqual -ExcludeDifferent).Count -gt 0) {
      Add-Failure 'The public mirror shares commit objects with private development history.'
    }
    $localBranches = @((Invoke-Captured $git.Source @('for-each-ref', '--format=%(refname:short)', 'refs/heads')).Output -split "`r?`n" | Where-Object { $_ })
    if ($localBranches.Count -ne 1 -or $localBranches[0] -ne $ExpectedBranch) {
      Add-Failure 'The public checkout must contain only the reviewed main local branch.'
    }
    $remoteBranches = @((Invoke-Captured $git.Source @('for-each-ref', '--format=%(refname:short)', 'refs/remotes')).Output -split "`r?`n" | Where-Object { $_ })
    $unexpectedRemoteBranches = @($remoteBranches | Where-Object { $_ -notin @('origin/HEAD', "origin/$ExpectedBranch") })
    if ($unexpectedRemoteBranches.Count -gt 0) {
      Add-Failure "Public checkout exposes unexpected remote branches: $($unexpectedRemoteBranches -join ', ')"
    }
    $tagNames = @((Invoke-Captured $git.Source @('tag', '--list')).Output -split "`r?`n" | Where-Object { $_ })
    foreach ($tagName in $tagNames) {
      $tagAncestor = Invoke-Captured $git.Source @('merge-base', '--is-ancestor', $tagName, $ExpectedBranch)
      if ($tagAncestor.ExitCode -ne 0) { Add-Failure "Public tag '$tagName' is not contained in reviewed main history." }
    }
  }

  if ($git) {
    foreach ($treeCheck in @(
      @{ Path = $repositoryRoot; Label = 'public source' },
      @{ Path = $privateRoot; Label = 'private development' }
    )) {
      $finalStatus = Invoke-Captured $git.Source @('status', '--porcelain=v1', '--untracked-files=all') $treeCheck.Path
      if ($finalStatus.ExitCode -ne 0 -or $finalStatus.Output) {
        Add-Failure "The $($treeCheck.Label) worktree became dirty during verification."
      }
    }
  }

  if ($SkipRemote) {
    Add-Failure 'Remote verification was skipped; Published Status cannot be established offline.'
  }
  else {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
      Add-Failure 'GitHub CLI is unavailable, so repository and release state could not be verified.'
    }
    else {
      $auth = Invoke-Captured $gh.Source @('auth', 'status', '-h', 'github.com')
      if ($auth.ExitCode -ne 0) {
        Add-Failure 'GitHub CLI authentication is not valid.'
      }
      else {
        foreach ($repositoryCheck in @(
          @{ Name = $PublicRepository; Visibility = 'PUBLIC'; Branch = $ExpectedBranch },
          @{ Name = $PrivateRepository; Visibility = 'PRIVATE'; Branch = $PrivateExpectedBranch }
        )) {
          $repoView = Invoke-Captured $gh.Source @('repo', 'view', $repositoryCheck.Name, '--json', 'visibility,defaultBranchRef,url')
          if ($repoView.ExitCode -ne 0) {
            Add-Failure "Repository $($repositoryCheck.Name) could not be read."
            continue
          }
          $repoData = $repoView.Output | ConvertFrom-Json
          if ($repoData.visibility -ne $repositoryCheck.Visibility) {
            Add-Failure "$($repositoryCheck.Name) visibility is not $($repositoryCheck.Visibility)."
          }
          if ($repoData.defaultBranchRef.name -ne $repositoryCheck.Branch) {
            Add-Failure "$($repositoryCheck.Name) default branch is not $($repositoryCheck.Branch)."
          }
        }

        $remoteHistoryAudit = $null
        $remoteAuditGit = Get-Command git -ErrorAction SilentlyContinue
        $remoteAuditNode = Get-Command node -ErrorAction SilentlyContinue
        if (-not $remoteAuditGit -or -not $remoteAuditNode -or $protectedPatternCount -eq 0) {
          Add-Failure 'Git, Node.js, and protected patterns are required to audit every live public ref.'
        }
        else {
          try {
            $remoteHistoryAudit = Invoke-PublicRemoteHistoryAudit `
              -RepositoryUrl "https://github.com/$PublicRepository.git" `
              -PrivateRepositoryUrl "https://github.com/$PrivateRepository.git" `
              -ExpectedBranch $ExpectedBranch `
              -PrivateRepositoryPath $privateRoot `
              -PrivacyScriptPath (Join-Path $repositoryRoot 'tools\privacy-check\index.mjs') `
              -ProtectedPatternPath $protectedPatternPath `
              -GitExecutable $remoteAuditGit.Source `
              -NodeExecutable $remoteAuditNode.Source
            if ($head -and $remoteHistoryAudit.MainCommit -cne $head) {
              Add-Failure 'The live public main branch does not equal the exact local public source commit.'
            }
            else {
              $evidence.Add("Fetched and privacy-audited all $($remoteHistoryAudit.RemoteRefCount) live public branch, tag, and pull-request refs in isolation.")
            }
          }
          catch {
            Add-Failure "Live public remote-history audit failed: $($_.Exception.Message)"
          }
        }

        if ($head) {
          $remoteHead = Invoke-Captured $gh.Source @('api', "repos/$PublicRepository/commits/$ExpectedBranch", '--jq', '.sha')
          if ($remoteHead.ExitCode -ne 0 -or $remoteHead.Output -ne $head) {
            Add-Failure 'Public default branch does not equal the exact local public source commit.'
          }
          $privateLocalHead = Invoke-Captured $git.Source @('rev-parse', 'HEAD') $privateRoot
          $privateRemoteHead = Invoke-Captured $gh.Source @('api', "repos/$PrivateRepository/commits/$PrivateExpectedBranch", '--jq', '.sha')
          if ($privateLocalHead.ExitCode -ne 0 -or $privateRemoteHead.ExitCode -ne 0 -or $privateLocalHead.Output -ne $privateRemoteHead.Output) {
            Add-Failure 'Private GitHub default branch does not equal the exact local private source commit.'
          }
        }

        $expectedTag = if ($Channel -eq 'beta') { "v$version-beta" } else { "v$version" }
        $releaseView = Invoke-Captured $gh.Source @(
          'release', 'view', $expectedTag, '--repo', $PublicRepository,
          '--json', 'tagName,name,body,isDraft,isPrerelease,assets,url,targetCommitish'
        )
        if ($releaseView.ExitCode -ne 0) {
          Add-Failure 'The latest public GitHub release could not be verified.'
        }
        else {
          $remoteRelease = $releaseView.Output | ConvertFrom-Json
          if ($remoteRelease.isDraft) { Add-Failure 'The latest GitHub release is still a draft.' }
          if ($Channel -eq 'stable' -and $remoteRelease.isPrerelease) {
            Add-Failure 'READY on the Stable channel requires a non-prerelease GitHub release.'
          }
          if ($Channel -eq 'beta' -and -not $remoteRelease.isPrerelease) {
            Add-Failure 'READY on the Beta channel requires a GitHub prerelease.'
          }
          if ($remoteRelease.tagName -ne $expectedTag) {
            Add-Failure "Latest release tag is '$($remoteRelease.tagName)', not '$expectedTag'."
          }
          $immutableResult = Invoke-Captured $gh.Source @(
            'api',
            "repos/$PublicRepository/releases/tags/$expectedTag",
            '-H', 'X-GitHub-Api-Version: 2026-03-10',
            '--jq', '.immutable'
          )
          if ($immutableResult.ExitCode -ne 0 -or $immutableResult.Output -ne 'true') {
            Add-Failure 'The public GitHub release is not immutable.'
          }
          if (
            [string]::IsNullOrWhiteSpace($remoteRelease.name) -or
            $remoteRelease.name -notmatch [regex]::Escape($version) -or
            [string]::IsNullOrWhiteSpace($remoteRelease.body) -or
            $remoteRelease.body -notmatch [regex]::Escape($version)
          ) {
            Add-Failure 'The GitHub release name and reviewed release-note body must both identify the exact version.'
          }
          if ($head) {
            $tagHead = Invoke-Captured $gh.Source @('api', "repos/$PublicRepository/commits/$($remoteRelease.tagName)", '--jq', '.sha')
            if ($tagHead.ExitCode -ne 0 -or $tagHead.Output -ne $head) {
              Add-Failure 'The public release tag does not resolve to the exact public source commit.'
            }
          }

          $remoteAssetNames = @($remoteRelease.assets | ForEach-Object { $_.name } | Sort-Object)
          if (($remoteAssetNames -join "`n") -ne ($expectedPublicAssetNames -join "`n")) {
            Add-Failure 'GitHub release assets do not exactly match the reviewed public-release file set.'
          }

          if (Test-Path -LiteralPath $releasePath) {
            $existing = @(Get-ChildItem -LiteralPath $releasePath -Force -ErrorAction SilentlyContinue)
            if ($existing.Count -gt 0) {
              Add-Failure "Fresh-download directory must be empty before verification: $releasePath"
            }
          }
          else {
            New-Item -ItemType Directory -Path $releasePath | Out-Null
          }

          if ($failures -notcontains "Fresh-download directory must be empty before verification: $releasePath") {
            $download = Invoke-Captured $gh.Source @(
              'release', 'download', $remoteRelease.tagName,
              '--repo', $PublicRepository, '--dir', $releasePath
            )
            if ($download.ExitCode -ne 0) {
              Add-Failure 'Fresh download of the exact public release assets failed.'
            }
            else {
              $evidence.Add("Downloaded the exact GitHub release into $releasePath.")
            }
          }
          $evidence.Add("GitHub release: $($remoteRelease.url)")
        }
      }
    }
  }

  if (Test-Path -LiteralPath $releasePath -PathType Container) {
    $releaseFiles = @(Get-ChildItem -LiteralPath $releasePath -File | Sort-Object Name)
    $privateAssets = @(
      $releaseFiles | Where-Object {
        $_.Name -match '\.(balancebook-backup|xlsx?|xlsm|sqlite3?|sqlite-wal|sqlite-shm|sqlite-journal|db|db-wal|db-shm|backup|pfx|p12|pem|key|zip|7z|asar|pak|dll|node|log|pdf|csv)$' -or
        ($_.Extension -ieq '.nupkg' -and $_.Name -ne "balance_book_mvp-$version-full.nupkg") -or
        $_.Name -match '(?i)private|database|workbook|export'
      }
    )
    if ($privateAssets.Count -gt 0) {
      Add-Failure "Release directory contains prohibited private assets: $($privateAssets.Name -join ', ')"
    }

    $setups = @($releaseFiles | Where-Object { $_.Extension -ieq '.exe' -and $_.Name -match '(?i)setup|install' -and $_.Name -notmatch '(?i)uninstall' })
    $uninstallers = @($releaseFiles | Where-Object { $_.Extension -ieq '.exe' -and $_.Name -match '(?i)uninstall' })
    $manifests = @($releaseFiles | Where-Object { $_.Name -ieq 'SHA256SUMS.txt' })
    $metadataFiles = @($releaseFiles | Where-Object { $_.Name -ieq 'RELEASE-METADATA.json' })
    $squirrelPackages = @($releaseFiles | Where-Object { $_.Name -eq "balance_book_mvp-$version-full.nupkg" })
    $releaseFeeds = @($releaseFiles | Where-Object { $_.Name -ceq 'RELEASES' })
    if ($setups.Count -ne 1) { Add-Failure 'Release directory must contain exactly one Setup executable.' }
    if ($uninstallers.Count -ne 1) { Add-Failure 'Release directory must contain exactly one uninstall helper.' }
    if ($manifests.Count -ne 1) { Add-Failure 'Release directory must contain exactly one SHA256SUMS.txt.' }
    if ($metadataFiles.Count -ne 1) { Add-Failure 'Release directory must contain exactly one RELEASE-METADATA.json.' }
    if ($squirrelPackages.Count -ne 1) { Add-Failure 'Release directory must contain exactly one versioned Squirrel package.' }
    if ($releaseFeeds.Count -ne 1) { Add-Failure 'Release directory must contain exactly one Squirrel RELEASES feed.' }

    $localNames = @($releaseFiles.Name | Sort-Object)
    if (($localNames -join "`n") -ne ($expectedPublicAssetNames -join "`n")) {
      Add-Failure 'Fresh-download folder does not exactly match the reviewed public-release file set.'
    }
    if ($remoteRelease) {
      $remoteNames = @($remoteRelease.assets | ForEach-Object { $_.name } | Sort-Object)
      if (($localNames -join "`n") -ne ($remoteNames -join "`n")) {
        Add-Failure 'Fresh-download folder does not exactly match the GitHub release asset list.'
      }
      foreach ($asset in $remoteRelease.assets) {
        $local = $releaseFiles | Where-Object { $_.Name -eq $asset.name } | Select-Object -First 1
        if ($local -and [int64] $asset.size -ne $local.Length) {
          Add-Failure "Downloaded size differs from GitHub metadata for $($asset.name)."
        }
        if ($local -and $asset.PSObject.Properties.Name -contains 'digest' -and $asset.digest -match '^sha256:(.+)$') {
          $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $local.FullName).Hash
          if ($downloadedHash -ne $Matches[1].ToUpperInvariant()) {
            Add-Failure "Downloaded SHA-256 differs from GitHub metadata for $($asset.name)."
          }
        }
      }
    }

    foreach ($file in @($setups + $uninstallers)) {
      if ($file.Name -notmatch [regex]::Escape($version)) {
        Add-Failure "$($file.Name) does not identify package version $version."
      }
      $binaryVersion = Get-NormalizedFileVersion $file
      if ($binaryVersion -ne $version) {
        Add-Failure "$($file.Name) binary version '$binaryVersion' does not equal package version '$version'."
      }
    }

    if ($manifests.Count -eq 1 -and $setups.Count -eq 1 -and $uninstallers.Count -eq 1) {
      try {
        $manifestEntries = Get-ManifestEntries $manifests[0].FullName
        $expectedManifestNames = @($releaseFiles | Where-Object { $_.Name -ine 'SHA256SUMS.txt' } | ForEach-Object { $_.Name } | Sort-Object)
        $actualManifestNames = @($manifestEntries.Keys | Sort-Object)
        if (($expectedManifestNames -join "`n") -ne ($actualManifestNames -join "`n")) {
          Add-Failure 'SHA256SUMS.txt must list every public release asset except itself, and nothing else.'
        }
        foreach ($file in @($releaseFiles | Where-Object { $_.Name -ine 'SHA256SUMS.txt' })) {
          if ($manifestEntries.ContainsKey($file.Name)) {
            $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
            if ($actualHash -ne $manifestEntries[$file.Name]) {
              Add-Failure "SHA-256 mismatch for $($file.Name)."
            }
          }
        }
      }
      catch {
        Add-Failure $_.Exception.Message
      }
    }

    $releaseMetadata = $null
    if ($metadataFiles.Count -eq 1 -and $head) {
      try {
        $releaseMetadata = Get-Content -Raw -LiteralPath $metadataFiles[0].FullName | ConvertFrom-Json
        $publicTreeResult = Invoke-Captured $git.Source @('rev-parse', 'HEAD^{tree}')
        $lockfileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repositoryRoot 'pnpm-lock.yaml')).Hash
        if ($releaseMetadata.format -ne 'balance-book-public-release' -or $releaseMetadata.metadataVersion -ne 1) {
          Add-Failure 'RELEASE-METADATA.json has an unsupported format or metadata version.'
        }
        if ($squirrelPackages.Count -eq 1) {
          $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $squirrelPackages[0].FullName).Hash
          if (
            $releaseMetadata.squirrelPackage.name -ne $squirrelPackages[0].Name -or
            $releaseMetadata.squirrelPackage.sha256 -ne $packageHash
          ) {
            Add-Failure 'Release metadata does not match the exact Squirrel update package.'
          }
        }
        if (
          $releaseFeeds.Count -eq 1 -and
          [string] (Get-Content -Raw -LiteralPath $releaseFeeds[0].FullName).Trim() -ne
            [string] $releaseMetadata.squirrelPackage.publicReleasesLine
        ) {
          Add-Failure 'The public RELEASES feed does not match release metadata.'
        }
        if ($releaseMetadata.version -ne $version -or $releaseMetadata.sourceCommit -ne $head -or $releaseMetadata.sourceTree -ne $publicTreeResult.Output) {
          Add-Failure 'Release metadata is not bound to the exact version, commit, and tree under review.'
        }
        $expectedMetadataTag = if ($Channel -eq 'beta') { "v$version-beta" } else { "v$version" }
        if ($releaseMetadata.releaseTag -ne $expectedMetadataTag) {
          Add-Failure 'Release metadata does not match the requested update channel tag.'
        }
        if ($releaseMetadata.updateChannel -ne $Channel) {
          Add-Failure 'Release metadata does not match the requested update channel.'
        }
        $expectedPackageUrl = "https://github.com/$PublicRepository/releases/download/$expectedMetadataTag/balance_book_mvp-$version-full.nupkg"
        if ($releaseMetadata.squirrelPackage.immutableAssetUrl -cne $expectedPackageUrl) {
          Add-Failure 'Release metadata does not point to the exact immutable Squirrel package asset.'
        }
        if ($releaseMetadata.lockfileSha256 -ne $lockfileHash) {
          Add-Failure 'Release metadata lockfile hash does not match the reviewed source tree.'
        }
        if (
          $releaseMetadata.buildEvidence.format -ne 'balance-book-windows-release-candidate' -or
          $releaseMetadata.buildEvidence.sourceCommit -ne $head -or
          $releaseMetadata.buildEvidence.sourceTree -ne $publicTreeResult.Output -or
          $releaseMetadata.buildEvidence.sha256 -notmatch '^[A-Fa-f0-9]{64}$'
        ) {
          Add-Failure 'Release metadata does not contain build evidence bound to the exact reviewed source.'
        }
        if (-not $releaseMetadata.artifactReady -or $releaseMetadata.assemblyStatus -ne 'validated-artifact-set') {
          Add-Failure 'Release metadata does not identify a validated assembly-time artifact set.'
        }
        if ($setups.Count -eq 1) {
          $setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setups[0].FullName).Hash
          if ($releaseMetadata.setup.name -ne $setups[0].Name -or $releaseMetadata.setup.sha256 -ne $setupHash) {
            Add-Failure 'Release metadata does not identify the exact downloaded Setup executable.'
          }
        }
        if ($uninstallers.Count -eq 1) {
          $uninstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uninstallers[0].FullName).Hash
          if ($releaseMetadata.uninstaller.name -ne $uninstallers[0].Name -or $releaseMetadata.uninstaller.sha256 -ne $uninstallerHash) {
            Add-Failure 'Release metadata does not identify the exact downloaded uninstall helper.'
          }
        }
        foreach ($signatureRecord in @($releaseMetadata.setup, $releaseMetadata.uninstaller, $releaseMetadata.packagedExecutable)) {
          if (
            $signatureRecord.signerSubject -cne $ExpectedPublisher -or
            $signatureRecord.signerThumbprint -ine $ExpectedPublisherThumbprint.Replace(' ', '')
          ) {
            Add-Failure 'Release metadata signer identity does not match the exact reviewed publisher certificate.'
            break
          }
        }
      }
      catch {
        Add-Failure "RELEASE-METADATA.json could not be validated: $($_.Exception.Message)"
      }
    }

    foreach ($legalPair in @(
      @{ Download = 'LICENSE.txt'; Source = 'LICENSE' },
      @{ Download = 'THIRD_PARTY_NOTICES.txt'; Source = 'THIRD_PARTY_NOTICES.txt' }
    )) {
      $downloadPath = Join-Path $releasePath $legalPair.Download
      $sourcePath = Join-Path $repositoryRoot $legalPair.Source
      if (
        -not (Test-Path -LiteralPath $downloadPath -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash
      ) {
        Add-Failure "$($legalPair.Download) is not byte-identical to the reviewed source notice."
      }
    }

    $protectedPatterns = if (Test-Path -LiteralPath $protectedPatternPath -PathType Leaf) {
      @(Get-Content -LiteralPath $protectedPatternPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    }
    else { @() }
    foreach ($textName in @('README-FIRST.txt', 'RELEASE-METADATA.json')) {
      $textPath = Join-Path $releasePath $textName
      if (-not (Test-Path -LiteralPath $textPath -PathType Leaf)) { continue }
      $content = Get-Content -Raw -LiteralPath $textPath
      if ($content -match '(gh[opsu]_[A-Za-z0-9_]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|C:\\Users\\(?!Example(?:\\|$)|Public(?:\\|$)|Default(?:\\|$)|<user>(?:\\|$))[^\\\s"'']+)') {
        Add-Failure "$textName contains a possible secret or personal Windows path."
      }
      foreach ($pattern in $protectedPatterns) {
        if ($ExpectedPublisher -and $ExpectedPublisher.ToLowerInvariant().Contains($pattern.ToLowerInvariant())) { continue }
        if ($content.ToLowerInvariant().Contains($pattern.ToLowerInvariant())) {
          Add-Failure "$textName matches a protected private-content pattern."
          break
        }
      }
    }

    foreach ($file in @($setups + $uninstallers)) {
      if (-not (Test-SignedExecutable $file $ExpectedPublisher $ExpectedPublisherThumbprint $true)) { $allExecutablesSigned = $false }
    }

    if (-not $InstalledExecutable) {
      Add-Failure 'InstalledExecutable is required to bind installed-app evidence to the release.'
    }
    elseif (-not (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) {
      Add-Failure "Installed executable does not exist: $InstalledExecutable"
    }
    else {
      $installedFile = Get-Item -LiteralPath $InstalledExecutable
      $installedVersion = Get-NormalizedFileVersion $installedFile
      if ($installedVersion -ne $version) {
        Add-Failure "Installed executable version '$installedVersion' does not equal package version '$version'."
      }
      if (-not (Test-SignedExecutable $installedFile $ExpectedPublisher $ExpectedPublisherThumbprint $true)) {
        $allExecutablesSigned = $false
      }
      if ($releaseMetadata -and $releaseMetadata.packagedExecutable.sha256) {
        $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFile.FullName).Hash
        if ($installedHash -ne $releaseMetadata.packagedExecutable.sha256) {
          Add-Failure 'Installed executable is not byte-identical to the packaged application recorded for this release.'
        }
      }
    }
  }

  $automatedGate = if ($failures.Count -eq 0) { 'PASSED' } else { 'BLOCKED' }
  $candidateLabel = if ($failures.Count -eq 0) { 'READY candidate after manual lifecycle review' } else { 'BLOCKED' }
  [pscustomobject]@{
    AutomatedGate = $automatedGate
    CandidateLabel = $candidateLabel
    PublicRepository = $PublicRepository
    PrivateRepository = $PrivateRepository
    SourceCommit = $head
    Version = $version
    ReleaseDirectory = $releasePath
    Evidence = @($evidence)
    Warnings = @($warnings)
    Blockers = @($failures)
    ManualGate = 'Still required: dependency/license and GitHub release-body review plus recorded fresh install, onboarding, restart, upgrade, uninstall, preserved-data reinstall, clean restore, and File Explorer handoff.'
  } | Format-List

  if ($automatedGate -eq 'BLOCKED') { exit 1 }
}
finally {
  Pop-Location
}
