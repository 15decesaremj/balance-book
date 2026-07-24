# Financial model

## Money and dates

Stored money is integer cents. Decimal.js is used where rates or interest require precision; displayed interest rounds half-up to cents. Financial dates are ISO `YYYY-MM-DD` values validated and calculated as `Temporal.PlainDate`, so time zones cannot shift a settlement date.

## Rolling forecast and modes

The active forecast starts on the current financial date, or the earliest account balance date when that lies in the future. If an account's balance snapshot is older, the native expected ledger is replayed through the prior day to establish a modeled current opening balance. That replay is not a workbook calculation: it uses the same normalized recurring events, card cycles, loans, receivables, and transfer rules as every other forecast. From the current opening, protected and expected treatment applies only to unresolved future activity.

Protected (conservative) mode includes confirmed income, every active outflow regardless of certainty, baseline spending, and confirmed receivables only when policy allows them. It excludes expected or uncertain income, expected reimbursements, and unredeemed rewards.

Expected mode additionally includes expected inflows, reimbursements, and cash reward deposits. Uncertain inflows remain excluded. Differences are returned as inspectable dependencies and excluded event IDs.

On an untimed date, outflows are applied before inflows. Explicit manual order can override the default. Account and consolidated minima are measured after each event as well as at day boundaries. Intraday minima remain available for conservative diagnostics and safe-to-deploy math, while user-facing account-funding actions use daily closing balances so a temporary dip that recovers later the same day is not presented as money the user needs to move.

`raw safe-to-deploy margin = protected consolidated intraday trough - effective global hard floor`

The signed raw margin is always retained. The consumer-facing available amount is `max(0, raw margin)` and never replaces or hides a negative margin. If an account breach has no safe transfer source, consumer-facing available-to-deploy cash is zero even when the consolidated margin is positive.

## Income, raises, and bonuses

Income is positive cash reaching one or more explicit destination accounts. Supported planning labels are paycheck, bonus, commission, self-employment, partner contribution, raise adjustment, and other; the label does not change the arithmetic. A stream may be one-time, weekly, biweekly, monthly, or semimonthly and may have an end date.

A routed paycheck has one nominal employer payday and one atomic destination leg per account. The plan total, cadence, certainty, notes, and nominal payday are shared plan facts; each leg stores only its destination amount and calendar-day arrival offset. The guided editor requires one `whatever is left` destination and allows any other destinations to use fixed amounts. Fixed amounts are subtracted from total take-home and the exact remainder is assigned to that final destination, so the legs must sum exactly to the plan total and an account cannot appear twice.

One enduring income stream can contain multiple nonoverlapping, effective-dated routing phases. This represents a single employer or source whose account split changes on a future official payday; it is not multiple sources of income. Every phase keeps the stream's cadence and income type, begins on a valid occurrence of that cadence, and ends before the next phase starts. The Income page presents the stream once, with its prior, current, and scheduled routing nested underneath it. A raise resolves against the phase covering the raise's effective payday.

Each leg enters cash on `nominal payday + account offset`. A deposit configured as two days early therefore reaches only its destination account two calendar days before payday; an on-payday leg reaches its account on the nominal date. The aggregate paycheck is plan metadata, never an additional cash event, so neither consolidated cash nor an account can receive the income twice. The forecast expands recurrence from the nominal schedule and then applies each leg's offset, including an early leg whose official payday lies just beyond the visible horizon.

- Confirmed income appears in expected and protected forecasts unless explicitly excluded from protected treatment.
- Expected income appears only in expected cash.
- Uncertain income appears in neither cash projection until its certainty changes.
- A raise adjustment is linked to its recurring base stream and repeats on the base cadence from its effective nominal payday. The adjustment may be derived from the whole paycheck's new total take-home, an added take-home amount, or a percentage of current total take-home. The user explicitly chooses where the increase lands; a selected account in the existing split keeps its timing offset, while another account receives it on payday.
- Editing a base paycheck atomically carries its cadence, end date, and matching destination timing into linked raise plans. If the edit would remove the raise's effective official payday or end base pay before it, the complete base edit is rejected instead of leaving raise-only cash behind.
- An optional bonus is a separate one-time income event with an explicit destination and arrival date. A raise and its bonus are saved in one transaction so a failed component cannot leave a partial plan.

