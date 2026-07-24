# Releasing Balance Book

This runbook separates three different outcomes:

1. a two-binary local release candidate;
2. a private three-file owner handoff that includes an encrypted backup;
3. a signed public release containing no user data.

Only the third is a public software release. Building an installer does not establish signing, publication, security certification, or end-user trust.

Microsoft Store releases use the separate MSIX channel and Store-managed production signature
documented in [MICROSOFT_STORE.md](MICROSOFT_STORE.md). They do not replace or reuse the Squirrel
package identity, data directory, signing claims, or update feed described below.

## Release prerequisites

- Use a clean, reviewed source tree and the exact committed lock file.
- Confirm the root and desktop package versions match the intended SemVer version.
- Refuse to reuse a version or tag for different bytes. The current feature-release candidate is 2.0.8 and must not overwrite or rebuild an earlier artifact identity.
- Use the documented Node.js 24 and pnpm 11 toolchain.
- Update project state, supported versions, third-party notices, changelog/release notes, and any changed backup or migration documentation.
- Review dependency advisories and generate a production dependency-license inventory. Retain the exact result in [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md).
- Resolve every unknown or incompatible dependency license before public binary distribution.
- Keep certificate files, certificate passwords, backups, exports, databases, screenshots, and release working directories outside Git.
- Supply a machine-local `.privacy-patterns.local` review list for private names and unique identifiers. The file is ignored, must never be published, and supplements rather than replaces full history review.

## Source-publication gate

Do not make the existing development repository public merely because the current tree passes a privacy scan. The default scan covers the present tracked and staged tree. Publication additionally requires the fail-closed history mode, which rejects shallow repositories and scans every locally reachable path, blob, commit header/message, and annotated-tag message. Neither local mode alone proves the live GitHub ref set or release assets are clean.

The first public source release must be created as a sanitized, clean-history public mirror or orphan-root repository after an explicit history and artifact review. Preserve the original development repository privately. Verify the mirror independently, push only the intended release root, and inspect it from a fresh clone before changing repository visibility. Update every package, issue, homepage, support, and vulnerability-reporting URL to the public mirror, and pin external GitHub Actions to reviewed immutable commit SHAs before enabling the public workflow.

After the first private source commit is clean and reviewed, create the local one-root mirror without copying development history:

```powershell
pnpm public:mirror -- -Destination "C:\AI-Projects\balance-book-public"
```

The command refuses an existing destination, exports only tracked files, rejects prohibited private/generated paths, initializes only `main`, compares the exact Git tree, confirms one commit and zero inherited tags, runs the protected source and generic mirror privacy checks, and configures the intended public remote. It does not create the GitHub repository or publish anything by itself. Its upstream comparison is cached local evidence; the final checker queries GitHub live.

For every later version, update the existing clean-history public mirror without importing private Git objects:

```powershell
pnpm public:sync -- -Destination "C:\AI-Projects\balance-book-public"
```

The sync command requires clean private and public branches, one sanitized public root, expected remotes, protected source privacy, and generic export privacy. Outside the explicitly non-publishable local-candidate mode, it also enumerates every live public branch, tag, and pull-request ref, fetches their exact advertised objects into an isolated temporary repository, scans their complete metadata and file history, checks for private-commit intersection, and requires live private/public branch parity. It replaces only version-controlled public worktree files, creates a normal public commit when the reviewed tree changed, and verifies the resulting tree is byte-for-byte the reviewed private tree. If it stops after staging an update, inspect the public mirror and use Git to recover it before retrying; never copy private history into that repository.

## Build and verify

From a clean checkout:

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm privacy:check
pnpm release:windows
```

`pnpm release:windows` invokes `tools/build-windows-release.ps1`. It builds through the maintained Electron Forge workflow instead of relying on an ad hoc copy of an installer.

By default, the release script produces a two-binary candidate beneath `out\release-candidates\`. It does not claim that a private handoff is complete without an explicitly supplied backup path.

The default complete-handoff lane is strict. When `-BackupPath` names an existing encrypted portable backup, it creates `local-releases\Balance Book V<major> - <version>\` only from a clean tree after every release gate passes and both executables have valid Authenticode signatures. Its metadata and SHA-256 manifest remain outside the exact three-file folder under `local-releases\metadata\`. The backup is a private owner-transfer artifact and is never part of the public release.

For owner testing when signing or the network audit is unavailable, use the separately labelled local lane:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-windows-release.ps1 `
  -BackupPath "<encrypted .balancebook-backup path>" `
  -OfflineSquirrel `
  -LocalUnsignedCandidate `
  -AllowUnsigned
```

