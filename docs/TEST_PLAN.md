# Test plan

`pnpm verify` is the release-oriented local pipeline: formatting check, lint, strict type-checking, Vitest, privacy guard, Electron package build, and a Playwright Electron smoke test.

## Current automated coverage

The foundation contains committed synthetic tests for exact-cent rounding, leap-day and constrained-month recurrence, daily interest, interest-first allocation, and all 23 required golden cases:

1. two- and three-paycheck months;
2. payment before reimbursement and delayed refunds;
3. shared-expense liquidity versus economics and partial receivables;
4. delayed transfers and account funding;
5. card close boundaries, locked statements, and both estimate policies;
6. combined scenario affordability and settlement beyond the visible horizon;
7. consolidated cash versus an underfunded account;
8. both refinance tradeoff directions;
9. reward timing versus liquidity;
10. floor breach despite positive month end;
11. contractual versus economic retirement-plan-loan treatment;
12. direct-cash/card and net-pay/payroll-deduction double-count prevention;
13. same-day outflow-before-inflow ordering;
14. uncertain receivable exclusion.

The committed fixtures are wholly synthetic and do not resemble or encode user workbook values.

## Complete-core automated coverage

The current unit/integration suite adds:

- migration recovery and automatic pre-migration backup;
- unique password salts, constant-time verification behavior, and the five-failure lockout boundary;
- strict profile isolation, cross-profile identifier protection, transactional setup replacement, audit history, and guarded user reset;
- AES-256-GCM backup confidentiality, incorrect-password failure, validated restore, and restart persistence;
- resumable onboarding drafts, paired delayed transfers, partial receivable settlements, scenario conversion, and loan payoff projection;
- native receivable accrual and cash-settlement roll-forward in expected and conservative modes;
- assigned static receivable dates and accounts producing one exact cash-versus-owed swap, recurring contributions reducing only matching accrued Money Owed, unconfirmed dates remaining expected-only, bill-relative contribution pairs sharing the same month-safe date, and schema-29 repair of only untouched imported no-date placeholders;
- release-only recurring receivables keeping future installments out of current Money Owed, accruing them only on their selected occurrence dates, labeling each Forecast accrual by source and purpose, creating no planned bank cash, applying full or partial releases only to the linked occurrence and selected destination account, and atomically allocating an optional unattributed receipt oldest-first across open occurrence balances with one exact bank deposit and retained audit lineage;
- per-card Spending Power from the current-cycle due date, independently dated end-of-day lows for every included checking account through the later of the limiting total-position date or payment date, exclusion of unrelated later account episodes, limiting-date account/receivable reconciliation, payment-date funding snapshots, and separate intraday funding diagnostics;
- per-card future liquid-cash and total-position lows;
- derived refinance payments, residual balances, and non-amortizing quote warnings;
- native refinance closing-cash, funding-account-low, consolidated-low, and safe-to-deploy comparisons;
- refinance horizons extended through the later of payoff and first replacement payment, with source-loan payments retained strictly before payoff, new-loan payments allowed during a delayed-payoff overlap, same-day payoff payments retired, and unrelated loans preserved;
- single-materialized card payments from onboarding without a duplicate explicit event;
- editable forecast guardrails that preserve all existing financial records;
- truthful optional onboarding groups, partial-draft resume, and refusal to replace an established profile;
- set-then-clear behavior for nullable terms and overrides, plus dependency-safe parent deletion;
- schema-v10 typed metadata and card-activity-treatment migration, round-trip persistence, cross-record ownership, and explicit clearing;
- card-funded detailed activity flowing into one later statement payment, with aggregate-included records excluded from a second count;
- mixed account balance dates, cash-plus-owed forecast identity, liquid assets, and paid-off-loan exclusion;
- Squirrel install/update/uninstall shortcut lifecycle handling;
- Forge's two-phase SQLite staging supplying rebuild inputs before native compilation and preserving only the Electron-ABI runtime afterward;
- importer checksum protection, preview dispositions, idempotency, unresolved parsing, and user-edit conflict behavior.
- rolling-current-date replay from dated account snapshots, with future protected treatment beginning from the modeled current opening rather than an old source date;
- typed one-time and recurring income across weekly, biweekly, monthly, and semimonthly schedules, plus linked raise adjustments, atomic raise-and-bonus persistence, and confirmed/expected/uncertain projection differences;
- grouped paycheck routing from one official payday into multiple cash accounts, including durable editor order independent from account-specific early-arrival offsets, fixed-plus-remainder allocation, cross-month dates, atomic plan replacement/deletion, portable-restore validation, semimonthly-start rejection, collision-safe identities, and linked-raise schedule cascading or rollback;
- effective-dated paycheck streams that present one logical source across prior/current/future routing phases, reject overlaps and off-cadence starts, preserve identity through backup/restore, and migrate only an unambiguous legacy split-plus-successor pattern;
- per-account hard/preferred controls, effective-global-floor derivation, consolidated override propagation, and rejection of preferred values below their hard minimum;
- delayed-transfer ownership in the in-transit bucket, recurring debit/credit pairing, transfer lead-time enforcement, joint source-capacity reservation, source-surplus reporting after all recommendations, and zero deployable cash when a breach cannot be safely funded;
- separation of intraday shortfall evidence from daily-closing funding actions, including suppression of recovered same-day dips, the first and deepest balances in the next contiguous below-floor episode, a later post-recovery episode remaining separate, and source-capacity validation against the current episode without conflating that later breach;
- sequential Money Owed coverage in need-by order, including first-breach and later-in-episode incremental reservations so two funding actions cannot promise the same receivable dollars;
- card-cycle-native purchase impact for actual-reset and baseline-guardrail estimates, close-date boundaries, minimum/fixed/full/manual payment behavior, generated future cycles, combined-purchase accumulation, and persistence of card semantics in saved scenarios;
- multiple explicit future card payments on independent dates, cycle targeting and date-based assignment, policy-generated remainder suppression, stale linked-instruction suppression after an actual payment, post-due payment reassignment without retroactive carry clearing, zero-interest installment-style cash schedules without loan amortization, actual underpayment carry, paid-in-full clearing, and overpayment credit against later open activity;
- carried-balance monthly-interest presentation for zero carry, missing APR, ordinary APR, and whole-balance promotional 0%; profile/card double-gated forecast accrual; locked-statement authority; default-off preference and recovery-safe schema-36 migration;
- long-run net monthly free cash flow from the weakest rolling three-month average in a clean future year, using total-position change, preserving receivable accrual/receipt neutrality, excluding later payoff and extra-paycheck inflation, and separately disclosing explicit scheduled-card-payment effects;
- recorded statement-payment account selection and schema-32 persistence, including exact single-account cash routing, paid-cycle validation, legacy fallback, portable-profile restore, and no duplicate cash evidence;
- all-card advisor and scenario response contracts, including exact baseline/after/incremental card payment, true settlement date, floor effects, transfer needs, invalid timing combinations, and consistent rejection of non-full-statement cards in single and combined evaluations;
- date-driven statement lifecycle for a past due date with a later scheduled payment, a locked overdue statement with unresolved timing, same-day due generation, suppression of invented pre-onboarding overdue cycles, stale open/future rows, and intentionally timing-incomplete manual cards;
- occurrence-specific recurring receivables, including partial and late receipts across rolling replay boundaries, a later-installment prepayment, suppression of unearned planned cash before the first accrual, preservation of real early prepayments, cash received before the paired expense, static-plus-recurring anchors, no double accrual, transactional edit/delete reversal, cross-user rollback, and rejection of a future “received” date before mutation;
- rolled current net worth, including exact agreement with the forecast's cash/owed balances and inclusion of non-liquid owned cash only in contractual/economic totals;
- cadence-normalized receivable run rates, compounding-aware loan daily accrual, modeled-interest payoff inputs, and current-ledger cash values on Net Worth;
- schema-14 optional card timing, schema-16 paycheck allocation ordering, schema-18 through schema-21 refinance lineage repair/compaction, dark-default migration, staged import writes before policy creation, and a WAL snapshot containing an uncheckpointed committed row and the exact pre-migration schema.
- issuer-reported and cycle-derived revolving debt, including statement/current/open-cycle/carrying separation, partial payment, paid-in-full carrying zero, available-credit isolation, raw-versus-materialized event deduplication, and Cards/Dashboard/Net Worth agreement;
- effective-dated card and line-of-credit closure, including the inclusive blocked-purchase date, final pre-close cycle, later payoff cash, exclusion from baselines/Spending Power/advisor results, backup compatibility, and reactivation;
- deterministic partial-fact installment-loan solving across payment, whole-basis-point APR, current/original balance, origin, term, maturity, and payoff; exact/approximate/incomplete/inconsistent status; end-of-month, leap, delayed-first-payment, monthly, and biweekly timing; and rejection of contradictory or non-amortizing fully-amortizing terms;
- fully amortizing, balloon, and zero-payment bullet structures, including entered or inferred residuals, payment-to-target-balloon solves, maturity requirements, and distinct contractual maturity versus modeled payoff;
- regular loan-draft overrides versus one-time and recurring additional principal, including exact-date liability reduction, overpayment capping, unchanged regular drafts, lower future interest, accelerated payoff, stale-past-plan exclusion, and propagation through Loans, Cash Forecast, Refinance, Net Worth, and persisted records;
- transaction-safe loan funding-account and schedule edits, including future-only draft migration, recurring history splits, incompatible-edit rollback, inactive/excluded-loan suppression, cancelled-refinance suppression, and parent-delete protection for loan and statement payment lineage;
- route-wide control contracts for Cards, Loans, Financial Records, Income, Cash Forecast, Money Owed, Net Worth, Reconciliation, Settings, Setup, Data, and Scenarios, including repeat editor reveal/focus, immediate same-tick mutation locking, local errors, persisted-response repopulation, stale-response rejection, and expected downstream refresh;
- schema-22 debt metadata, schema-23 loan-payment treatment, schema-24 revolving-account lifecycle, schema-25 amortization structure/contractual-balloon persistence, schema-26 bill-relative receivable timing, schema-27 durable receipt-occurrence identity/target metadata with legacy-safe nullable defaults and portable-backup round trips, schema-28 early-paycheck allocation repair, schema-29 imported static-receivable date repair, schema-30 Overview account visibility, schema-31 experience preferences, schema-32 recorded card-payment accounts, schema-33 same-day post-balance-snapshot transaction boundaries, schema-34 notification presentation, schema-35 investment assumptions, and schema-36 card-interest controls.
- chart view-model and page behavior, including the default 12-month historical/12-month future window, observed-versus-modeled provenance, blank unavailable history, category/time/series controls, monthly owed and card averages, total-position/net-worth trajectories, and per-card carry persistence until that same card is paid in full.
- schema-34 notification-presentation migration and recovery, profile isolation, restart persistence, device-local backup exclusion, stable condition identity, material-change fingerprints, deduplication, read-versus-resolved badge behavior, automatic canonical resolution, retained failed-action input, and immediate duplicate-submit locking;
- recurring Bills & subscriptions over canonical cash events, including editable cash/card payment sources, the default no-double-count card treatment, optional additional card activity, variable-amount confidence, mutually exclusive full reimbursement or 50/50 sharing, occurrence-dated Money Owed, transactional rollback, and same-tick submit locking;
- investment projections with daily-compounded expected return, fixed monthly contributions, gross-pay-based employee contribution and employer match, no second reduction of take-home cash, Cash Forecast net-worth series output, Trends reuse, persistence, and recovery-safe schema-35 reapplication;
- authoritative-versus-calculated account/card read models, source freshness, post-source activity, calculated-through wording, and Overview disclosures that preserve source dates;
- Now/Activity/Plan account and card detail behavior, source snapshots, recent canonical records, relevant audit envelopes, exact deep links, focus return, and compensating-reversal lineage without deletion;
- unified Activity & records filtering by text, account/card, type, status, and date, plus daily-forecast source tracing to the correct forecast event, card cycle, loan, or receivable editor;
- purchase-adviser following-statement ownership, due date, the minimum total position from that date forward, resulting available spend, protected account dependencies, receivable/transfer needs, and per-option Why disclosures;
- Start/Improve accuracy/Advanced onboarding disclosure while preserving all existing setup inputs and restart behavior;
- first-run applicability answers, dynamic step inclusion, presentation-only feature visibility, legacy preference defaults, and searchable re-enablement in Settings;
- desktop navigation collapse/expand, accessible compact labels, saved preference persistence across reload, default-hidden native menu, top-edge reveal, and automatic re-hide after returning to content;
- next-statement card position anchored after the current purchase-bearing cycle rather than an earlier unpaid statement, with the same following-date forward low in purchase-adviser results;
- update-service disabled-build behavior, first-run delay, feed selection, duplicate-check suppression, offline/error states, download/defer/restart transitions, malformed post-update metadata, and same-version suppression;
- fail-closed refusal of a database schema newer than the application supports, including byte-identical file hashing and handle cleanup;
- number-only attention rendering; keyboard switching among Notices, Bills, and Balances; fixed cross-tab panel and body geometry; sliding selection and directional content motion; contained unread markers and wrapping subjects; exact shortfall language; complete-ledger bill filtering; canonical account/card glance totals; notification popover and phone bottom-sheet geometry; header and Setup-level non-overlap; the five primary hubs plus every advanced route including Bills & subscriptions; serious/critical accessibility; and route/viewport collision coverage from 1440px through 320px.

