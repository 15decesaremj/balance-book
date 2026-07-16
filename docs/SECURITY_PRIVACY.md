# Security and privacy

## Implemented controls

- Data remains local. The application has no network backend, analytics, advertising, bank connection, or money-movement integration.
- SQLite is stored in Electron's per-user application-data directory with foreign keys, WAL journaling, a busy timeout, versioned migrations, and transactional setup writes.
- Every financial row has a user ID. Repository reads and writes require the active user ID, and synthetic isolation tests prove that one profile cannot read another profile's records.
- First access requires a user-created 12-128 character password. Passwords use Node's scrypt with a unique random 128-bit salt and a 256-bit derived key; verification uses constant-time comparison. Failed attempts are counted locally and temporarily locked after five failures.
- Passwords and balances are absent from the profile chooser. Sensitive renderer state unmounts on logout. Authentication state exists only in Electron main-process memory.
- The renderer has no Node or database access. Context isolation and sandboxing are enabled, Node integration is disabled, permission requests and new windows are denied, and privileged IPC is allowlisted, sender-checked, and Zod-validated in both preload and main.
- Production content is served from a secure custom local protocol with a restrictive Content Security Policy. Remote content, webviews, arbitrary shell execution, and dynamic application code evaluation are not used.
- Electron fuses disable RunAsNode, Node options, and CLI inspector arguments and require ASAR integrity and ASAR-only application loading.
- The staged-file privacy guard rejects workbooks, databases, exports, backups, screenshots, local data, secrets, and credential material. Release reviewers can also supply a Git-ignored `.privacy-patterns.local` list of private names or unique identifiers without placing that list in source control.
- Portable backups use AES-256-GCM with a random salt/IV and scrypt-derived key. Authentication and full schema validation happen before transactional restore. JSON/CSV exports are explicitly unencrypted and user-selected.
- Database migrations create a local pre-migration copy before changing an existing schema. JSON import has a size limit, file-picker boundary, schema validation, active-user remapping, and transactional replacement.
- Material record edits, imports/restores, scenario conversion, settlements, transfers, reconciliation, and profile reset produce user-scoped audit evidence. Manual edits to imported destinations mark lineage conflicts.

## Honest limits

The local password protects casual in-application access; it does not protect against an operating-system administrator, malware running as the user, memory inspection, or physical access to an unlocked Windows session. The live V1 database is not fully encrypted. Unencrypted JSON/CSV exports need OS-level protection and safe deletion by the user.

Code signing, installer reputation, automatic updates, crash-reporting policy, external penetration testing, formal accessibility testing, and legal/support processes are later public-release gates.

## Verification

Synthetic tests cover unique password salts/hashes, the lockout boundary, migrations and pre-migration backup, transactions, audit creation, backup encryption and wrong-password failure, restore, active-profile reset, cross-profile isolation, IPC input schemas, and import conflict/idempotency behavior. Playwright covers first-use password setup, resumable onboarding, login/logout, persistence, profile switching, blank-profile isolation, complete-field editing, theme persistence, scenario/reconciliation/settings flows, and serious/critical axe findings in both dark and light themes. Packaged-app and privacy scans are release gates.