Add `-AllowDirty` only for a deliberately uncommitted local build. If an offline machine already has the frozen dependencies, `-SkipInstall` may be used; if the advisory service is unreachable, `-SkipAudit` may be used. Every skipped gate is written to external metadata, the result is marked `productionReady: false`, and the folder is named `local-releases\candidates\Balance Book V<major> - <version> - LOCAL UNSIGNED CANDIDATE\`. Other skip switches are for reassembling already tested artifacts, not substitutes for testing.

`-AllowUnsigned`, `-AllowDirty`, and skipped gates cannot produce a public-production handoff. Never rename a local unsigned candidate to hide its status or publish it as a trusted release.

## Signing

Forge reads the Windows signing inputs from `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`. These values are build-time secrets; never commit, print, archive, or place them beside a release.

For a public release:

1. Use a valid Authenticode certificate controlled by the publisher.
2. Timestamp signatures through the configured trusted signing flow.
3. Verify the installer, installed executable, and uninstaller helper with Windows signature tooling.
4. Require a `Valid` signature and the expected publisher identity. A merely present signature is insufficient.
5. Publish SHA-256 checksums from the reviewed artifact set.

If signing is absent, invalid, expired without a trusted timestamp, or attributed to the wrong publisher, stop the public release. Do not describe the file as signed or advise users to ignore SmartScreen.

## Installation validation

Automated packaged smoke is necessary but not sufficient. Before publication, validate on a fresh disposable Windows user or clean test machine:

1. Confirm no existing `%LOCALAPPDATA%\balance_book_mvp` installation or `%APPDATA%\Balance Book` data directory exists.
2. Install from the exact candidate artifact.
3. Launch from the installed shortcut and create a synthetic local identity and sign-in password.
4. Exercise onboarding, editing, forecast, card guidance, backup, restore, export, and guarded reset with synthetic data.
5. Create a paid-in-full synthetic card with statement history and current-cycle activity; verify total current balance is nonzero when appropriate while balance carrying remains zero. Then verify a partial or late payment carries only the unpaid amount.
6. Retire a card on a chosen effective date; verify purchases, new cycle openings, baselines, Spending Power, and advisor eligibility stop on that date while the final earlier cycle, debt, history, and payoff cash remain. Reactivate it and verify normal eligibility returns.
7. Create installment loans from complete terms and several partial-fact combinations. Verify calculated labels, exact-versus-approximate status, monthly and biweekly timing, fully amortizing and explicit balloon or bullet schedules, dated principal/interest allocation, maturity, and modeled payoff.
8. Record both a regular-draft override and an additional-principal payment. Verify only the latter accelerates debt payoff and reduces future interest, regular cash drafts remain scheduled, and cash, Loans, Refinance, Net Worth, and forecast outputs agree after restart.
9. Close and restart the application; verify data and login persistence.
10. Upgrade from every supported prior release, including the 1.0.0 candidate when applicable, and verify migrations through the current schema plus rollback evidence.
11. Run the uninstaller helper interactively; confirm the program and shortcuts are removed while app data remains.
12. Reinstall and confirm the same profile and sign-in password still work.
13. Separately perform a clean-data restore using the encrypted portable backup and a different destination sign-in password.
14. Verify wrong-password, damaged-backup, newer-schema, and ownership-conflict failures do not partially replace data.
15. Check database integrity, exact 2.0.8 version identity, and packaged legal notices after every transition.

The installer-smoke mutation mode intentionally refuses a Windows profile that already has an installation or app-data directory. Use a disposable account rather than risking real data.

## Public artifact contents

A public GitHub release contains exactly the signed installer, signed uninstall helper, versioned full Squirrel `.nupkg`, `RELEASES`, `SHA256SUMS.txt`, `RELEASE-METADATA.json`, `README-FIRST.txt`, project license, and third-party notices. The `.nupkg` and `RELEASES` are machine-facing update assets and must never be presented as user installers. The installed application must also retain the project MIT License plus applicable Electron, Chromium, and dependency notices. A public release must not include an encrypted or plaintext user backup, export, database, workbook, log, screenshot with private data, signing material, archive, or the private three-file handoff folder.

After building and signing from the public mirror, assemble that exact nine-file set outside both repositories:

```powershell
pnpm public:release -- `
  -SetupPath "<signed Squirrel Setup.exe>" `
  -UninstallerPath "<signed uninstall helper.exe>" `
  -PackagedExecutablePath "<signed packaged Balance Book.exe>" `
  -SquirrelArtifactDirectory "<folder containing Setup, full.nupkg, and RELEASES>" `
  -BuildMetadataPath "<candidate metadata JSON emitted by release:windows>" `
  -OutputDirectory "C:\AI-Projects\Balance Book 2.0.8 - public release" `
  -ExpectedPublisher "<exact certificate subject>" `
  -ExpectedPublisherThumbprint "<certificate thumbprint>" `
  -Channel beta
```