The complete 2.0.8 gate runs formatting, lint, strict type checking, the native SQLite rebuild, all committed tests, the privacy scan, production packaging, and the packaged Electron journey. Both the normal and all-in-one commands run native SQLite tests in one child-process worker on Windows to avoid an intermittent worker-thread access violation without hiding individual test failures. The packaged journey uses a temporary synthetic profile and does not mutate the live owner database. It verifies Bills & subscriptions, linked Money Owed, investment assumptions, Net worth forecasting, conservative long-run free cash flow, carried-balance interest controls, notification count/read behavior, fixed cross-tab geometry, completed slide motion, contained wrapping text, rounded and textured notice/bill/balance cards, the Setup heading and local-data consent, serious/critical accessibility, exact downstream cash/card effects, and every authenticated route at eight widths. The Store gate additionally verifies MSIX identity/version mapping, isolated direct-to-Store copy migration, interrupted-migration recovery, channel-specific updater behavior, registered-package launch, and a local two-version package upgrade without touching the owner profile. The guarded owner upgrade separately verifies pre-install/post-install database preservation and recovery-safe application of schemas 35 and 36. A fresh disposable Windows-profile lifecycle remains a separate public-release gate because the hardened installed executable's disabled Node-inspection fuse intentionally prevents Playwright attachment.

