# Security policy

Balance Book processes sensitive financial-planning data locally. Protecting that data takes priority over receiving a complete reproduction.

## Supported versions

See [docs/SUPPORTED_VERSIONS.md](docs/SUPPORTED_VERSIONS.md). Pre-release 0.x builds are
unsupported. Version 2.0.8 is the first supported Microsoft Store release; unsigned local or direct
channel candidates are not supported public distributions.

## Report a vulnerability privately

When private vulnerability reporting is enabled for the public repository, use the repository's **Security advisories** page and choose **Report a vulnerability**:

`https://github.com/15decesaremj/balance-book/security/advisories/new`

If that channel is unavailable, contact the repository owner privately through the owner's GitHub profile and request a secure reporting channel. Do not open a public issue, pull request, or discussion containing exploit details.

Include the affected version, Windows version and architecture, impact, minimal synthetic reproduction, and any suggested mitigation. Do not attach a real database, workbook, encrypted backup, plaintext export, account number, credential, password material, local user path, log, or screenshot containing private data.

Maintainers will acknowledge a valid private channel when available, investigate without requiring user data, coordinate a fix and disclosure date when appropriate, and credit the reporter if requested. No response-time or bounty commitment is made.

## In scope

- renderer sandbox, preload bridge, IPC validation, custom protocol, CSP, navigation, window, webview, permission, or Electron-fuse bypasses;
- cross-profile reads or writes, authentication bypass, password-verification flaws, or login-state weaknesses;
- backup confidentiality, authentication, key derivation, parser, restore-ownership, atomicity, or rollback flaws;
- import/export injection, unsafe path handling, or unintended disclosure;
- database migration, transaction, integrity, or profile-scoping defects;
- release artifact tampering, dependency compromise, signature-verification failure, or updater-identity confusion;
- financial-model defects that can systematically overstate safe spending or omit a known obligation.

## Security boundaries

The application uses Electron context isolation and sandboxing, disabled Node integration, a narrow typed preload bridge, sender-validated IPC, denied unexpected permissions/navigation/windows/webviews, hardened fuses, local profile ownership, password hashing, transactional SQLite migrations, and authenticated encrypted portable backups. It has no telemetry, bank connectivity, cloud backend, remote content, or money-movement capability.

The live SQLite database is not encrypted at rest. A local sign-in password protects access through the application but does not protect data from a Windows administrator, malware, a compromised or unlocked Windows account, memory inspection, or physical access to an unencrypted device. Plaintext JSON/CSV exports receive no application encryption. These are documented limitations, not vulnerabilities by themselves.

Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for assets, trust boundaries, controls, abuse cases, and residual risks.

## Safe research

Use only systems and synthetic data you own or have explicit permission to test. Avoid privacy violations, denial of service, destructive changes, social engineering, credential attacks, and access to another person's data. Stop and report privately if testing could expose real financial information.
