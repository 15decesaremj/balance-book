# Published Status

“Published Status” is the repeatable Balance Book publication and owner-handoff workflow. It is an execution request, not a request for a progress summary.

## Status labels

- `READY`: the private development repository and sanitized public mirror are current; all required checks passed; the public release is signed, downloadable, and independently install-tested.
- `BLOCKED`: any required repository, privacy, build, signing, publication, download, installation, or handoff condition is missing.

## Required outcome

1. The private development repository is clean and its default branch contains the reviewed product changes.
2. A separate public repository contains a single sanitized root history. The private repository, old tags, pull-request objects, deleted blobs, and development history remain private.
3. The public default branch, release tag, package versions, changelog, and release artifacts identify one exact source version.
4. Public links in package metadata, support, security, issue templates, installation documentation, and release notes point to the public mirror.
5. Formatting, lint, type checks, synthetic tests, privacy checks, dependency review, package smoke, and the complete Electron journey have current evidence from the public tree.
6. Public release assets are exactly the signed installer, signed uninstall helper, versioned full Squirrel `.nupkg`, `RELEASES`, `SHA256SUMS.txt`, `RELEASE-METADATA.json`, `README-FIRST.txt`, license, and third-party notices. The `.nupkg` and `RELEASES` are machine-facing update assets, not user installers. Release notes belong in the reviewed GitHub release body. The release never contains a workbook, database, export, screenshot, log, backup, certificate, signing secret, private handoff, archive, or local release metadata.
7. `READY` additionally requires valid Authenticode signatures from the expected publisher on the installer, installed executable, and uninstall helper.
8. The exact assets are downloaded again from GitHub, hashes and signatures are rechecked, and a disposable Windows profile completes install, launch, blank onboarding, restart, uninstall, preserved-data reinstall, and clean restore testing.
9. File Explorer is left open to a plainly named folder containing only the verified public downloads.
10. The final response starts with the reversible clean-start procedure below, followed by the GitHub installation procedure and honest status caveats.

## First: uninstall for blank onboarding

Normal uninstall intentionally preserves `%APPDATA%\Balance Book`. A reinstall therefore keeps the existing profiles and passwords unless that retained folder is moved aside.

Do this only after you have finished inspecting the currently installed app **and** Published Status is `READY` with a verified public installer available. When status is `BLOCKED`, keep the current installation in place.

1. In Balance Book, open **Settings**, create an encrypted portable backup, and wait for **“Encrypted portable profile created and read-back verified.”** That built-in read-back proves the password and file were verified without restoring over your data.
2. Close Balance Book completely.
3. Open Windows **Settings → Apps → Installed apps**.
4. Find **Balance Book**, open its three-dot menu, and choose **Uninstall**. The verified release-folder uninstall helper may be used instead.
5. Open File Explorer, type `%APPDATA%` in its address bar, and press Enter.
6. Rename the **Balance Book** folder to `Balance Book - saved before onboarding test - YYYY-MM-DD`. Do not delete it.
7. Reinstalling now should begin as a completely new customer.

To restore the original profile after the test, close Balance Book, move the newly created `%APPDATA%\Balance Book` test folder aside under a different name, and then rename the saved original folder back to exactly `Balance Book`. Never copy one folder over the other, because File Explorer can merge them. Reinstall or launch Balance Book only after the original name has been restored.

## Then: install from the public repository

These steps become active only after the complete Published Status workflow reports `READY` and the linked release has been downloaded and verified.

1. Open the [latest stable Balance Book release](https://github.com/15decesaremj/balance-book/releases/latest). Beta testers use the explicitly reviewed `v<version>-beta` prerelease link instead. Neither is an active install source until the matching Published Status run is `READY`.
2. Expand **Assets**.
3. For a normal install, download `Balance-Book-<version>-Setup.exe`. Published Status independently downloads and validates all nine reviewed assets: Setup, uninstall helper, the exact versioned `.nupkg`, `RELEASES`, `SHA256SUMS.txt`, `RELEASE-METADATA.json`, `README-FIRST.txt`, `LICENSE.txt`, and `THIRD_PARTY_NOTICES.txt`. Never run the `.nupkg` and do not use GitHub’s automatically generated **Source code** archives as the installer.
4. The Published Status handoff leaves File Explorer open to a folder freshly downloaded and checksum-checked by the release checker. Open `README-FIRST.txt` and note its exact publisher name and certificate thumbprint. Right-click the Setup file, choose **Properties → Digital Signatures**, select that exact publisher, choose **Details**, and confirm Windows says the signature is OK. Then choose **View Certificate → Details → Thumbprint** and compare it with the README value; display spaces and letter case do not matter. Stop if any identity differs, the signature is absent, or Windows blocks the installer.
5. Double-click the verified Setup file.
6. Launch Balance Book from the Start menu or desktop shortcut.
7. A blank installation should ask for a new local profile and a password of at least 12 characters, then begin guided onboarding.
8. If an old profile appears, close the app and confirm the retained `%APPDATA%\Balance Book` folder was renamed successfully.

## Mechanical check

Run:

```powershell
pnpm published:status -- `
  -PrivateRepositoryPath "C:\AI-Projects\balance-book-mvp" `
  -ReleaseDirectory "C:\AI-Projects\Balance Book - fresh public download" `
  -ExpectedPublisher "<exact certificate subject>" `
  -ExpectedPublisherThumbprint "<certificate thumbprint>" `
  -InstalledExecutable "<installed Balance Book.exe path>" `
  -Channel beta
```

The release directory must not already contain files: the checker downloads the exact GitHub assets itself, then compares names, sizes, hashes, versions, tag/commit identity, repository parity, privacy rules, full source verification, signatures, and versioned GitHub release notes. It reports only whether those automated gates passed. A pass is necessary but cannot by itself establish `READY`; the dependency/license and release-body review plus recorded disposable-profile lifecycle remain mandatory.
