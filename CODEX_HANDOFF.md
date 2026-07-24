# Balance Book 2.0.5 handoff

Updated: 2026-07-23

## Authoritative state

- Repository: `C:\AI-Projects\balance-book-mvp`
- Branch: `master`
- Authoritative product commit: `682686005f6f5bc223c73be71d2ef7e5c3b5b4fd`
- Product tree: `e4111fe4b0ca0b9ab1239f886d082f9853c7d7eb`
- Source and installed version: `2.0.5`
- Schema: `35`
- Installed executable: `%LOCALAPPDATA%\balance_book_mvp\app-2.0.5\BalanceBook.exe`
- Owner candidate: `out\release-candidates\Balance Book V2 - 2.0.5\`

Do not rebuild 2.0.5 with different bytes. Any product change must advance the version.

## What changed

- Accounts now includes **Bills & subscriptions** over the existing recurring cash-event records. Users can edit the name, amount, next date, cadence, end date, certainty, payment source, active status, and notes.
- Card bills default to already included in the entered cycle total. An explicit option adds new card activity on each billing date. Reimbursable and shared options create linked, occurrence-dated Money Owed without creating bank cash before receipt.
- Cash Forecast adds Net worth as its fifth series. Investment assets accept expected annual return, fixed monthly contributions, gross-pay-based personal contributions, and employer match assumptions without reducing take-home cash a second time.
- The financial center keeps one fixed geometry across Notices, Bills, and Balances, with a sliding segmented control, directional content motion, contained unread markers, wrapping right-side labels, and retained rounded/textured bill and balance cards.
- Setup heading geometry and route-wide spacing were hardened. High-traffic labels now use shorter consumer-facing terms such as Cash Forecast, Recurring Plan, Credit Cards, Money Owed, protected minimum, preferred buffer, and balance check.

## Verification

- `pnpm verify`: passed.
- Formatting, lint, strict type checking, native SQLite rebuild: passed.
- Vitest: 691 tests across 72 files passed; none skipped.
- Privacy scan: 215 tracked/staged files passed.
- Production package and packaged Electron journey: passed.
- The journey verifies bills, linked Money Owed, exact card-settlement deltas, investment input/readback, Net worth forecast output, source tracing, Overview balance/card edits, existing refinance behavior, notification motion and geometry, Setup heading layout, serious/critical accessibility, and every authenticated route at 1440, 1121, 1120, 900, 520, 430, 360, and 320 pixels.
- Production dependency audit: no known vulnerabilities.
- Packaged-app smoke: passed.

The gate fixes were test-hardening changes, not weakened assertions: settlement effects are checked on their owning card-payment date; loading surfaces and mutation saves have bounded ready waits; URL changes are observed outside the busy renderer; notification geometry is measured after its required animation completes; and the full route/width matrix loads each route once before resizing through all eight widths.

## Artifact and installation evidence

- Clean product commit: `682686005f6f5bc223c73be71d2ef7e5c3b5b4fd`
- Lock-file SHA-256: `C1A3FAB48411CA4766973B22F49722826C796F34A68020FFA997B0F5184917FC`
- Setup SHA-256: `8B1169ADED5E50798C34BDD881BFE7D14BDB5F30F2D1E03197D43A3D6C0654C3`
- Squirrel package SHA-256: `98F2F7B4DB3AFF5BF9342DB7700DC8D386E860FDAB0175C0E6D07F7D809A081C`
- Native uninstaller SHA-256: `1DF43EAF3179A631584695F97FE7BFAE752A93DFE740CD6ECE055859953F658E`
- Packaged and installed executable SHA-256: `2AA2F5EB73D90A3CA7ADD75A4FBD16AFB9DF323E3A0D679B09FDA4817AC7895F`
- Installed Apps and file metadata both report `2.0.5`.
- Desktop and Start-menu shortcuts target the stable Squirrel launcher.
- Installed project, Electron/Chromium, and third-party notices are present.
- This is an unsigned local owner candidate, not a signed public release.
- No fresh encrypted owner backup was supplied, so this remains a two-file candidate rather than a complete private three-file handoff.

## Owner-data preservation

The 2.0.4 application was closed before upgrade. The live database was snapshotted at schema 34 with SQLite integrity `ok`. The pre-install and post-install/prelaunch snapshots are byte-identical.

After launching 2.0.5:

- schema: `35`
- new investment-assumption columns: present
- SQLite integrity: `ok`
- managed records in the owner profile: `152`
- credential fingerprint: unchanged
- financial fingerprint before the requested seed: unchanged
- profile identity: unchanged

The existing `Fidelity 401K` asset was then updated through the canonical audited asset path with a 10% expected annual return, 4% personal contribution, and 4% employer match. Exactly one asset audit event was added; no other asset changed, credentials stayed unchanged, the managed-record count stayed 152, and integrity remained `ok`.

Ignored safety evidence is under `local-release-work\2.0.5-install-safety-6826860\`.

## Remaining public-release gates

- Authenticode signing and trusted timestamping.
- Sanitized clean-history public mirror and exact public-source verification.
- Fresh disposable Windows-profile install, onboarding, restart, uninstall, preserved-data reinstall, and clean restore.
- Fresh encrypted private-backup handoff if the owner wants the three-file transfer set.

The verified 2.0.5 application is intentionally left open for owner inspection.
