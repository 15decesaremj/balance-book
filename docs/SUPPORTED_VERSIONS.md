# Supported versions

Balance Book uses semantic versioning for public releases.

| Release line | Status                               | Security and compatibility updates                 |
| ------------ | ------------------------------------ | -------------------------------------------------- |
| 2.x          | Current Microsoft Store release line | The latest published 2.x release will be supported |
| 1.x          | Prior development line               | Upgrade to the latest compatible 2.x release       |
| 0.x          | Pre-release development builds       | Unsupported                                        |

Version 2.0.8 is the first supported public Microsoft Store release. A locally built or unsigned
direct-channel installer remains a release candidate and is not a supported public distribution.
Version 2.0.9 is the current unsigned direct-channel owner beta: it is installed only for local
stability testing beside Store 2.0.8 and is not published as a binary or offered through an update
feed.

After public launch, fixes will target the newest 2.x release. Older builds may be supported only long enough to install the next compatible update; the release notes will identify any exception or required migration path. Pre-release 0.x builds do not receive security fixes.

## Platform

The V2 desktop target is Windows x64 and requires Windows 10 version 1809 or later. Windows on ARM,
32-bit Windows, macOS, Linux, mobile platforms, and browser-hosted use are not supported. Automated
Windows Server build jobs are engineering verification, not an end-user support claim.

Balance Book is local-first application software. Bank connections, cloud synchronization,
multi-device live synchronization, automatic money movement, and remote support access are outside
V2 support. The Store edition receives software updates through Microsoft Store; a future signed
direct build may use the documented GitHub-hosted software-update feed. No financial or profile data
is included in software-update requests.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md) and report vulnerabilities privately. Include the affected version and a synthetic or redacted reproduction. Never submit a real database, backup, export, workbook, credential, or financial record.
