# Backup and restore

Balance Book has two different export paths. Choose the one that matches the goal.

- **Encrypted portable backup (`.balancebook-backup`)** is the supported way to move or recover an operating profile.
- **JSON/CSV export** is an unencrypted, human-readable analysis export. It is not a portable backup and must be protected like a plaintext financial document.

## Two independent passwords

The local sign-in password and encrypted-backup password serve different purposes:

- The **sign-in password** belongs to one local installation and is stored only as password-verification material. It is not exported.
- The **backup password** encrypts one portable backup. It is required to decrypt and restore that file.

They may be different and should be stored securely. Balance Book cannot recover either forgotten password.

## What portable backup V2 contains

Portable backup V2 preserves the selected profile's managed financial records, settings and guardrails, onboarding state, theme preference, audit events, import batches and lineage, source schema metadata, and record timestamps required for a faithful restore. Managed debt state includes card issuer snapshots and lifecycle dates, statement/payment history, loan amortization structure, contractual balloon, calculated-field lineage, classified regular/extra-principal payments, and committed refinance lineage. Money Owed state includes its received date, destination account, fixed recurrence or recurring-bill timing anchor and offset, accrual schedule, and linked settlement history.

It deliberately excludes sign-in password hashes and salts, failed-login state, reusable credentials, application binaries, and data belonging to another local profile. A restore therefore does not overwrite the destination profile's display name, username, or sign-in password.

The file is encrypted with AES-256-GCM using a key derived with scrypt from the supplied backup password. Each backup has a random salt and initialization vector. Creation uses an atomic temporary file, flush, decrypt-and-verify readback, and rename sequence. These controls reduce corruption risk but do not replace keeping multiple verified copies.

## Create a portable backup

1. Open **Settings** and choose the encrypted portable-backup action.
2. Choose a strong, unique backup password and enter it again for confirmation.
3. Save the `.balancebook-backup` file to a private location.
4. Confirm that the application reports successful verification.
5. Keep an additional copy on a separate trusted device or encrypted storage location.
6. Store the backup password separately from the backup file.

Do not rename the extension, edit the file, place the password in the filename, or commit the backup to source control. The application rejects an encrypted backup larger than 100 MiB.

## Restore on the same machine

1. Create a fresh encrypted backup of the current state before restoring.
2. Sign in to the destination profile.
3. In **Settings**, choose restore and select the `.balancebook-backup` file.
4. Enter that file's backup password, not necessarily the local sign-in password.
5. Review the restore summary and continue.
6. After restart, confirm accounts, forecast, card obligations and carrying status, card closures, loan balances/payoff structure, extra-principal records, receivables, settings, audit history, and recent lineage.

Before replacing data, Balance Book creates an encrypted safety backup under the application's `restore-safety` data directory using the supplied backup password. Restore validation occurs before the replacement transaction; a wrong password, damaged envelope, invalid record graph, unsupported newer schema, or conflicting cross-profile record identifier stops the restore.

## Restore on another machine

1. Transfer the installer and encrypted backup through a trusted channel.
2. Install Balance Book.
3. Initialize a local profile with the display name, username, and sign-in password wanted on the new machine.
4. Restore the encrypted backup using its separate backup password.
5. Restart the application and verify the restored data and forecast.

This design lets the destination use a new local sign-in password while retaining the portable financial state. If a record identifier already belongs to another profile on the destination, restore stops rather than merging ownership. Use a clean installation/profile or the original owning profile instead of forcing a merge.

## Compatibility

- V2 is the current portable format.
- Legacy encrypted V1 backups remain readable, but they contain only the earlier core record set and cannot recreate metadata that was never stored.
- A current application may reject backups from a newer database or backup schema. Upgrade the application instead of modifying the backup.
- There is no supported partial merge between two independently active profiles.

## Plaintext JSON/CSV export

JSON/CSV export creates a collision-free dated `Balance Book export <timestamp>` directory inside the folder selected by the user. It contains fixed JSON and CSV files intended for inspection or analysis. Spreadsheet-formula-leading text is escaped, but the files remain unencrypted.

Do not use plaintext export as the only recovery copy. Do not place it in a public folder, issue, email, or repository. Delete extra copies according to the user's own retention policy.

## Recovery checklist

If restore fails, preserve the original backup unchanged, verify that the correct backup password is being used, confirm the file was fully copied, and try the newest supported Balance Book version. Never send a real backup to a public support issue. Maintainers cannot decrypt a backup or reconstruct a forgotten password.
