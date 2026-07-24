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

The first submission uses the owner's verified Individual account as an acknowledged, good-faith
policy interpretation. Balance Book does not request or store financial account numbers, card
numbers, banking credentials, PINs, tax IDs, keys, or recovery phrases; connect to institutions;
initiate transactions; process payments; or transmit financial information. It calculates local
forecasts from arbitrary labels, amounts, dates, and assumptions entered manually by the user.

These facts must be stated accurately rather than used to evade Microsoft Store policies. If
Microsoft explicitly rejects the submission under policies 10.8.3 or 10.14 or requires a Company
account, treat that result as authoritative and preserve the documented Azure Artifact Signing
fallback. Do not create a paid Azure resource without explicit owner direction.

## Owner-only fields

The account owner must personally complete or confirm:

- Individual developer-account identity verification, Microsoft login, and MFA
- Legal declarations and submission certification
- Final age-rating questionnaire
- Availability markets and any export/compliance attestations presented by Partner Center
