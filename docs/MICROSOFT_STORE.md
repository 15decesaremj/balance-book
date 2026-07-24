# Microsoft Store release channel

Balance Book keeps two maintained Windows delivery channels:

- **Direct download:** the existing Squirrel build, separate `%APPDATA%\Balance Book` profile, and
  Balance Book GitHub update feed when enabled.
- **Microsoft Store:** an x64 MSIX/Desktop Bridge build, package-private
  `%APPDATA%\Balance Book Store` profile, Microsoft production signature, and Store-managed
  updates. The GitHub updater is compiled out of this channel.

The direct channel remains available until the Store transition is proven. Never install a local
self-signed MSIX as if it were a trusted public release.

## Account and policy gate

Microsoft currently charges no registration fee for either a new Individual or Company developer
account. The first submission uses the owner's verified **Individual** account as a deliberate,
good-faith attempt. Balance Book is a local-only manual planning tool: it does not connect to
financial institutions; request or store account numbers, card numbers, PINs, banking credentials,
tax IDs, API keys, private keys, or recovery phrases; initiate transactions; process payments; or
transmit financial information. Users create arbitrary labels and manually enter amounts, dates,
and planning assumptions. Data remains on the device unless the user explicitly creates an export.

This distinction is represented accurately in Partner Center; it must not be used to evade or
misstate Microsoft's rules. If Microsoft explicitly determines that policies 10.8.3 or 10.14
require a Company account for this application, treat that decision as authoritative and retain
Azure Artifact Signing as the documented fallback. Do not create paid Azure resources without the
owner's explicit direction.

Enrollment starts at <https://storedeveloper.microsoft.com/>. Microsoft login, MFA, identity
verification, age rating, legal declarations, and submission certification are owner-only gates.
Stop if Partner Center shows a charge; this project is intended to remain free.

Official references:

