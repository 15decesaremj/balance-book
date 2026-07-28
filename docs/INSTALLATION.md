# Installation

Balance Book is a self-contained, per-user Windows x64 desktop application. An end user does not need Node.js, pnpm, Python, Excel, a database server, or administrator access to run the installer.

## Release trust

The production Microsoft Store edition is signed, delivered, and updated by Microsoft. Install it
only from the [official Balance Book listing](https://apps.microsoft.com/detail/9PNHMXS2VV1S),
which identifies Matthew J DeCesare as the publisher.

A separate public direct-download release is expected to be Authenticode-signed and published with a
SHA-256 checksum. A locally produced direct-channel candidate may be unsigned. Windows can display
SmartScreen or **Unknown publisher** warnings for an unsigned file. Do not bypass a warning merely
because an installer has the Balance Book name.

## Install from Microsoft Store

1. Open the [official Microsoft Store listing](https://apps.microsoft.com/detail/9PNHMXS2VV1S).
2. Select **Download** or **View in Store**, then install **Balance Book** published by
   **Matthew J DeCesare**.
3. Launch Balance Book from the Start menu.
4. Select an existing migrated local profile or initialize one with a display name, username, and
   sign-in password of at least 12 characters.
5. If moving from another machine, restore the encrypted portable backup only after creating the
   new local identity. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

The Store edition updates through Microsoft Store. It does not use the direct channel's GitHub
updater.

## Install from a future signed direct release

When [Published Status](PUBLISHED_STATUS.md) is `READY`, a nontechnical installation starts from the [latest stable public release](https://github.com/15decesaremj/balance-book/releases/latest). Normal users download only the signed `Balance-Book-<version>-Setup.exe`; the other eight reviewed release assets are verification, legal, uninstall, and machine-update files. Do not mistake GitHub's automatically generated source archives or the `.nupkg` machine-update package for the installer. Published Status opens the already verified downloads folder; users can independently confirm signature validity and the exact publisher certificate thumbprint using the README's click-by-click steps.

1. Keep the installer and any portable backup in a private folder. A backup can contain sensitive financial data even though it is encrypted.
2. Run `Balance-Book-<version>-Setup.exe` from a verified public release. The numbered `1 - Install...` name is reserved for the separate private owner handoff described below.
3. Finish the per-user Squirrel installation. The stable internal installation identity is `balance_book_mvp`; it intentionally remains unchanged across major-version upgrades.
4. Launch Balance Book from the Start menu or desktop shortcut.
5. Select an existing local profile or initialize one by choosing a display name, username, and sign-in password of at least 12 characters.
6. If moving from another machine, restore the encrypted portable backup only after the new local identity and sign-in password have been created. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

Windows owns taskbar pinning. Pin the running application from its taskbar context menu if a persistent taskbar shortcut is wanted. Public installers must not silently modify a user's taskbar preferences.

## Where data is stored

The Store edition uses package-private application data managed by Windows. On first Store launch it
copies a verified existing direct profile into its separate Store profile without moving or editing
the direct source. The direct edition is installed beneath `%LOCALAPPDATA%\balance_book_mvp` and
stores its profile beneath `%APPDATA%\Balance Book`.

The local sign-in password protects access through the application. The live database is not encrypted at rest, so an operating-system administrator, malware, or another process running as the same Windows user may still read it. Use Windows account security and disk encryption for device-level protection.

## Upgrade

Microsoft Store updates preserve the Store edition's package-private profile. Create and verify an
encrypted portable backup before a package reset or uninstall.

For a direct-channel upgrade:

1. Create and verify an encrypted portable backup.
2. Close Balance Book.
3. Run the newer installer under the same Windows account.
4. Launch the application and confirm the intended direct-channel version, profile access, forecast,
   and recent records.
5. Review Cards and Loans: existing cards should remain active unless a closure was saved, legacy loans should default to fully amortizing, and prior loan-payment records should retain regular-draft behavior until explicitly reclassified as additional principal.

The stable Squirrel identity upgrades the existing application instead of installing a second copy. Database migrations run locally. Release validation must cover supported upgrade paths before publication.

## Uninstall and reinstall

Uninstall the Store edition with Windows **Installed apps**. Store uninstall or package reset can
remove the package-private Store profile, so create and verify an encrypted portable backup first.
An existing direct profile remains separate.

Uninstall the direct edition with Windows **Installed apps** or the public release helper
`Uninstall-Balance-Book-<version>.exe`. The private owner handoff uses the equivalent numbered name
`2 - Uninstall Balance Book.exe`. Direct uninstall removes the application and shortcuts but
deliberately preserves `%APPDATA%\Balance Book`.

To test a completely new direct-channel setup, first create an encrypted backup and wait for
**“Encrypted portable profile created and read-back verified.”** Then uninstall the direct edition,
open `%APPDATA%` in File Explorer, and rename the retained `Balance Book` folder to
`Balance Book - saved before onboarding test - YYYY-MM-DD` while Balance Book is closed. Renaming is
reversible and makes the next launch behave like a new customer without destroying the prior
profile. To restore later, close Balance Book, move the newly created test folder aside, and rename
the saved original folder back to exactly `Balance Book`; do not merge the folders.

## Private three-file handoff

The maintained Windows release tool can assemble a private transfer folder containing exactly:

1. `1 - Install Balance Book V<major> (<version>).exe`
2. `2 - Uninstall Balance Book.exe`
3. `3 - Balance Book V<major> Private Backup.balancebook-backup`

There are two deliberately separate destinations:

- `local-releases\Balance Book V<major> - <version>\` is the strict handoff path. It requires a clean tree, every release gate, and valid Authenticode signatures.
- `local-releases\candidates\Balance Book V<major> - <version> - LOCAL UNSIGNED CANDIDATE\` is the explicit owner-testing path. It requires `-LocalUnsignedCandidate`, `-OfflineSquirrel`, and `-AllowUnsigned`; its external metadata records every skipped gate and marks it not production-ready.

Both folders are ignored by Git. Neither complete three-file folder may be committed or attached to a public GitHub release because the third file contains user data. Public releases publish only reviewed application artifacts, notices, checksums, and release notes. Do not remove the `LOCAL UNSIGNED CANDIDATE` label or present that build as signed or production-ready.

## Troubleshooting

- **The app opens with existing data after reinstall:** this is expected because uninstall preserves the app-data folder.
- **A backup password does not work:** the backup password is separate from the local sign-in password. There is no password recovery mechanism.
- **The installer shows Unknown publisher:** it is unsigned or its signature is invalid. Stop; public releases are required to pass signature verification.
- **Two Start entries appear after installing from Store:** this is expected when the existing
  direct edition is intentionally retained during the transition. Store and direct profiles remain
  separate.
- **A second copy appears within the same channel:** stop and report the installer version and
  install path. Direct installers must retain the stable `balance_book_mvp` identity across major
  versions.

For the complete uninstall-first owner test and publication checklist, see [Published Status](PUBLISHED_STATUS.md).