Standalone `pnpm test:e2e` runs package the current source before launching Electron, uses a 20-minute journey budget with bounded page-ready and mutation waits, and scopes mutation-result status assertions by their message. The route/viewport matrix loads each data-backed route once and then resizes it through all eight widths, preserving every assertion without rebuilding the same forecast eight times. This prevents loading skeletons from colliding with success announcements, avoids renderer-thread URL polling, and prevents a journey-only run from silently exercising stale `.vite` output.

## Committed-refinance validation gate

Release evidence for the effective-dated commitment flow must use synthetic records and demonstrate:

1. exact payoff projection for one and multiple source loans, including interest, intervening monthly or biweekly payments, and confirmed or future additional principal without duplicating regular drafts;
2. distinct closing, payoff, and first-payment dates, including same-day payoff/payment suppression, a closing-to-payoff liability overlap, and a first replacement payment before a delayed old-lender payoff;
3. the replacement-principal identity across payoff totals, principal cash contribution, financed fees, unfinanced fees, and excess proceeds;
4. no bank event for lender-to-lender payoff, one closing outflow from the selected cash-source account, and one proceeds inflow to the selected destination account;
5. the preview and committed record producing the same cash path, account lows, consolidated low, safe-to-deploy value, and effective loan set;
6. source payments stopping on payoff, replacement payments beginning on the explicit first-payment date, and unrelated loans remaining unchanged;
7. contractual/economic net worth recognizing source and replacement liabilities on their correct effective dates;
8. save, reload, pre-effective source/replacement term locks, post-effective live-loan edits with an unchanged immutable offer snapshot, history, audit, portable backup/restore, CSV export, profile isolation, and idempotent commit behavior;
9. cancellation before effectiveness, rejection of duplicate source retirement, and rollback on any invalid or cross-profile component;
10. a later refinance of a prior replacement loan, chronological replay of the full chain, dependency-aware cancellation, and rejection of cycles or same-instant stacking;
11. the planner's account selectors, conditional closing/proceeds controls, explicit **Use this refinance** action, history view, responsive layout, keyboard operation, and serious/critical accessibility checks;
12. regression checks for Cash Forecast, Overview, Spending Power, Loans, Net Worth, backups, and every pre-existing deterministic finance test.
13. payoff rows joined to selected loans by source ID even when the UI order is reversed, plus rejection of source loans whose payments are excluded from the cash forecast;
14. collateral linkage before closing, at closing, through a later stacked refinance, and through reverse-order cancellation, with locked direct edits that would break the chain;
15. no-mutation restore rejection for missing snapshots/relink metadata, orphan, discontinuous, nonterminal, untracked-future, or missing-earlier-future collateral links, plus proof that a weak legacy audit payload cannot redirect cancellation;
16. schema-18, schema-19, and already-schema-20 repair behavior; all-or-none rejection of mixed-invalid legacy relinks; a 50,001-relink preflight rollback; and a 12,000-relink compact-audit encrypted backup/decrypt/restore round trip;
17. effective Loans values from the forecast financial date rather than the wall clock: replacement zero before close, both liabilities active during overlap, and source zero after payoff, alongside stale-selection and clear/re-entry control checks.

