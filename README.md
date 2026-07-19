# Balance Book

Balance Book is a local-first Windows desktop application for answering everyday financial-planning questions from one editable, dated ledger:

- How much can I safely add to each card?
- When and in which account will cash reach its lowest point?
- Will a bill or card payment require a transfer, and when should it start?
- Which card best fits a planned purchase after statement timing, available cash, and rewards are considered?
- How would a raise, bonus, recurring income change, bill, loan, receivable, or account buffer affect the forecast?

The application is designed for conservative guidance, not available-credit maximization. Every cash account can have a hard minimum, preferred buffer, liquidity role, and transfer timing. Cards keep coming-due statement obligations, current-cycle activity, future baseline assumptions, and history as separate facts. Forecasts, funding actions, scenarios, loans, assets, receivables, net worth, and reconciliation use the same native records.

Balance Book is planning software, not a bank, lender, credit decision, or substitute for individualized financial advice. Its guidance depends on the completeness and timing of the records and assumptions entered by the user.

## Local-first by design

- Data is stored in a local SQLite database.
- There is no telemetry, advertising, cloud backend, bank connection, remote content, or automatic money movement.
- Multiple application profiles are isolated by ownership checks and local passwords.
- Portable V2 backups are password-encrypted and can be restored under a different local sign-in identity.
- JSON/CSV exports are plaintext and are intended for private analysis, not recovery.

The local sign-in password is an application privacy boundary. The live database is not encrypted at rest and is not protected from a Windows administrator, malware, or another process running as the same Windows user. See [SECURITY.md](SECURITY.md) and the [threat model](docs/THREAT_MODEL.md).

## V1 capabilities

- Daily expected and protected cash forecasts by account and in total
- Reconciled total-position Spending Power by card, with separate cash/account funding guidance
- Statement, cycle, payment-policy, reward, and historical card records
- A per-card revolving-debt view that keeps statement due, current-cycle activity, total current balance, available credit, and balance carrying separate; a paid-in-full card can retain statement history while carrying zero
- Effective-dated card and line-of-credit retirement/reactivation: new spending and Spending Power stop on the closure date while existing debt, final statements, payment cash, and history remain visible
- Flexible installment-loan setup from complete or partial lender facts, with labeled calculations, monthly or biweekly amortization, fully amortizing and balloon/bullet structures, dated principal/interest allocation, projected payoff, and separate total-cash-versus-debt-service amounts
- Explicit regular-draft overrides and additional-principal payments, with extra principal reducing debt, interest, and payoff timing without replacing the normal draft
- Editable income, raise, bonus, bill, transfer, loan, receivable, asset, and guardrail surfaces, including atomic split-paycheck routing with preserved destination order and per-account early-deposit timing
- Effective-dated committed refinance planning for one or multiple payoff loans, with separate closing, payoff, and first-payment dates; financed and cash-paid fees; bank cash contributions and excess-proceeds routing; automatic secured-asset carry-forward; reversible pre-close cancellation; durable history; and later stacked refinances
- Timed funding recommendations that account for transfer lead times and protected source capacity
- Individual and combined what-if scenarios
- Contractual, economic, and liquid-position net-worth views
- Forecast-versus-actual reconciliation and audit history
- Guided onboarding plus an advanced canonical Financial Records library
- Validated local import, encrypted backup/restore, and private export, including committed refinance plans, immutable offer snapshots, and payoff/collateral lineage
- Dark-first responsive interface with keyboard and automated accessibility coverage

## Install

The 1.1.2 V1 feature line targets Windows 11 x64. The installer is self-contained; end users do not need development tools or a separate database server.

No signed public binary is claimed yet. Local unsigned Squirrel candidates have been built and tested on the owner's Windows profile, but they remain owner-testing artifacts rather than public releases. An unsigned installer may trigger Windows SmartScreen or **Unknown publisher**. Public distribution remains gated on valid Authenticode signing, a sanitized clean-history remote source mirror, fresh-disposable-profile lifecycle testing, and the checklist in [PUBLIC_RELEASE_READINESS.md](docs/PUBLIC_RELEASE_READINESS.md).

Read [INSTALLATION.md](docs/INSTALLATION.md) before installing or upgrading. Read [BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) before moving data to another machine.

The project uses [Published Status](docs/PUBLISHED_STATUS.md) as its repeatable publication handoff. It covers repository synchronization, the sanitized public mirror, release artifacts, independent download verification, a safe File Explorer handoff, and uninstall-first instructions for testing blank onboarding. Until that workflow reports `READY`, do not treat a local installer as a current public download.

## Development

Requirements: Node.js 24, pnpm 11, and Windows x64 for desktop packaging.

```powershell
pnpm install --frozen-lockfile
pnpm start
```

Useful commands:

```powershell
pnpm verify           # formatting, lint, types, tests, privacy, package, and Electron checks
pnpm privacy:check    # scan the current tracked tree for prohibited private content
pnpm build            # create an unpacked Windows application under out/
pnpm make             # create Electron Forge installer and ZIP artifacts
pnpm release:windows  # run the maintained V1 Windows release workflow
```

The calculation engine, domain rules, database, and renderer are separate workspace packages. Financial behavior uses exact integer cents and timezone-free calendar dates. The spreadsheet importer is optional local onboarding tooling; application calculations do not depend on a spreadsheet at runtime.

## Backups and releases

Normal uninstall preserves `%APPDATA%\Balance Book`, including local profiles and password-verification material. Reinstalling under the same Windows account therefore keeps the same local login and data. A new machine uses a new local identity and password, then restores a separately password-encrypted portable backup.

The local release workflow can create a private three-file transfer folder containing an installer, an uninstall helper, and one encrypted backup. That folder is ignored and must never be published because it contains user data. Public releases contain reviewed software artifacts and checksums only. See [RELEASING.md](docs/RELEASING.md).

## Contributing and support

Use synthetic data only. Never submit a real database, workbook, backup, export, account number, credential, local path, or private screenshot.

- [Contributing guide](CONTRIBUTING.md)
- [Support policy](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Supported versions](docs/SUPPORTED_VERSIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Financial model](docs/FINANCIAL_MODEL.md)

Balance Book is licensed under the [MIT License](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
