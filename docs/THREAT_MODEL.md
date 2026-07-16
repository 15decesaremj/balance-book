# Threat model

## Scope and security objective

Balance Book is a local-first Windows desktop application that stores sensitive financial-planning data for one or more local application profiles. Its primary security goals are to prevent unintended disclosure through the application or release process, preserve calculation and stored-data integrity, isolate local profiles, and make portable backups confidential and tamper-evident.

Balance Book does not claim to defend its live database from a Windows administrator, malware, an attacker controlling the same Windows account, an unlocked device, memory inspection, or physical access to an unencrypted disk. Windows account security, full-disk encryption, device updates, and safe backup storage remain required.

## Assets

- account, card, loan, income, receivable, asset, forecast, and scenario records;
- local password-verification material and failed-login state;
- audit history, import lineage, onboarding state, and policy settings;
- portable encrypted backups and plaintext exports;
- database integrity, migrations, and financial calculation semantics;
- installer, executable, dependency chain, update identity, and signing keys.

## Trust boundaries

1. **User and Windows session:** a person provides records, passwords, files, and decisions to a local process.
2. **Sandboxed renderer to preload/main:** untrusted renderer state crosses a narrow typed IPC bridge into privileged code.
3. **Main process to SQLite:** validated profile-scoped operations read and modify the local database.
4. **File selection and import/restore:** untrusted workbook, JSON, CSV, and encrypted-backup bytes enter through user-selected paths.
5. **Export and backup destinations:** sensitive output leaves the app-data directory for a user-selected filesystem location.
6. **Build and distribution:** source, dependencies, native modules, signing material, installer, and checksums move through the release workflow.

## Relevant attackers and failures

- a casual local user attempting to open another Balance Book profile;
- compromised or malicious renderer content attempting privileged IPC, navigation, window creation, or Node access;
- a crafted import or backup attempting parser abuse, path abuse, oversized input, invalid ownership, or partial replacement;
- a malicious spreadsheet value attempting formula execution when CSV is opened elsewhere;
- a stolen backup or accidentally published plaintext export;
- a dependency, build host, or release artifact compromised through the supply chain;
- power loss, disk error, interrupted migration, or interrupted backup creation;
- an incorrect financial rule that produces optimistic guidance despite valid data.

## Existing controls

- No telemetry, cloud backend, bank synchronization, advertising, remote content, or automatic money movement.
- Electron context isolation, renderer sandboxing, disabled Node integration, a narrow preload surface, typed and validated IPC, sender-origin validation, denied permission requests, denied unexpected navigation/new windows, denied webviews, a custom local application protocol, restrictive production CSP, and hardened Electron fuses.
- Profile ownership on database reads and writes, password hashing with per-password salt, login throttling, foreign keys, transactions, versioned migrations, WAL-consistent snapshots, and audit events.
- Exact integer-cent money handling, timezone-free financial dates, deterministic scheduling, conservative unknown-timing behavior, and tests across engine, domain, database, contracts, accessibility, and packaged application boundaries.
- Portable backups encrypted and authenticated with AES-256-GCM, scrypt key derivation, random salt and IV, strict envelope and size validation, atomic verified creation, graph validation, transactional replacement, ownership-conflict rejection, and pre-restore encrypted safety backup.
- CSV text that could be interpreted as a spreadsheet formula is escaped.
- Generated databases, workbooks, exports, backups, screenshots, signing files, and local release folders are ignored and rejected by privacy checks when tracked.
- Release signing hooks, stable update identity, checksum generation, and a fresh-install validation workflow.

## Residual risks

- The live SQLite database and local migration/safety copies are not encrypted at rest.
- A local sign-in password is an application privacy boundary, not an operating-system security boundary.
- A sufficiently strong backup password is essential; there is no recovery mechanism.
- Plaintext JSON/CSV exports receive no application encryption after creation.
- Privacy scanning cannot prove that source history, external caches, issue attachments, release assets, or screenshots are clean.
- Code signing does not make code safe; it identifies the signer and detects post-signing modification.
- Dependency advisories and license metadata change over time and require review for every release.
- Financial modeling defects can be safety defects. Spending-power output is guidance based on entered assumptions, not a guarantee that funds or credit will be available.

## Required abuse-case tests

- renderer attempts to call unexposed or malformed IPC;
- unexpected navigation, webview, window, and permission requests;
- cross-profile record reads, writes, imports, restore conflicts, and identifier collisions;
- wrong-password, truncated, modified, oversized, newer-schema, and structurally invalid backups;
- interruption during migration, backup creation, and restore;
- CSV cells beginning with formula-significant characters;
- path traversal and unsafe filenames in every file-producing flow;
- incomplete card timing, stale issuer snapshots, incorrect paid-in-full carrying state, underconstrained or contradictory loan facts, hidden maturity balloons, misclassified extra principal, double-counted transfers, uncertain receivables, and other cases that could overstate safe spending or understate debt;
- unsigned, wrongly signed, tampered, or checksum-mismatched release artifacts.

## Review triggers

Update this threat model before adding networking, bank connectivity, telemetry, remote content, auto-update, cloud backup, shared accounts, password recovery, new import formats, new cryptography, new native modules, a changed installer identity, or any feature that moves money or sends data off the device.