The impact preview compares both forecasts before and after the plan, including low point, floor margin, and horizon cash. Gross-pay, withholding, and payroll-benefit modeling are deliberately outside this net-cash layer; users enter take-home that actually reaches their accounts. A retirement, benefit, tax, or other payroll deduction already reflected in that take-home is not subtracted from cash again.

## Cash guardrails

Every liquidity account can carry a hard minimum and an optional preferred buffer. Accounts can also be excluded from liquidity or made ineligible to fund other accounts. A consolidated hard/preferred override remains available for an additional portfolio-wide reserve.

`account hard-floor total = sum(hard minimum for each included account)`

`effective global hard floor = max(consolidated hard override, account hard-floor total)`

When any included account has a preferred buffer, its preferred-floor total uses that buffer where set and otherwise that account's hard minimum. The effective global preferred floor is the largest of the effective hard floor, consolidated preferred override, and account preferred-floor total. Preferred values warn; hard values constrain Spending Power and safe-to-deploy cash. Both the configured overrides and their account-derived composition remain visible.

## Transfers and account funding

An internal transfer is a paired debit from one account and credit to another. On initiation, cash leaves the source account and becomes in transit; on arrival, the same cash enters the destination account. Consolidated ownership therefore remains unchanged for same-day and delayed transfers. The delay can still create an account-level funding gap because in-transit cash is unavailable to either endpoint until arrival.

Recurring transfers expand as paired occurrences with the same delay and independent occurrence lineage. A funding suggestion targets arrival before the first daily closing account-floor breach, works backward through the source account's transfer lead time, and verifies that the source remains above its own floor across the remaining horizon. Multiple needs reserve source capacity jointly, so the same surplus cannot be promised twice. The application reports amount, initiation, arrival, and remaining source surplus, but never moves money.

The dated funding action describes the account's next contiguous below-floor episode. It reports the amount required on the first daily closing breach and the deepest daily closing balance reached on consecutive below-floor days before the account recovers. If that episode deepens, the later date, total requirement, and only the additional amount beyond the first requirement remain distinct. A later breach after the account has recovered is a separate planning decision and is never mislabeled as part of the first episode or used to suppress a source that can safely fund the next episode. The proposed source must still remain above its own floor across the remaining forecast after the current episode's full requirement is reserved.

Projected Money Owed is potential coverage, not bank cash and not an automatic transfer. Funding guidance can show how much eligible owed value would need to be explicitly released by the first breach and, if the same episode deepens, the additional amount needed by the deeper date. Coverage is allocated sequentially in need-by order and reserved after each use, so two account warnings cannot promise the same receivable dollars. Any uncovered remainder remains visible.

Each cash account begins on its own balance-as-of date. Its dated balance already includes activity through that date, so earlier and same-date historical events are not replayed and the account is shown as unavailable, not zero, before its snapshot becomes active.

## Credit cards

A purchase is assigned using posted date when known and otherwise purchase date with an assumption flag. The close date is inclusive. The purchase changes a statement projection, not cash on purchase date.