- [Open a developer account](https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account)
- [Microsoft Store policies](https://learn.microsoft.com/windows/apps/publish/store-policies)
- [Electron and MSIX packaging](https://learn.microsoft.com/windows/apps/dev-tools/winapp-cli/guides/electron-packaging)
- [Upload MSIX packages](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/upload-app-packages)

## Package identity

Partner Center is the only authority for production identity. After name reservation, copy the
exact package name, publisher, publisher display name, application ID, and 12-character product ID
into a Git-ignored identity file based on `store/identity.example.json`. Do not invent values.

Repository SemVer `X.Y.Z` maps deterministically to MSIX version `X.Y.Z.0`. The fourth segment is
reserved as zero. Every segment must fit 0 through 65535, and a production package requires a clean
tree. The workflow reads the current Partner Center submission and refuses a version that is not
newer than its highest package version.

Create a local isolated package:

```powershell
pnpm store:package:test
```

Create a production package after Partner Center identity is available:

```powershell
pnpm store:package -- -IdentityPath "<ignored Partner Center identity JSON>"
```

Outputs are generated under ignored `out\store\<version>\<configuration>\`. Production output
contains an unsigned `.msix` and a manually constructed `.msixupload`; Microsoft validates and
signs the accepted Store package. Metadata binds the package and upload hashes to the exact Git
commit, Git tree, lock-file hash, application version, MSIX version, identity, architecture, and
update channel.

Local-test packages use a transient self-signed certificate only to validate package construction.
The certificate is exported beside the ignored package and removed from the personal certificate
store after signing. For automated local testing, register the unpacked
`staging\AppxManifest.xml`; do not trust the self-signed certificate as a public publisher.

## Data transition

The direct edition stores its primary database at:

```text
%APPDATA%\Balance Book\balance-book.sqlite
```

The Store edition requests:

```text
%APPDATA%\Balance Book Store\balance-book.sqlite
```

Windows redirects that Store path into the package's private AppData area. On first Store launch,
Windows lets the packaged app read the existing direct path as a legacy fallback. Balance Book then:

1. verifies the legacy SQLite database;
2. creates a consistent timestamped SQLite recovery snapshot;
3. journals the migration as started;
4. copies and verifies the snapshot into the Store profile;
5. copies migration and update recovery directories;
6. marks the journal complete.

It never moves or edits the legacy database, never overwrites an existing Store database, verifies
hashes before recovering an interrupted migration, and can repeat safely. Profile names, salted
password verifiers, preferences, audit history, and financial records are all in the copied
database. User-selected exports and portable backups remain at their selected paths.

Microsoft Store package **updates** preserve package-private application data. Uninstall or package
reset can remove Store-private data. The privacy policy and user documentation therefore require an
encrypted portable backup before uninstall or reset. The direct profile remains separate and
recoverable after the first Store migration.

## First submission

The first application and listing are a Partner Center bootstrap and are not performed by the
automated update workflow:

1. Complete the owner's Individual enrollment and identity verification.
2. Reserve `Balance Book`.
3. Copy the exact Partner Center product and package identity into the ignored build configuration.
4. Use the verified text in `store/listing` and synthetic-only screenshots generated under
   `out\store\listing\screenshots`.
5. Confirm the product is free.
6. Upload the clean, validated `.msixupload`.
7. Complete owner-only age rating and legal declarations.
8. Submit and retain the submission ID, source commit, version, and package hash.

The repository privacy gate intentionally rejects committed PNG/JPG files. Never weaken it for
Store images; upload only reviewed synthetic screenshots directly to Partner Center.

## Future one-action publication

The protected GitHub environment is `microsoft-store`. Configure these encrypted secrets:

- `STORE_TENANT_ID`
- `STORE_SELLER_ID`
- `STORE_CLIENT_ID`
- `STORE_CLIENT_SECRET`
- `STORE_PRODUCT_ID`

Configure these protected environment variables from Partner Center identity:

- `STORE_PACKAGE_NAME`
- `STORE_PUBLISHER`
- `STORE_PUBLISHER_DISPLAY_NAME`
- `STORE_APPLICATION_ID`

Associate the Microsoft Entra application with Partner Center and grant only the role needed to
manage application submissions. Record the client-secret expiration in the environment's private
operations record. Rotate it before expiry by creating a replacement, updating only
`STORE_CLIENT_SECRET`, running a private-flight read/publish check, and then revoking the old
secret. The current Store CLI supports a certificate alternative, but not GitHub OIDC federation;
the protected client secret is the simpler supported configuration today.

From GitHub:

1. Open **Actions**.
2. Open **Publish Balance Book to Microsoft Store**.
3. Choose **Run workflow** on the repository default branch (`main` in the public repository).
4. Enter the committed version and reviewed release notes.
5. Choose production or an existing private flight.
6. Confirm the rollout percentage and run.

Codex or an operator can start the same workflow with:

```powershell
gh workflow run publish-microsoft-store.yml `
  --repo 15decesaremj/balance-book `
  --ref main `
  -f version="<X.Y.Z>" `
  -f release_notes="<reviewed notes>" `
  -f destination="production" `
  -f flight_id="" `
  -f rollout_percentage="100"
```

The workflow is manual only. It requires the repository default branch, exact manifest versions, a
clean checkout, frozen dependencies, the complete repository release gate, exact Partner Center
identity, a newer package version, and the official Microsoft Store Developer CLI action pinned to
a reviewed commit. It builds the Store channel from that commit, records hashes and release notes,
submits the package, captures Partner Center status, and retains nonsecret evidence for 90 days.

To cancel an uncommitted production draft:

```powershell
msstore submission delete "<product ID>" --no-confirm
```

For a flight draft:

```powershell
msstore flights submission delete "<product ID>" "<flight ID>"
```

Use a private package flight for material updates when a customer group is configured. Production
supports a gradual rollout; inspect it before increasing exposure. Halt a defective flight rollout
with:

```powershell
msstore flights submission rollout halt "<product ID>" "<flight ID>"
```

Do not call a release published until Partner Center reports publication and the Store-delivered
package has been installed, launched, and checked against its source evidence.