User-workbook regression and populated-profile smoke evidence stays outside Git. Optional local validation treats a workbook only as read-only import and comparison evidence; it verifies source checksum stability, batch and lineage linkage, expected dated rows and card-cycle vectors, explicit classifications for intentional differences, repeat-run idempotence, and blank-profile isolation. No workbook formula is called or translated into runtime application logic. The release gate additionally runs the privacy guard, Forge production build, installer creation, packaged-executable smoke test, production dependency review, and Windows GitHub Actions.

## Reference-workbook audit protocol

A private parity run reviews every visible worksheet, including onboarding/reference tabs and historical statement tabs, without committing its contents. It applies four distinct checks:

1. **Sanity:** signs, magnitudes, dates, labels, and relationships answer a recognizable financial question and do not imply impossible duplicate income or unexplained cash.
2. **Mechanics:** each stored input is traced through recurrence, account timing, event order, card settlement, receivable movement, and every affected output.
3. **Decision quality:** Spending Power, transfer guidance, card choice, and warnings use the correct constraint and do not optimize one account by silently harming another.
4. **Parity:** daily total position and account paths, statement obligations, money owed, and card runways are compared at cent precision. Every deviation is classified as a missing native fact, native defect, intentional rule difference, or demonstrated workbook defect. No deviation is accepted merely because the workbook or application produced it.