- Future cycles use the greater of their cycle-specific estimate and known or planned activity.
- Actual-reset open cycles project actual plus planned activity.
- Baseline-guardrail open cycles project the greater of baseline and actual plus planned activity.
- Detailed card-funded records join the applicable open or future cycle once and become cash only through that cycle's later payment. Each record is marked either `additional` or `included in cycle total`; included records explain an aggregate without increasing it again. An explicit projection override remains the editable aggregate baseline, with only additional linked activity added once.
- A locked statement replaces the estimate for that cycle.
- Full-statement, minimum, fixed, and manual payment policies determine the policy-driven obligation. Minimum and fixed policies require a positive configured amount; manual policy generates no automatic cash payment. Closed and scheduled cycles require an explicit locked statement, including a valid zero or negative statement.
- A card can have multiple explicit future payment records on independent dates. A payment may target a specific cycle; otherwise it is assigned to the exact matching payment date or the next cycle payment date. Explicit payments on or before the policy date reduce only the policy-generated remainder. A payment after a targeted cycle's due date cannot retroactively clear that statement's due-date carry; it is applied to the next modeled cycle while remaining cash on its entered date. This supports installment-style payment plans without amortizing a revolving account as a loan.
- Missing future cycles are generated from the card's editable close and payment-day terms through the forecast horizon, with additional months available so a purchase after close still reaches its later payment. A stored cycle always wins for its due month.
- Cycle generation never manufactures an already-past statement merely because onboarding history is missing. A cycle due on the current financial date can still be generated, and any real stored overdue statement remains payable and visible.
- A manual card may intentionally omit close/payment timing. The engine does not generate cycles or invent day 1; Spending Power remains explicitly indeterminate while dated manual cash payments continue to forecast normally.
- A non-paid statement remains visible when its due date passes. If a later `paymentOn` is known, that date funds the cash ledger. If payment timing is still unresolved, the locked amount remains visible and Spending Power is indeterminate until the record is paid or scheduled.

A future baseline remains active until its own cycle enters actual-reset treatment. Beginning actual tracking for one open statement does not erase the guardrail for a later cycle or another card. This rule deliberately wins over a reference workbook when that workbook's cached future formulas stop carrying a configured baseline, because copying that omission would overstate later runway.

Cards, charge cards, and lines of credit are revolving accounts, not installment loans. They do not use an amortization schedule. The debt view preserves several facts that answer different questions:

- **Latest statement** is historical locked evidence for a closed cycle and remains visible after payment.
- **Amount currently due** is the latest locked statement less actual payment evidence recorded after that statement closed.
- **Current-cycle actual and projected activity** describes spending that has not yet become a locked statement. Estimates affect projection only and never inflate actual debt.
- **Total current balance** is either an eligible dated issuer snapshot rolled through later exact activity and payments, or the cycle-derived unpaid statement plus posted open-cycle activity.
- **Available credit** is credit limit less current balance when a limit is known. It is issuer capacity, not cash, an asset, or an increase to Spending Power.
- **Balance carrying** is debt left unpaid after its due date or an explicit dated issuer carrying snapshot rolled through later payments. A paid-in-full account therefore carries zero even while its latest statement and current-cycle spending remain visible.

Actual statement-payment amount is independent from the statement amount, so partial payment carries only the unpaid remainder. Forecasts continue to use the configured payment policy until actual payment evidence is recorded. Once a cycle is marked paid, its recorded actual amount is the authoritative debt fact: a still-planned linked instruction is suppressed, while confirmed or paid linked cash evidence de-duplicates the generated cash remainder rather than increasing the debt payment. An overpayment never creates negative carry; it becomes a balance credit against later open activity. A later locked issuer statement is authoritative and already contains prior residuals or credits, so it replaces rather than duplicates modeled carry. Older paid history without an explicit payment amount retains its earlier meaning as a full-statement payment. When a reported balance falls inside a cycle represented only by an undated aggregate activity total, Balance Book warns that the snapshot cannot be rolled exactly until the issuer balance or dated activity is refreshed.

Revolving accounts have an effective status. A closure date is inclusive: it is the first day new purchases, recurring card activity, baseline projections, generated cycle openings, Spending Power, and purchase-advisor use are blocked. A final cycle that opened earlier may still close and be paid later; existing debt, historical statements, and post-close cash payments remain visible. Reactivation clears the closure date and restores normal eligibility.

Estimated monthly revolving interest is relevant only to a positive balance carrying. A card with no carry reports `$0.00`, regardless of whether an APR is known. A positive carry uses the card's ordinary APR unless the user marks the entire carrying balance promotional, in which case the promotional APR applies; a missing applicable APR reports **Not available** instead of inventing a rate. The estimate is nominal APR divided by 12 and rounded half-up to cents with Decimal.js.

