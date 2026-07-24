# Balance Book privacy policy

Effective July 24, 2026

Balance Book is a local-first Windows personal-finance application. It does not require a Balance
Book cloud account, connect to a bank, move money, serve advertising, or include application
analytics, telemetry, or crash reporting.

## Information Balance Book handles

Balance Book stores the information you choose to enter, which may include account names and
balances, income, bills, credit-card and loan details, assets, receivables, forecasts, notes,
settings, and audit history. It also stores a local profile name and username, a salted scrypt
password verifier, and local sign-in lockout state.

This information is stored on your Windows device in the application's per-user data directory.
The live SQLite database is not full-database encrypted. The app password limits access through the
application, but it does not protect against an operating-system administrator, malware running as
you, or access to an unlocked Windows account. Windows device encryption, a strong Windows sign-in,
and normal malware protection remain important.

## Collection and sharing

Balance Book does not send the financial information you enter to the project maintainers or to a
Balance Book server. There is no Balance Book server.

The application accesses the network only for these user-visible or distribution functions:

- Microsoft Store installs and updates the Store edition under Microsoft's terms and privacy
  practices.
- The direct-download edition may contact the published Balance Book update feed when update checks
  are enabled.
- A link you deliberately open, such as this privacy policy, opens in your default browser.

Balance Book does not sell or share your financial information for advertising or profiling.

## Backups, exports, and imports

You control every backup, export, and import. Portable `.balancebook-backup` files are encrypted
with AES-256-GCM using a key derived with scrypt from the separate backup password you choose.
JSON and CSV exports are not encrypted. Files you save remain wherever you place them and are
outside the application's deletion controls.

## Retention and deletion

Your data remains on your device until you reset the active profile, remove the applicable local
data, or Windows removes it as part of package uninstall or reset behavior. Microsoft Store updates
preserve the Store package's local application data. Uninstalling the Store package can remove its
package-private data, so create an encrypted portable backup before uninstalling or resetting the
app. The direct-download uninstaller is designed to leave its separate application-data directory
in place so a later reinstall can recover it.

## Support and privacy requests

Support is available through the
[Balance Book issue tracker](https://github.com/15decesaremj/balance-book/issues). Do not post
financial records, passwords, backup files, identity documents, or other sensitive personal
information in a public issue.

Because Balance Book has no service that receives your financial information, the project
maintainers generally cannot retrieve, correct, or delete the information stored on your device.
The in-app Settings and data tools provide local review, export, reset, and restore controls.

## Changes

Material changes to this policy will be documented with the corresponding application release.
