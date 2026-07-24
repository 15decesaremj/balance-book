# Microsoft Store submission facts

These answers are based on the verified application and repository. Partner Center wording can
change; the account owner must review any legal attestation before submission.

## Product

- Product type: Windows desktop application packaged as MSIX/Desktop Bridge
- Distribution: Microsoft Store
- Pricing: Free
- In-app purchases: None
- Advertising: None
- Architecture: x64
- Minimum Windows version: 10.0.17763.0 (Windows 10 version 1809)
- Restricted capability: `runFullTrust` only, required for the existing Electron desktop process
- Network-required functionality: None
- Bank connectivity or money movement: None

## Data and privacy

- Financial information is entered by the user and stored locally in the per-user application data
  directory.
- No Balance Book backend, cloud profile, advertising SDK, application telemetry, or crash reporter
  is present.
- The Store build disables the direct GitHub update client.
- User-triggered external navigation is limited to the Microsoft Store product page and public
  privacy-policy page.
- Portable backups are encrypted with AES-256-GCM and a separately chosen password.
- JSON and CSV exports are unencrypted and explicitly user-selected.
- The live SQLite database is not full-database encrypted; this is disclosed in the privacy policy
  and in-app settings.

## Content and age-rating evidence

The application contains no violence, sexual content, profanity, controlled-substance content,
gambling, user-generated online content, social network, location sharing, or in-app purchases.
The account owner must make the final age-rating declaration in Partner Center.

## Account-policy constraint

Microsoft Store policy 10.8.3 and the individual-account limitation in policy 10.14 require a
Company developer account when an application's primary functionality requires financial account
information. Balance Book must not be enrolled or described as an Individual-account financial
app merely to follow an older enrollment assumption.

## Owner-only fields

The account owner must personally complete or confirm:

- Company developer-account identity and business verification
- Microsoft login and MFA
- Legal declarations and submission certification
- Final age-rating questionnaire
- Availability markets and any export/compliance attestations presented by Partner Center