Advancing revolving interest through Cash Forecast is experimental and disabled by default. Interest enters a forecast only when both the profile-wide experimental control and the individual card's control are enabled. The same effective ordinary or promotional APR drives that projection. A locked issuer statement remains authoritative and never receives synthetic interest; modeled interest can affect only later unlocked cycle debt and payment cash. These controls are planning assumptions, not transaction-level promotion accounting.

Static Spending Power is the lowest projected total position from the owning cycle's due date through the forecast horizon, less the effective global hard floor and clamped at zero. Total position is the sum of every included bank account's daily closing balance plus outstanding eligible receivables. This matches the card-runway question: how much position remains once the current cycle is due? Each included checking account is minimized independently within that current-cycle risk window, which ends on the later of the limiting total-position date or actual payment date. A later, unrelated account episode remains visible in Account coverage instead of being attributed to every earlier card. The actual payment date also remains a separate cash-settlement and intraday-funding diagnostic.

Receivables remain assets, not income or immediately spendable bank cash. A card can therefore have positive total-position Spending Power while its paying account is underfunded. The engine preserves the former cash-and-account-floor capacity as a separate cash-only diagnostic and continues to surface every negative bank balance, transfer need, and intraday cash breach. It never zeros or hides total-position runway merely because a distinct account-funding action is required. Spending Power is indeterminate rather than zero-capacity when payment policy is minimum, fixed, or manual, the payment lies outside the visible horizon, an unresolved overdue statement has no payment timing, or required account balances are unavailable.

The purchase advisor runs a proposed amount and date separately through every eligible card's generated or stored owning cycle. It compares the baseline scheduled payment with the post-purchase payment, adds only that incremental cash obligation on the true card payment date, reruns expected and protected lows, and reports any timed transfer need. Cash-backed guidance requires a full-statement payment policy; manual, minimum, and fixed-payment cards remain explicitly indeterminate instead of understating the obligation. Saved and combined card scenarios enforce the same eligibility rule and retain cycle-native meaning when duplicated or converted.

## Long-run net monthly free cash flow

Cash Forecast scans monthly changes in expected total position over a clean future year that begins after the current month and the next two calendar months have cleared. It reports the weakest rolling three-month average in that scan. The conservative run rate smooths isolated timing spikes, does not count extra-paycheck months as ordinary margin, and does not pull later loan payoffs or expired payment plans forward into today's base budget. Total position is cash plus Money Owed: this preserves the user's economic position when a shared expense first becomes a receivable and when a later receipt merely converts that receivable into bank cash. Investments, available credit, loan balances, and asset appreciation are excluded from this operating-cash measure.

The measure uses the same native income, bill, card-payment, loan, transfer, and receivable schedules as the daily forecast. It therefore includes known recurring or explicitly scheduled card payments that fall within the selected three-month run, while avoiding current-cycle spending and near-term bill timing noise. Cash Forecast discloses that run's average scheduled-card-payment effect and the corresponding before-scheduled-card-payment amount; neither is a second ledger or a hardcoded budget.

## Receivables and shared expenses

The gross obligation, user's economic share, created receivable, repayments, remaining receivable, temporary liquidity burden, and final personal burden are separate values. Partial settlement reduces only the remaining receivable. Editing, cancelling, reclassifying, or deleting a static settlement transactionally reverses its prior owed-balance effect before applying the new one; invalid and cross-profile mutations roll back. Overpayment is surfaced rather than silently applied elsewhere.

Every expected receipt has one destination account and exactly one timing method: a single received date, a fixed recurrence, or an offset from an owned recurring bill. Bill-relative timing uses the bill's real monthly occurrences, so "two calendar days before" remains correct across short months, leap years, and year boundaries. The shared occurrence resolver drives both cash and money-owed roll-forwards. Fixed recurrence and bill-relative timing cannot coexist on one receivable, and a linked bill cannot be invalidated or deleted until its receipt schedules are reassigned. Assigning a receipt date and account raises only the selected cash account on that date. A currently owed static balance falls by the same amount, while a recurring contribution reduces Money Owed only by the matching installment amount already accrued; cash without a matching accrued balance remains a cash-only increase. A zero-balance recurring stream cannot create planned cash before its first accrual, although a real recorded early receipt remains a valid prepayment against its linked occurrence. A date marked unconfirmed can participate in Expected mode but not Protected mode, even when the amount owed is confirmed.

