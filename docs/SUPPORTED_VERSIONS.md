# Supported versions

Balance Book uses semantic versioning for public releases.

| Release line | Status                         | Security and compatibility updates                 |
| ------------ | ------------------------------ | -------------------------------------------------- |
| 1.x          | Current V1 development line    | The latest published 1.x release will be supported |
| 0.x          | Pre-release development builds | Unsupported                                        |

No signed public binary has been published yet. Until one exists, a locally built V1 installer is a release candidate and not a supported public distribution.

After public launch, fixes will target the newest 1.x release. Older 1.x builds may be supported only long enough to install the next compatible update; the release notes will identify any exception or required migration path. Pre-release 0.x builds do not receive security fixes.

## Platform

The V1 desktop target is Windows 11 x64. Windows on ARM, 32-bit Windows, macOS, Linux, mobile platforms, and browser-hosted use are not supported. Automated Windows Server build jobs are engineering verification, not an end-user support claim.

Balance Book is offline application software. Bank connections, cloud synchronization, multi-device live synchronization, automatic money movement, and remote support access are outside V1 support.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md) and report vulnerabilities privately. Include the affected version and a synthetic or redacted reproduction. Never submit a real database, backup, export, workbook, credential, or financial record.
