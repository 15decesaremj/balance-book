# Public release readiness

This checklist governs public source visibility and public Windows binary distribution. A local working installer is not, by itself, a public release.

The owner-facing execution and handoff contract is [Published Status](PUBLISHED_STATUS.md). Its checker fails closed when repository, release, artifact, signature, or download evidence is missing.

## Non-negotiable publication rule

The existing development repository must not be switched directly to public. A current-tree privacy scan does not inspect every historical commit, tag, deleted blob, pull-request object, release asset, cache, or clone. Prior development history may contain private project context even when the present tree is clean.

Create a sanitized clean-history public mirror or orphan-root repository for V1, review its complete object set, clone it into a fresh directory, rerun all gates there, and publish only that mirror. Preserve the original development repository privately.

## Current source-tree status

| Area                                 | Status                                                 | Evidence or remaining gate                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project license                      | Implemented in source                                  | Full MIT License and contribution licensing statement are present                                                                                                                |
| Public governance                    | Implemented in source                                  | Contributing, conduct, support, issue forms, PR template, and Dependabot configuration are present                                                                               |
| Public product/security docs         | Implemented in source                                  | Installation, backup/restore, release, threat model, supported versions, and security policy are present                                                                         |
| Local-first boundaries               | Implemented and automated                              | No telemetry, cloud backend, bank sync, advertising, remote content, or money movement is intended                                                                               |
| Current-tree privacy guard           | Passed on the working candidate manifest               | The tracked and non-ignored candidate files passed the generic scanner; rerun on the exact commit and mirror with a separately held `.privacy-patterns.local` review list        |
| Historical privacy                   | Not cleared                                            | Requires the clean-history public mirror and fresh-clone review described above                                                                                                  |
| Current 1.1 source gate              | Local automated checks passed; full gate incomplete    | The intended public tree passed 463 synthetic tests across 43 files; the baseline package smoke passed; restricted process creation blocked the full Playwright Electron journey |
| Release version identity             | Implemented; unsigned local artifact built             | Source manifests, offline Squirrel setup, application, and uninstall helper identify 1.1.0; exact signed-public artifact and tag agreement remain pending                        |
| Portable backup V2                   | Source/adversarial baseline passed; artifact gate open | Cross-identity and adversarial source tests passed; the candidate's existing encrypted backup was not freshly decrypted or restored because its password was unavailable         |
| Windows release tooling              | Current 1.1 unsigned candidate built                   | The offline Windows x64 Squirrel setup and native uninstall helper were built and the packaged application passed smoke; fresh-profile install/upgrade/uninstall testing remains |
| Packaged legal notices               | Confirmed in package; installed gate pending           | The packaged 1.1 application contains the project MIT License and third-party notices; confirm all project/Electron/Chromium notices after fresh-profile installation            |
| Authenticode signing                 | Not complete                                           | Signing hooks exist, but a real certificate, trusted timestamp, and `Valid` installer/executable/helper signatures must be verified                                              |
| Dependency security                  | Passed for the current exact lock file                 | `pnpm audit --prod` reported no known vulnerabilities on 2026-07-16; rerun if the lock file changes or publication is deferred                                                   |
| Dependency licenses                  | Reviewed for the current exact lock file               | The 245-entry production inventory and sole metadata ambiguity, `buffers@0.1.1`, are recorded in [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md)                                    |
| Clean install and upgrade            | Not complete                                           | Test exact artifacts on a fresh disposable Windows user, supported upgrade paths, uninstall, preserved-data reinstall, and clean restore                                         |
| Vulnerability intake                 | Not enabled/verified                                   | Enable GitHub private vulnerability reporting in the public mirror and test the reporting link                                                                                   |
| Public source and binary publication | Not performed                                          | Create the mirror, tag only the reviewed commit, and upload only signed user-data-free artifacts                                                                                 |

No row should be marked complete based only on code presence or an earlier build. Record the exact source commit, toolchain, lock-file digest, artifact hashes, signature output, and test evidence.

## Source-release gates

1. Build the sanitized clean-history mirror from reviewed V1 source only.
2. Confirm the mirror contains no private names, paths, values, databases, workbooks, backups, exports, screenshots, credentials, signing files, ignored local artifacts, or generated release folders. Supply `.privacy-patterns.local` from a separately protected review list; never add that file to the mirror.
3. Run `pnpm install --frozen-lockfile`, `pnpm verify`, and `pnpm privacy:check` from a fresh clone.
4. Inspect all Git objects, tags, branches, release assets, issue templates, links, repository metadata, and default-branch protections. A clean filename scan alone is insufficient.
5. Confirm MIT ownership is appropriate for every original file and preserve every third-party license and notice.
6. Enable private vulnerability reporting, Dependabot, secret scanning where available, protected review, and least-privilege release access.
7. Replace or verify repository, issue, homepage, security-advisory, support, and contact URLs so every public link targets the sanitized mirror rather than the private development repository.
8. Pin third-party GitHub Actions to reviewed immutable commit SHAs, retain least-privilege workflow permissions, and keep automated dependency updates enabled.
9. Publish documentation that accurately states platform support, data retention, security boundaries, and the absence of network services.

## Public-binary gates

1. Review and archive the exact production dependency-license inventory, including the documented external MIT evidence for `buffers@0.1.1`. This is recorded for the current lock file in [DEPENDENCY_REVIEW.md](DEPENDENCY_REVIEW.md); repeat it if the lock changes.
2. Run dependency-advisory review and document accepted residual risk. The current lock file reported no known vulnerabilities on 2026-07-16; repeat the audit if publication is deferred or the lock changes.
3. Build from the reviewed mirror and exact lock file using the repeatable workflow in [RELEASING.md](RELEASING.md).
4. Sign and timestamp the installer, installed executable, and native uninstall helper with the expected publisher identity.
5. Verify valid signatures and SHA-256 hashes independently after upload and download.
6. Confirm the project MIT License, third-party notices, Electron license, and Chromium notices are present in the exact installed artifact and portable archive.
7. Complete fresh-user installation, first run, functional use, restart, supported upgrade, uninstall, preserved-data reinstall, and clean-data restore testing.
8. Exercise the 1.1 debt paths after installation: paid-in-full and carried card state, retirement/reactivation, partial loan setup, fully amortizing and balloon schedules, regular-versus-extra-principal payments, payoff dates, forecast cash, and net worth.
9. Confirm no installer, application, shortcut, backup, export, or uninstaller action exposes or destroys data unexpectedly.
10. Publish release notes with changes, migrations, known limitations, backup compatibility, supported versions, checksums, and rollback guidance.

## Private handoff is never a public asset

The local three-file handoff contains a password-encrypted user backup. Encryption reduces exposure if the file is stolen, but the file is still private user data. The entire folder is ignored and prohibited from commits and public release uploads. A public release contains software, notices, checksums, and release notes only.

## Deferred capabilities

Auto-update, cloud backup, crash reporting, bank connectivity, mobile access, remote support, password recovery, and automatic money movement are not V1 release requirements. Adding any of them requires a new product, privacy, security, retention, consent, and threat-model review. Do not add connectivity merely to satisfy a packaging milestone.

No formal WCAG conformance, security certification, financial-advice approval, or legal clearance is claimed. Automated accessibility and security controls are engineering evidence, not external certification.
