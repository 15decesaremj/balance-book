# Contributing to Balance Book

Thank you for helping improve Balance Book. Contributions are welcome when they preserve the project's local-first, privacy-first design and conservative financial behavior.

## Protect private data

Use synthetic data in issues, tests, screenshots, and pull requests. Never submit a real workbook, database, encrypted backup, plaintext export, account number, credential, financial amount, user directory, or screenshot containing personal information.

Run the privacy check before opening a pull request:

```powershell
pnpm privacy:check
```

The automated check is a guardrail, not proof that a change is safe to publish. Review the complete diff and any new binary or generated file yourself.

For a release or source-publication audit, create an optional `.privacy-patterns.local` file with one case-insensitive private name, identifier, or uniquely identifying value per line. Blank lines and lines beginning with `#` are ignored. The file is intentionally Git-ignored: keep it only on the review machine, never paste its contents into logs or pull requests, and run the privacy check again after the list is supplied. This strengthens current-tree review but does not inspect Git history, issue attachments, release assets, or external caches.

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue for a security flaw or include private financial data in a report.

## Development setup

The supported development environment uses Node.js 24, pnpm 11, and Windows x64.

```powershell
pnpm install --frozen-lockfile
pnpm start
```

Create a focused branch and keep unrelated changes out of the pull request. For a substantial feature or a change to financial semantics, open an issue first so the behavior and verification plan can be agreed on.

## Engineering expectations

- Store money as integer cents and use timezone-free calendar dates for financial scheduling.
- Preserve profile isolation on every read and write.
- Keep safe-spend guidance conservative. Unknown timing or incomplete obligations must not be converted into optimistic capacity.
- Keep the application local-only unless a separately reviewed proposal explicitly changes that boundary. Do not add telemetry, advertising, bank connectivity, remote content, or automatic money movement by default.
- Validate imported and restored data before it reaches the database.
- Include a migration, rollback consideration, and tests when stored data changes.
- Use clear, accessible controls and verify keyboard, narrow-screen, light-theme, and dark-theme behavior for user-facing changes.
- Update public documentation when behavior, security boundaries, installation, backup compatibility, or release procedures change.

## Verification

Run focused tests while developing, then the complete verification command before requesting review:

```powershell
pnpm verify
```

If a platform-specific check cannot run, state exactly what was and was not verified in the pull request. Do not describe a release, signature, accessibility conformance, or security assessment as complete without evidence.

## Pull requests

A useful pull request explains:

- the user problem and the chosen behavior;
- financial, privacy, migration, and compatibility implications;
- tests performed and their results;
- any remaining limitation or follow-up;
- whether documentation and synthetic fixtures changed.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