Recurring owed-balance accrual and recurring cash settlement schedules are independent, but their occurrences are paired explicitly. An early, late, partial, or prepaid receipt offsets only its selected installment; it cannot settle an earlier obligation by accident. That occurrence identity survives a rolling-forecast boundary when the recorded cash date remains in the replay window. A recorded receipt replaces the remaining planned cash for that occurrence instead of creating a duplicate. A receipt entered as already received cannot have a future date. Protected projections settle the owed balance only when the same receipt is also included in protected cash, preserving `total position = liquid cash + money owed`.

A recurring receivable can instead use explicit-release mode. Each selected recurrence occurrence accrues its installment into future Money Owed on that occurrence date but generates no unrecorded bank deposit. The current owed total therefore excludes installments that have not accrued yet, while future total position includes them on their real dates. A later full or partial release is a confirmed cash event tied to that occurrence: it deposits only into the account selected for that release and reduces only that installment's outstanding amount. This is the model for recurring contributions whose timing is predictable but whose actual bank destination or release decision remains under user control.

## Loans and refinance

Modeled loan interest defaults to simple actual/365, with actual/360 and monthly approximation available. Payment allocation is accrued interest first and principal second. Daily accrual displays use the same compounding and day-count rules as the modeled balance, and payoff projection starts from total modeled principal plus accrued interest.

### Installment-loan setup and inference

The canonical loan state is a dated current-principal and accrued-interest snapshot plus APR, accrual convention, amount applied to debt, total cash draft, payment cadence, next payment, optional maturity, optional original terms, and funding account. Total cash draft may exceed debt service for escrow, insurance, or fees; only the debt-service amount is allocated to interest and principal.

Users may enter only the lender facts they have. The setup solver returns one of four statuses:

- **Exact:** entered facts reconcile to the cent and date under the selected conventions.
- **Approximate:** a safe default or bounded estimate was required, and every calculated field remains labeled and replaceable.
- **Incomplete:** the facts admit multiple materially different loans; the interface asks for the easiest additional fact rather than choosing one silently.
- **Inconsistent:** dates, balances, payment, rate, term, or structure contradict one another or describe a non-amortizing loan marked fully amortizing.

When constrained by the supplied facts, the solver can derive current balance, original principal, regular payment, whole-basis-point APR, origination, original term, maturity, and payoff. An original principal and origination date paired with the dated current lender balance can constrain payment or APR. Delayed first monthly payments are counted by actual contractual occurrences, end-of-month and leap dates remain constrained, and biweekly maturity stays an exact date instead of inventing a false monthly term. Unknown cadence defaults to monthly and unknown accrual convention defaults to Actual/365; both are labeled calculated. Exact origination cannot be recovered when the facts do not uniquely constrain it, and a biweekly calendar-month term display is only an approximation.

Every loan explicitly chooses **fully amortizing** or **balloon** structure. Fully amortizing terms must reach zero without an unexplained residual. A balloon loan requires a maturity or original term and may use an entered contractual balloon, calculate the balloon implied by payment and rate, solve a payment to a target balloon, or model a zero-regular-payment bullet loan. Contractual maturity, modeled payoff, regular payment, and maturity balloon remain separately visible.

### Dated amortization and payment evidence

Interest accrues from the balance date to each action date. On a regular payment, accrued interest is paid first and the remainder reduces principal; the final regular or maturity payment is capped to the amount actually owed. The schedule exposes each date, debt-service payment, interest, principal, and remaining balance. A modeled payoff amount is planning evidence and does not replace a lender's exact payoff quote.

A `scheduled-draft-override` record supplies observed or planned cash evidence for a generated regular draft and prevents duplicate cash without rewriting the contractual debt schedule. An `additional-principal` record is separate: it reduces principal on its exact date, is capped at remaining principal so excess cash is not invented, changes later interest and payoff, and leaves normal drafts in place. Recurring extra-principal plans follow the same rule. A stale planned or uncertain past extra payment cannot reduce today's debt unless it has confirmed or paid evidence.

