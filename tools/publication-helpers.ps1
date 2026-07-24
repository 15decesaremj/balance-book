function Invoke-BalanceBookNativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,
    [Parameter(Mandatory = $true)]
    [string] $WorkingDirectory,
    [string] $FailureMessage = 'A required publication command failed.'
  )

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
  }
  finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    throw $FailureMessage
  }
  @($output | ForEach-Object { [string] $_ })
}

function Get-BalanceBookRemoteRefLines {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepositoryUrl,
    [Parameter(Mandatory = $true)]
    [string] $GitExecutable,
    [Parameter(Mandatory = $true)]
    [string] $WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string] $RepositoryLabel
  )

  $advertised = @(
    Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
      'ls-remote', '--refs', $RepositoryUrl
    ) -WorkingDirectory $WorkingDirectory -FailureMessage "The complete advertised $RepositoryLabel ref set could not be enumerated."
  )
  $hiddenPullRefs = @(
    Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
      'ls-remote', '--refs', $RepositoryUrl, 'refs/pull/*'
    ) -WorkingDirectory $WorkingDirectory -FailureMessage "The hidden $RepositoryLabel pull-request ref set could not be enumerated."
  )
  @(($advertised + $hiddenPullRefs) | Sort-Object -Unique)
}

function Import-BalanceBookRemoteRefs {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepositoryUrl,
    [Parameter(Mandatory = $true)]
    [System.Collections.Generic.Dictionary[string, string]] $RemoteRefs,
    [Parameter(Mandatory = $true)]
    [string] $AuditRepositoryPath,
    [Parameter(Mandatory = $true)]
    [string] $GitExecutable,
    [Parameter(Mandatory = $true)]
    [string] $WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string] $RepositoryLabel
  )

  $refNames = @($RemoteRefs.Keys | Sort-Object)
  for ($offset = 0; $offset -lt $refNames.Count; $offset += 40) {
    $last = [Math]::Min($offset + 39, $refNames.Count - 1)
    $arguments = @('-C', $AuditRepositoryPath, 'fetch', '--no-tags', '--force', $RepositoryUrl)
    foreach ($refName in @($refNames[$offset..$last])) {
      $auditRef = $refName -replace '^refs/', 'refs/audit/original/'
      $arguments += "+${refName}:$auditRef"
    }
    Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments $arguments `
      -WorkingDirectory $WorkingDirectory -FailureMessage "The complete $RepositoryLabel ref set could not be fetched into isolation." | Out-Null
  }
}

function Invoke-PublicRemoteHistoryAudit {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepositoryUrl,
    [Parameter(Mandatory = $true)]
    [string] $PrivateRepositoryUrl,
    [Parameter(Mandatory = $true)]
    [string] $ExpectedBranch,
    [Parameter(Mandatory = $true)]
    [string] $PrivateRepositoryPath,
    [Parameter(Mandatory = $true)]
    [string] $PrivacyScriptPath,
    [Parameter(Mandatory = $true)]
    [string] $ProtectedPatternPath,
    [Parameter(Mandatory = $true)]
    [string] $GitExecutable,
    [Parameter(Mandatory = $true)]
    [string] $NodeExecutable
  )

  $privateRoot = [System.IO.Path]::GetFullPath($PrivateRepositoryPath)
  $privacyScript = [System.IO.Path]::GetFullPath($PrivacyScriptPath)
  $protectedPatterns = [System.IO.Path]::GetFullPath($ProtectedPatternPath)
  if (-not (Test-Path -LiteralPath (Join-Path $privateRoot '.git'))) {
    throw 'The private repository is unavailable for public-history intersection review.'
  }
  if (-not (Test-Path -LiteralPath $privacyScript -PathType Leaf)) {
    throw 'The privacy-history scanner is unavailable.'
  }
  if (-not (Test-Path -LiteralPath $protectedPatterns -PathType Leaf)) {
    throw 'The protected private-pattern list is unavailable.'
  }

  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $auditPath = [System.IO.Path]::GetFullPath(
    (Join-Path $temporaryRoot ('BalanceBookRemoteHistoryAudit-' + [guid]::NewGuid().ToString('N')))
  )
  $privateAuditPath = [System.IO.Path]::GetFullPath(
    (Join-Path $temporaryRoot ('BalanceBookPrivateHistoryAudit-' + [guid]::NewGuid().ToString('N')))
  )
  if (
    -not $auditPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
    -not (Split-Path -Leaf $auditPath).StartsWith('BalanceBookRemoteHistoryAudit-') -or
    -not $privateAuditPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
    -not (Split-Path -Leaf $privateAuditPath).StartsWith('BalanceBookPrivateHistoryAudit-')
  ) {
    throw 'Refusing to use an unsafe remote-history audit path.'
  }

  try {
    $remoteLines = @(
      Get-BalanceBookRemoteRefLines -RepositoryUrl $RepositoryUrl `
        -GitExecutable $GitExecutable -WorkingDirectory $temporaryRoot -RepositoryLabel 'live public'
    )
    if ($remoteLines.Count -eq 0) {
      throw 'The live public repository exposes no auditable refs.'
    }

    $remoteRefs = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $remoteLines) {
      if ($line -notmatch '^(?<ObjectId>[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(?<RefName>refs\/.+)$') {
        throw 'The live public ref inventory contained an unparseable entry.'
      }
      if ($remoteRefs.ContainsKey($Matches.RefName)) {
        throw "The live public ref inventory contains duplicate ref '$($Matches.RefName)'."
      }
      $remoteRefs.Add($Matches.RefName, $Matches.ObjectId.ToLowerInvariant())
    }

    $unexpectedPublicRefs = @(
      $remoteRefs.Keys | Where-Object { $_ -notmatch '^refs\/(?:heads|tags|pull)\/.+$' }
    )
    if ($unexpectedPublicRefs.Count -gt 0) {
      throw "The live public repository exposes unsupported ref namespaces: $($unexpectedPublicRefs -join ', ')"
    }

    $expectedHeadRef = "refs/heads/$ExpectedBranch"
    $headRefs = @($remoteRefs.Keys | Where-Object { $_.StartsWith('refs/heads/', [System.StringComparison]::Ordinal) })
    if ($expectedHeadRef -cnotin $headRefs) {
      throw "The live public repository does not expose required branch '$expectedHeadRef'."
    }
    $tagRefs = @($remoteRefs.Keys | Where-Object { $_.StartsWith('refs/tags/', [System.StringComparison]::Ordinal) })
    $pullRefs = @($remoteRefs.Keys | Where-Object { $_.StartsWith('refs/pull/', [System.StringComparison]::Ordinal) })

    Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
      'init', '--bare', $auditPath
    ) -WorkingDirectory $temporaryRoot -FailureMessage 'The isolated public-history audit repository could not be initialized.' | Out-Null

    $advertisedRefListPath = Join-Path $auditPath 'advertised-public-refs.list'
    [System.IO.File]::WriteAllLines(
      $advertisedRefListPath,
      @($remoteRefs.Keys | Sort-Object),
      [System.Text.UTF8Encoding]::new($false)
    )
    Invoke-BalanceBookNativeCommand -FilePath $NodeExecutable -Arguments @(
      $privacyScript, '--file-list', $advertisedRefListPath, '--pattern-file', $protectedPatterns
    ) -WorkingDirectory $auditPath -FailureMessage 'The exact advertised public ref names failed protected privacy review.' | Out-Null

    Import-BalanceBookRemoteRefs -RepositoryUrl $RepositoryUrl -RemoteRefs $remoteRefs `
      -AuditRepositoryPath $auditPath -GitExecutable $GitExecutable `
      -WorkingDirectory $temporaryRoot -RepositoryLabel 'live public'

    $fetchedLines = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $auditPath, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/audit/original'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The isolated public ref set could not be inspected.'
    )
    $fetchedRefs = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $fetchedLines) {
      if ($line -notmatch '^(?<ObjectId>[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(?<AuditRef>refs\/audit\/original\/.+)$') {
        throw 'The isolated public ref inventory contained an unparseable entry.'
      }
      $originalRef = $Matches.AuditRef -replace '^refs/audit/original/', 'refs/'
      if ($fetchedRefs.ContainsKey($originalRef)) {
        throw "The isolated public ref inventory contains duplicate ref '$originalRef'."
      }
      $fetchedRefs.Add($originalRef, $Matches.ObjectId.ToLowerInvariant())
    }
    if ($fetchedRefs.Count -ne $remoteRefs.Count) {
      throw 'The isolated public ref inventory does not equal the live advertised ref inventory.'
    }
    foreach ($entry in $remoteRefs.GetEnumerator()) {
      if (-not $fetchedRefs.ContainsKey($entry.Key) -or $fetchedRefs[$entry.Key] -cne $entry.Value) {
        throw "The isolated object for live ref '$($entry.Key)' does not match its advertised object."
      }
    }

    $auditMainRef = "refs/audit/original/heads/$ExpectedBranch"
    $mainCommit = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $auditPath, 'rev-parse', "$auditMainRef^{commit}"
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The live public main commit could not be resolved.'
    )[0].Trim()
    $rootCount = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $auditPath, 'rev-list', '--max-parents=0', '--all', '--count'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The live public root history could not be counted.'
    )[0].Trim()
    if ($rootCount -ne '1') {
      throw "The live public history must descend from exactly one sanitized root; found '$rootCount'."
    }

    $allCommits = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $auditPath, 'rev-list', '--all'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The complete live public commit set could not be enumerated.'
    )
    # Public pull-request refs are expected to diverge from main. They remain fail-closed through
    # the one-sanitized-root check above, exact advertised-object fetch, complete history privacy
    # scan, and private-commit intersection check below. The required main branch remains the exact
    # reviewed source, and tags must still be ancestors of that branch.

    foreach ($tagRef in $tagRefs) {
      $auditTagRef = $tagRef -replace '^refs/', 'refs/audit/original/'
      $ancestorCheck = @(& $GitExecutable -C $auditPath merge-base --is-ancestor $auditTagRef $auditMainRef 2>&1)
      if ($LASTEXITCODE -ne 0) {
        throw "Live public tag '$tagRef' is not contained in the reviewed main history."
      }
    }

    $privateObjectLines = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $privateRoot, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'All local private objects could not be enumerated for intersection review.'
    )
    $privateLocalCommits = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $privateObjectLines) {
      if ($line -notmatch '^(?<ObjectId>[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(?<ObjectType>blob|commit|tag|tree)$') {
        throw 'The all-object local private inventory contained an unparseable entry.'
      }
      if ($Matches.ObjectType -eq 'commit') {
        $privateLocalCommits.Add($Matches.ObjectId.ToLowerInvariant())
      }
    }
    if ($privateLocalCommits.Count -eq 0) {
      throw 'The all-object local private inventory contained no commit objects.'
    }

    $privateRemoteLines = @(
      Get-BalanceBookRemoteRefLines -RepositoryUrl $PrivateRepositoryUrl `
        -GitExecutable $GitExecutable -WorkingDirectory $temporaryRoot -RepositoryLabel 'live private'
    )
    if ($privateRemoteLines.Count -eq 0) {
      throw 'The live private repository exposes no auditable refs.'
    }
    $privateRemoteRefs = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $privateRemoteLines) {
      if ($line -notmatch '^(?<ObjectId>[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(?<RefName>refs\/.+)$') {
        throw 'The live private ref inventory contained an unparseable entry.'
      }
      if ($privateRemoteRefs.ContainsKey($Matches.RefName)) {
        throw "The live private ref inventory contains duplicate ref '$($Matches.RefName)'."
      }
      $privateRemoteRefs.Add($Matches.RefName, $Matches.ObjectId.ToLowerInvariant())
    }
    Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
      'init', '--bare', $privateAuditPath
    ) -WorkingDirectory $temporaryRoot -FailureMessage 'The isolated private-history audit repository could not be initialized.' | Out-Null
    Import-BalanceBookRemoteRefs -RepositoryUrl $PrivateRepositoryUrl -RemoteRefs $privateRemoteRefs `
      -AuditRepositoryPath $privateAuditPath -GitExecutable $GitExecutable `
      -WorkingDirectory $temporaryRoot -RepositoryLabel 'live private'

    $privateFetchedLines = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $privateAuditPath, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/audit/original'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The isolated private ref set could not be inspected.'
    )
    $privateFetchedRefs = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $privateFetchedLines) {
      if ($line -notmatch '^(?<ObjectId>[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(?<AuditRef>refs\/audit\/original\/.+)$') {
        throw 'The isolated private ref inventory contained an unparseable entry.'
      }
      $originalRef = $Matches.AuditRef -replace '^refs/audit/original/', 'refs/'
      if ($privateFetchedRefs.ContainsKey($originalRef)) {
        throw "The isolated private ref inventory contains duplicate ref '$originalRef'."
      }
      $privateFetchedRefs.Add($originalRef, $Matches.ObjectId.ToLowerInvariant())
    }
    if ($privateFetchedRefs.Count -ne $privateRemoteRefs.Count) {
      throw 'The isolated private ref inventory does not equal the live advertised ref inventory.'
    }
    foreach ($entry in $privateRemoteRefs.GetEnumerator()) {
      if (-not $privateFetchedRefs.ContainsKey($entry.Key) -or $privateFetchedRefs[$entry.Key] -cne $entry.Value) {
        throw "The isolated object for live private ref '$($entry.Key)' does not match its advertised object."
      }
    }
    $privateRemoteCommits = @(
      Invoke-BalanceBookNativeCommand -FilePath $GitExecutable -Arguments @(
        '-C', $privateAuditPath, 'rev-list', '--all'
      ) -WorkingDirectory $temporaryRoot -FailureMessage 'The complete live private commit set could not be enumerated.'
    )
    $privateCommits = @((@($privateLocalCommits) + @($privateRemoteCommits)) | Sort-Object -Unique)
    if (@(Compare-Object $allCommits $privateCommits -IncludeEqual -ExcludeDifferent).Count -gt 0) {
      throw 'The live public ref set shares commit objects with private development history.'
    }

    Invoke-BalanceBookNativeCommand -FilePath $NodeExecutable -Arguments @(
      $privacyScript, '--history', '--pattern-file', $protectedPatterns
    ) -WorkingDirectory $auditPath -FailureMessage 'The exact live public ref set failed complete protected history privacy review.' | Out-Null

    [pscustomobject]@{
      MainCommit = $mainCommit
      RemoteRefCount = $remoteRefs.Count
      TagCount = $tagRefs.Count
      PullRefCount = $pullRefs.Count
      PrivateRemoteRefCount = $privateRemoteRefs.Count
      PrivateLocalCommitObjectCount = $privateLocalCommits.Count
      PrivateRemoteCommitCount = $privateRemoteCommits.Count
      RootCount = [int] $rootCount
      CompleteRefSetFetched = $true
      CompleteHistoryPrivacyPassed = $true
    }
  }
  finally {
    if (
      (Test-Path -LiteralPath $auditPath -PathType Container) -and
      $auditPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $auditPath).StartsWith('BalanceBookRemoteHistoryAudit-')
    ) {
      Remove-Item -LiteralPath $auditPath -Recurse -Force
    }
    if (
      (Test-Path -LiteralPath $privateAuditPath -PathType Container) -and
      $privateAuditPath.StartsWith(($temporaryRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $privateAuditPath).StartsWith('BalanceBookPrivateHistoryAudit-')
    ) {
      Remove-Item -LiteralPath $privateAuditPath -Recurse -Force
    }
  }
}
