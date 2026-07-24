# Supported versions

Balance Book uses semantic versioning for public releases.

| Release line | Status                         | Security and compatibility updates                 |
| ------------ | ------------------------------ | -------------------------------------------------- |
| 2.x          | Current V2 development line    | The latest published 2.x release will be supported |
| 1.x          | Prior development line         | Upgrade to the latest compatible 2.x release       |
| 0.x          | Pre-release development builds | Unsupported                                        |

No signed public binary has been published yet. Until one exists, a locally built V2 installer is a release candidate and not a supported public distribution. The public source and release automation may be available before the first signed beta.

After public launch, fixes will target the newest 2.x release. Older builds may be supported only long enough to install the next compatible update; the release notes will identify any exception or required migration path. Pre-release 0.x builds do not receive security fixes.

## Platform

The V2 desktop target is Windows 11 x64. Windows on ARM, 32-bit Windows, macOS, Linux, mobile platforms, and browser-hosted use are not supported. Automated Windows Server build jobs are engineering verification, not an end-user support claim.

Balance Book is local-first application software. Bank connections, cloud synchronization, multi-device live synchronization, automatic money movement, and remote support access are outside V2 support. Signed public builds may use the documented GitHub-hosted software-update feed; no financial or profile data is included in those requests.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md) and report vulnerabilities privately. Include the affected version and a synthetic or redacted reproduction. Never submit a real database, backup, export, workbook, credential, or financial record.