A refinance may pay off one or several existing loans. Each payoff quote is derived on the selected payoff date from the source loan's native interest and payment schedule, including intervening monthly or biweekly payments. The quote is then stored with the commitment as settlement history; the application does not infer lender payoff cash from a bank ledger.

Closing date, payoff date, and replacement first-payment date are independent effective dates. Payoff cannot precede closing, and first payment must follow closing, but first payment may precede a delayed lender payoff. The replacement liability begins on closing. Each source liability remains active until its payoff date, and its scheduled payments stop on that date; a payment otherwise due on the payoff date is not charged a second time. Replacement payments begin only on the explicit first-payment date. When closing precedes payoff, net worth can therefore show both the replacement and source liabilities during the real overlap interval, and both payment schedules remain live if first payment occurs during that overlap.

During a closing-to-payoff overlap, lender funds earmarked for the old payoff are represented as restricted settlement value, not bank cash. That value offsets the temporarily duplicated contractual/economic liability without increasing liquidity or Spending Power.

Settlement uses one exact identity:

`replacement principal = source payoffs - principal cash contribution + financed fees + excess proceeds`

Total closing costs are split into financed and unfinanced portions. Only `principal cash contribution + unfinanced closing costs` leaves the selected cash-source account. Only excess proceeds enter the selected destination account. Source-loan payoff funded by the new lender is lender-to-lender liability settlement and never appears as a cash-account outflow. Financed fees are already part of replacement principal and are not charged to cash or total cost a second time.

Refinance comparison reports payment change, remaining total cost change, term change, and fee break-even independently. It runs the current and proposed schedules through the native daily cash engine, including the real closing account movements and independent payoff/first-payment dates, to compare consolidated low, affected account lows, and safe-to-deploy cash; a lower payment is never treated as automatically better. Both sides use the same horizon, extended through the later of source payoff and first proposed payment when needed. Every unrelated loan and event remains in both sides of the comparison.

Choosing **Use this refinance** converts the reviewed offer into an effective-dated commitment. The commitment creates the replacement loan, preserves the source-payoff lineage and settlement terms, and flows through Cash Forecast, account lows, Spending Power inputs, and contractual/economic net worth. The committed offer retains an immutable replacement-loan snapshot. Once effective, ordinary current balance and payment updates may change the live replacement record without rewriting the reviewed offer; before effectiveness, plan-managed schedule and lifecycle fields remain locked. Committed and cancelled plans remain in history and audit data, and profile backup/export carries their plan, snapshot, payoff, and collateral-lineage records.

Every asset linked to a payoff source is carried to the replacement effective on closing. Relinks are stored as a continuous source-to-replacement chain, and a later refinance advances the terminal link. Pre-close cancellation restores links in reverse dependency order. Direct edits, deletes, restores, or cancellations that would break committed lineage are rejected before mutation.

A replacement loan can become the source of a later refinance after it exists. Stacked plans are evaluated chronologically: a loan can be retired only once, same-instant and circular chains are rejected, and a plan with a dependent later refinance cannot be cancelled before that later plan. These rules allow repeated refinancing without duplicating principal, payments, or bank cash.

## Net worth

Liquid net position, contractual net worth, and economic net worth are separate. Cash excluded from liquidity is still owned and therefore remains in contractual and economic net worth; it is excluded only from liquid position, global floors, and funding capacity. Assets marked immediately liquid enter liquid position once; paid-off loans remain historical but do not remain liabilities or accrue dashboard interest. A retirement-plan loan remains a contractual liability but can be excluded from a second economic subtraction when its related investment value already reflects the withdrawal. Credit limits and available credit never count as liquidity or assets. Current cash and receivable inputs are rolled from the same dated ledger used by Cash Forecast, so Money Owed, Net Worth, and Overview cannot disagree merely because a stored snapshot is old.

## Historical and future charts

