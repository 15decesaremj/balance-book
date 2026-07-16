# Balance Book project instructions

- Keep all product work inside this repository. Do not modify the source workbook.
- Treat workbook content, local databases, exports, backups, screenshots, and regression values as private and uncommittable.
- Use integer cents for stored money, Decimal.js for rate math, and `Temporal.PlainDate` for financial dates.
- Keep the financial engine pure and independent of Electron, React, and SQLite.
- Every user-owned row must include and be filtered by user ID.
- Internal transfers do not change consolidated liquidity. Card purchases do not reduce cash until payment. Locked statements replace estimates. Receivables are not income. Investments are not deployable cash by default.
- Safe-to-deploy margin is the conservative projected trough minus the hard cash floor; never hide a negative margin or an underfunded account.
- Preserve audit lineage and history; do not silently overwrite imports, reconciliation history, or user-edited values.
- Run focused tests while developing and `pnpm verify` before release. Run `pnpm privacy:check` before every commit.
- Update `docs/PROJECT_STATE.md` after meaningful work.

## Published Status

When the user asks for **Published Status**, execute `docs/PUBLISHED_STATUS.md` end to end rather than returning a plan. Keep the private development repository private, synchronize it, build a sanitized clean-history public mirror, verify the public default branch and release from a fresh download, and open the safe public-download folder in File Explorer. Never publish a workbook, database, export, screenshot, private backup, three-file owner handoff, signing secret, or historical development object.

Report exactly one state: `READY` only when every source, privacy, signing, release, post-download, and fresh-onboarding gate passes; otherwise `BLOCKED` with the exact unmet gates. A local unsigned candidate remains useful for owner development testing but is never Published Status. The final response must begin with reversible uninstall/blank-onboarding instructions, then give click-by-click GitHub installation instructions and direct links.

`pnpm published:status` verifies the automatable subset and is necessary but not sufficient. Do not report `READY` until the recorded dependency/license review and disposable-profile lifecycle checklist also pass.