The assembler refuses a dirty or non-`main` public tree, unsigned or wrong-version binaries, a wrong exact publisher subject or certificate thumbprint, missing timestamps, Squirrel package/setup/payload mismatches, an existing output directory, or an output path inside a repository. It emits canonical versioned filenames, an absolute immutable release URL in `RELEASES`, checksums for every other asset, and metadata binding the installer, uninstall helper, packaged executable, Squirrel package, channel, lock file, source commit, and source tree. Its metadata says only `artifactReady`; dependency, lifecycle, publication, and fresh-download gates still determine Published Status.

## Signed beta and update feed

The public clean-history repository owns two protected, manually dispatched workflows:

- `release-beta.yml` builds from `main` with updates enabled, imports the trusted Authenticode certificate only inside the protected `public-release` environment, runs the complete release gate, signs and timestamps the packaged application before Squirrel packaging, signs Setup and the uninstall helper, assembles and attests all nine assets, verifies a fresh draft download, publishes an immutable prerelease, then deploys only its `RELEASES` feed to GitHub Pages.
- `rollback-beta-feed.yml` accepts only an existing immutable beta tag, verifies the package SHA-1 and size named by its `RELEASES`, and redeploys that older feed. It never edits a release or creates new bytes. Squirrel does not downgrade an already newer installation.

The protected environment requires `WINDOWS_CERTIFICATE_PFX_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_EXPECTED_PUBLISHER`, and `WINDOWS_EXPECTED_PUBLISHER_THUMBPRINT`. Do not dispatch the beta workflow until immutable releases and GitHub Pages are enabled, those secrets identify a trusted timestamp-capable certificate, and a human reviewer approves the environment. An unsigned or self-signed bootstrap must not be published as the automatic-update starting point.

## Publish and record

After all gates pass:

1. Re-run the privacy and diff review on the exact public source mirror.
2. Create the version tag from the reviewed clean-history commit.
3. Upload only the verified artifacts and checksums.
4. Download the release into a fresh environment and repeat signature, checksum, install, launch, and uninstall checks.
5. Record toolchain versions, source commit, lock-file digest, artifact hashes, signing verification, test results, known limitations, and supported upgrade paths.
6. Update [PROJECT_STATE.md](PROJECT_STATE.md) and [PUBLIC_RELEASE_READINESS.md](PUBLIC_RELEASE_READINESS.md) with evidence. Do not mark a gate complete based on intent.
7. Run the following against the clean public checkout, using a new empty download path. Treat any failure as a publication blocker:

   ```powershell
   pnpm published:status -- `
     -PrivateRepositoryPath "C:\AI-Projects\balance-book-mvp" `
     -ReleaseDirectory "C:\AI-Projects\Balance Book - fresh public download" `
     -ExpectedPublisher "<exact certificate subject>" `
     -ExpectedPublisherThumbprint "<certificate thumbprint>" `
     -InstalledExecutable "<installed Balance Book.exe path>"
   ```

8. Leave File Explorer open to that freshly downloaded, software-only folder and give the owner the reversible uninstall/blank-onboarding instructions followed by direct GitHub installation steps.

The canonical owner-facing contract is [Published Status](PUBLISHED_STATUS.md). A private backup or complete three-file handoff must never be copied into the public downloads folder merely to make the handoff look complete.

## Rebuilding after edits

Make product changes in source, advance the package version intentionally, update migrations and documentation, and run this same workflow again. Never hand-copy a newer executable over an older release folder or reuse an artifact name with different bytes. The installed app's stable internal identity remains `balance_book_mvp`; the user-facing filename and version distinguish releases.
