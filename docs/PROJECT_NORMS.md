# Project norms

## Product invariants

- Balance Book is local-first. Networking, telemetry, bank connectivity, remote content, advertising, cloud storage, and automatic money movement require an explicit new design and security review.
- Store money as integer cents and represent financial schedule dates without timezone conversion.
- Scope every persistent read and write to its owning local profile.
- Safe-spend output is conservative. Unknown timing, incomplete obligations, or unavailable funding must not become optimistic capacity.
- Spreadsheet import is optional onboarding evidence, not a runtime calculation engine.
- The advanced Financial Records library is the canonical record surface; guided pages must update the same records rather than create shadow state.

## Source and privacy

- Source, tests, examples, screenshots, issues, and pull requests use synthetic data only.
- Never commit databases, workbooks, encrypted backups, plaintext exports, credentials, signing files, generated release folders, private screenshots, or local user paths.
- Run `pnpm privacy:check`, inspect the complete diff, and examine every new binary before review. Automated scanning is not proof that history or external artifacts are clean.
- Security reports use the private process in [SECURITY.md](../SECURITY.md).

## Development

- Node.js 24 and pnpm 11 are the supported toolchain.
- Keep the lock file deterministic and dependency versions intentional.
- Use strict TypeScript, ESLint, Prettier, Vitest, Playwright/Electron tests, and a single `pnpm verify` release baseline.
- Diagnose uncertain behavior before changing financial logic. Add focused regression tests with the fix.
- Database changes require a versioned migration, transaction and rollback consideration, synthetic migration fixtures, and compatibility documentation.
- User-facing changes include keyboard, responsive, light-theme, dark-theme, and serious/critical accessibility verification where applicable.

## Change and review discipline

- Keep branches and pull requests focused; do not combine unrelated cleanup with behavioral changes.
- Explain the user decision affected, financial and privacy implications, stored-data compatibility, and verification evidence.
- Update documentation in the same change when behavior, boundaries, release steps, backup format, or supported versions change.
- Do not claim release signing, publication, external audit, accessibility conformance, or legal clearance without verifiable evidence.

## Release discipline

- Follow [RELEASING.md](RELEASING.md) from a clean checkout and exact lock file.
- Keep the stable Windows installation identity `balance_book_mvp` across compatible V1 upgrades.
- An unsigned installer is a local test candidate, not a public release.
- The first public source version must come from a sanitized clean-history mirror. Passing a current-tree privacy scan is insufficient reason to change an existing repository's visibility.
- Never publish a private three-file handoff or any backup. Public artifacts contain reviewed software, notices, checksums, and release notes only.
