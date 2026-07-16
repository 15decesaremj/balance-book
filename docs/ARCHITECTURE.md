# Architecture

## Boundaries

The repository is a pnpm workspace with four product boundaries:

- `apps/desktop` owns Electron main, the sandboxed preload bridge, and the React renderer.
- `packages/domain` owns validated entities, exact money, and financial dates.
- `packages/financial-engine` owns pure deterministic calculations and has no Electron, React, database, or filesystem dependency.
- `packages/database` owns SQLite schema/migrations, transactional repositories, local authentication, audit rows, encrypted portable data, import lineage, and user isolation.
- `tools/workbook-importer` owns local read-only Excel inspection and deterministic create/update/skip/conflict/unresolved preview logic.

The renderer never receives Node or SQLite access. Privileged work crosses a narrow typed preload bridge and is validated in the main process. The Electron window currently runs with context isolation, renderer sandboxing, Node integration disabled, permission requests denied, and child windows denied.

## Financial data flow

Validated domain records enter the pure engine. The application first rolls older account snapshots through the native expected ledger to establish the current opening state. The forecast engine then filters unresolved events for protected or expected mode, sorts same-day events conservatively, and evaluates every intermediate account state. It returns daily balances, in-transit cash, intraday lows, consolidated and account troughs, effective account/global guardrails, jointly allocated transfer suggestions, floor margins, dependencies, and exclusions.

Cash, in-transit cash, money owed, and total position remain separate throughout the calculation. A transfer debit moves cash from a source account into the in-transit bucket and its paired arrival moves the same cash into the destination, preserving consolidated ownership. Native receivable records accrue and settle occurrence-keyed obligation buckets, so an early or late receipt can replace only its linked installment and can never become income.

Typed income can be a standalone deposit or a grouped plan. A grouped paycheck is anchored to one nominal payday schedule and persisted as atomic destination legs with a shared total and plan identity. Each leg carries its own account, amount, and signed calendar-day offset. Recurrence expands the nominal schedule first and derives each actual arrival second; only the derived legs enter the cash ledger. The shared total is validation and presentation metadata, not a second inflow. Domain, contract, and repository validation require consistent shared fields, unique destination accounts, positive allocations, at most one remainder marker, an exact allocation sum, a first official payday on the declared schedule, and collision-free plan/allocation identities. The guided paycheck editor further requires exactly one remainder destination. Creating, replacing, and deleting the plan is transactional. A base-plan edit also updates linked raise cadence, end date, and matching destination offset inside the same transaction, or rolls back when the raise's effective payday would no longer exist.

Linked raise adjustments are calculated from the whole base plan's take-home, begin on a valid nominal occurrence, and enter the explicitly chosen destination account. An existing destination retains its account timing offset; a new destination uses the official payday. Optional bonuses are distinct one-time deposits with an explicit account and date, saved atomically with the raise. Already-net payroll deductions remain outside the cash ledger and cannot be subtracted a second time. Card purchases are assigned to stored or generated statement cycles, and only the incremental resulting payment affects cash once on the derived payment date. Intentionally manual cards retain unknown timing rather than generating placeholder cycles. Each card-funded record explicitly says whether it is additional activity or already included in an aggregate cycle total, preventing imported baselines and detailed charges from being counted twice.

Revolving debt is summarized per card from the same raw and materialized event timeline used by the dashboard. Statement due, open-cycle activity, total current balance, available credit, and past-due carrying balance remain distinct. Dated issuer snapshots can anchor current or carrying debt, while newer exact purchases and payments roll forward without counting stored-cycle and generated-payment evidence twice. Retiring a revolving account is effective-dated: activity and new cycle openings stop at closure, while pre-closure cycles, debt, and later payments survive.

Installment debt starts from a dated principal and accrued-interest snapshot. A pure setup solver reconciles whichever lender facts are available, returns exact, approximate, incomplete, or inconsistent status, and records calculated-field lineage. The dated projection accrues interest between actions, allocates regular payments interest first, applies explicitly classified extra principal directly to principal, caps overpayment, and emits balances, payoff, maturity payment, and balloon information. Total bank draft can exceed debt service for escrow, insurance, or fees without inflating principal reduction.

Scenario evaluation runs the identical engine before and after adding hypothetical events. Its horizon extends through the latest settlement. Saved card scenarios retain the card and purchase date so individual, duplicated, and combined evaluation keeps native cycle/payment semantics. Conversion is one database transaction that creates either direct cash activity or card activity as appropriate, archives the hypothetical record, and writes audit evidence.

## Persistence contract

All user-owned rows contain a user ID and repository reads and writes require that ID. SQLite runs only in Electron's main process under the per-user application-data directory. The versioned schema uses Drizzle, foreign keys, WAL, transactions, WAL-consistent `VACUUM INTO` pre-migration snapshots, resumable onboarding drafts and review states, immutable audit rows, full record ownership checks, workbook lineage, local profile preferences, independent receivable accrual and settlement schedules, optional card timing, typed debt metadata, inferred-loan lineage, classified loan payments, effective-dated revolving-account closure, atomic grouped-income routing, refinance/collateral lineage, and saved card-scenario semantics.

Portable backups serialize one user's validated data and encrypt it with AES-256-GCM using a scrypt-derived key. Restore and JSON import validate the full document before a transactional replacement. Exports are user-specific; JSON/CSV exports are intentionally unencrypted and the UI warns the user.

## Record and editing model

SQLite is the single canonical store, but Financial Records is not the sole user interface. The normal editing path is contextual: income and raise plans on Income and raises; card terms and cycles on Cards; loan terms on Loans; accruals and receipts on Money Owed; holdings on Assets and Net Worth; and account/global guardrails in Settings. Those guided forms validate and write the same typed records shown by the advanced Financial Records library. Financial Records provides cross-type search, current-versus-imported values, per-field lineage and forecast impact, audit context, direct edit actions, and a disclosed structured-field fallback for uncommon attributes. It labels grouped-income legs as parts of one routed plan and sends edits to Income and raises; the generic editor cannot mutate a single leg independently.

This split follows the categories in the CFPB's personal-financial-data-rights guidance, which distinguishes transactions, balances, account terms, and upcoming bills rather than flattening them into one undifferentiated file. The FDX API similarly uses a typed financial-data taxonomy. The interaction follows the GOV.UK service patterns to ask for one coherent thing at a time, avoid asking twice, prefill known answers, and let users review and change them before submission.

References: [CFPB Personal Financial Data Rights compliance guide](https://files.consumerfinance.gov/f/documents/cfpb_personal-financial-data-rights-small-entity-compliance-guide_2024-12_pdf.pdf), [FDX API 6.0](https://developer.financialdataexchange.org/learn-about-fdx-api-v6-0-0), [GOV.UK question pages](https://design-system.service.gov.uk/patterns/question-pages/), and [GOV.UK check answers](https://design-system.service.gov.uk/patterns/check-answers/).

## Workbook boundary

The optional generic importer opens user-selected Excel files read-only, checks file size, modification time, and checksum before and after inspection, and produces a reviewable preview. User workbooks, mappings, populated databases, regression evidence, and import reports remain in ignored local directories. Runtime operation does not depend on Excel or a workbook. Any local first-load adapter must be guarded and versioned: it requires an explicit directory, requires an additional opt-in for an active app-data directory, snapshots an existing database through SQLite, and refuses to replace a profile with detected native activity.

## Security posture

No remote content, arbitrary shell bridge, dynamic code execution, telemetry, or workbook runtime dependency is permitted. Financial values are excluded from logs and Git. The repository privacy check rejects staged workbooks, databases, exports, backups, screenshots, secrets, and local data.