Charts are a read model over existing dated evidence and the native forecast, not a second ledger. The default window is 12 months before and 12 months after the current financial date. Historical points come only from observed, reported, or dated valuation evidence; missing history remains blank. Future cash, total position, card balances, loan balances, investment values, Money Owed, and net-worth trajectories use the same projected or amortized records as their source pages and retain provenance so observed and modeled segments can be distinguished.

Summary metrics are derived from available points rather than fabricated interpolation. Monthly card balance uses the latest available card point in each month, Money Owed uses available daily forecast balances, and carry is a persistent per-card residual: an underpaid statement remains in each later month until later evidence clears that card. A full payment on another card cannot clear it. Net-worth trajectory holds the latest asset valuations constant unless newer dated values exist, while liabilities and cash continue through their native schedules.

## Workbook reference boundary

A user-selected workbook may provide optional import facts and local comparison expectations. Its cells, formulas, named ranges, and cached calculations never execute as application mechanics. Forecasts are produced only by normalized domain records and the native engine; any comparison with a read-only workbook happens after calculation.

Parity is classified, not forced. A matching native result confirms the normalized inputs and mechanics. A difference must be traced to a missing or misclassified native fact, a timing or ordering defect, an explicitly different product rule, or a demonstrable workbook defect. Only the first two justify changing the application. Private workbook values, screenshots, comparison reports, and populated databases stay in ignored local evidence and are never committed.

## Core invariants

- Every forecast belongs to exactly one user.
- Every event references a known account.
- Cancelled and skipped events do not forecast.
- Uncertain inflows cannot fund a forecast.
- Traced direct-cash and card assumptions cannot represent the same obligation twice.
- A net paycheck and a separately modeled payroll deduction cannot share the same source lineage.
- A routed paycheck's destination legs must sum exactly to its total take-home; only those legs enter cash.
- Every routed paycheck allocation uses a unique account, and its guided setup has exactly one remainder destination.
- A routed paycheck's first official payday must belong to its declared recurrence, and a plan or allocation identity cannot be reused as an implicit partial edit.
- A linked raise must remain on its recurring base-pay schedule; base edits either update every dependent timing field together or do not save.
- A committed refinance must pay off at least one unique source loan, and a source loan can be retired by only one active commitment.
- A replacement loan cannot precede its closing, its source payoff cannot precede closing, and its first payment must follow closing. The first replacement payment and source payoff are otherwise independent, so both payment schedules may temporarily overlap when lender settlement is delayed.
- Replacement principal must reconcile exactly to source payoffs, principal cash contribution, financed fees, and excess proceeds.
- Lender-to-lender refinance payoff never enters a cash account; only explicit closing cash and excess proceeds do.
- A stacked refinance must follow its source commitment chronologically and cannot form a cycle.
- Every restored refinance requires an immutable replacement-offer snapshot and an explicit durable relink array. Committed source/replacement lifecycle and cash-inclusion flags cannot contradict the plan.
- A committed collateral chain must be continuous, reference available assets and loans, and end at the asset's stored terminal liability. A future replacement link requires the complete earlier relink chain so before-close views and cancellation can reverse it safely.
- Account shortfalls and negative floor margins remain visible.
- Intraday account shortfalls remain diagnostic; an actionable funding episode begins only when the account closes below its floor.
- A funding episode ends when that account closes back at or above its floor; its first and deepest requirements cannot be conflated with a later episode.
- In-transit transfer cash remains in consolidated ownership but is unavailable to source and destination accounts.
- The same source-account surplus cannot fund more than one simultaneous transfer recommendation.
- The same projected receivable balance cannot cover more than one funding recommendation.
- A received-cash record cannot be dated after the current financial date.
- A recurring receipt or settlement can offset only its linked occurrence.
- A release-only receivable cannot create bank cash without an explicit release event and destination account.
- An actual card underpayment creates carry, while overpayment creates only a future balance credit and never negative carry.
- Non-liquid cash remains an owned asset even though it cannot fund Spending Power.
- Workbook cells and formulas never execute as application mechanics; a workbook is optional read-only import and comparison evidence.