Private figures, rendered sheets, databases, and comparison traces stay ignored. The public repository retains only synthetic regressions for any discovered rule or defect.

## Daily-driver input-to-output matrix

The release is not considered validated merely because a control saves. Automated and Electron checks pair each important input with its downstream surfaces:

| Input                                                                                                                                               | Required downstream evidence                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paycheck total, official payday, routing allocation, arrival offset, cadence, certainty, or end date                                                | Per-account arrival dates and balances, consolidated total only once, expected/protected difference, low point, floor margin, and horizon cash change                                                                                                                                           |
| Raise amount/mode/effective date and bonus                                                                                                          | Linked recurring adjustment, separate one-time bonus, atomic persistence, correct number of occurrences, and exact expected/protected impact                                                                                                                                                    |
| Account minimum or preferred buffer                                                                                                                 | Intraday diagnostic breach, first daily-closing breach, deepest close in the same contiguous episode, effective global minimum/preferred value, Overview protected floor, Spending Power, and Funding Actions                                                                                   |
| Consolidated override                                                                                                                               | Effective global guardrail only when larger than account-derived totals; no source-record rewrite                                                                                                                                                                                               |
| Transfer amount, recurrence, and lead time                                                                                                          | Paired occurrences, in-transit cash, unchanged consolidated ownership, destination arrival, source floor, and recommendation timing                                                                                                                                                             |
| Card terms, statement/payment state, future scheduled payments, issuer snapshot, carrying amount, lifecycle, current spending, or purchase scenario | Statement due, policy-generated remainder, exact dated cash payments, actual underpayment carry or overpayment credit, total/current/carrying debt, open-cycle activity, available credit, owning cycle, closure eligibility, Spending Power, advisor rank, Net Worth, and transfer requirement |
| Receivable amount, accrual, release mode, receipt destination, or selected occurrence                                                               | Current versus future owed asset, planned or explicitly released cash, exact installment remainder, sequential funding coverage, total-position identity, and net-worth agreement                                                                                                               |
| Chart time/category/series controls                                                                                                                 | Correct historical and future visibility, provenance-preserving points, blank unavailable history, and unchanged source financial records                                                                                                                                                       |
| Asset value or cash liquidity inclusion                                                                                                             | Liquid position only when eligible; all owned cash and included assets in contractual/economic net worth                                                                                                                                                                                        |
| Loan snapshot, original terms, cadence, structure, regular or extra-principal payment, refinance quote, or commitment                               | Solver status and calculated lineage, dated amortization, cash-versus-debt allocation, maturity/balloon/payoff, effective liability set, payment start/stop, account and consolidated lows, Spending Power inputs, net worth, history, and backup lineage                                       |
| Reconciliation certainty/status                                                                                                                     | Future forecast inclusion changes while income/card/source metadata and audit history remain intact                                                                                                                                                                                             |

No accessibility conformance claim is made without an external audit.
