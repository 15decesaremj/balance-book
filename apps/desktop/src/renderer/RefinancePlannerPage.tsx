import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Text,
  Textarea,
  Title1,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import { useNavigate, useSearchParams } from 'react-router';
import {
  analyzeDatedLoanSchedule,
  analyzeLoanContinuationFromPayoff,
  calculateDatedLoanPayment,
  compareRefinance,
  evaluateCommittedRefinanceForecast,
  projectRefinancePayoffsAtDate,
} from '@balance-book/financial-engine';
import {
  addDays,
  addMonthsConstrained,
  committedRefinancePlanSchema,
  compareDates,
  loanSchema,
  type CommittedRefinancePlan,
  type ForecastEvent,
  type Loan,
  type MoneyCents,
  type PlainDateString,
} from '@balance-book/domain';
import type {
  CommitRefinancePlanRequest,
  ForecastSnapshotDto,
  ManagedRecordsDto,
} from '../shared/contracts';
import {
  calculateRefinanceSettlement,
  pairRefinanceLoansWithPayoffs,
  refinanceLoanCandidates,
  refinancePlanLifecycle,
  type RefinanceLoanPayoffPair,
} from './refinance-view-model';
import { dollarsToCents, formatMoney } from './utils';
import { LoadingSkeleton } from './LoadingSkeleton';

const useStyles = makeStyles({
  header: {
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXXL,
    maxWidth: '900px',
    '& h1': { letterSpacing: '-0.035em' },
  },
  panel: {
    padding: tokens.spacingHorizontalXL,
    marginBottom: tokens.spacingVerticalXL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  form: { display: 'grid', gap: tokens.spacingVerticalL },
  formSection: {
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'grid',
    gap: tokens.spacingVerticalL,
    '&[hidden]': { display: 'none' },
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  stack: { display: 'grid', gap: tokens.spacingVerticalM },
  compact: { display: 'grid', gap: tokens.spacingVerticalXS },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
  },
  recordHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
  },
  recordGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(250px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  compactCard: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  amount: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  positive: { color: tokens.colorPaletteGreenForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  decisionPanel: {
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  stepper: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  stickySummary: {
    position: 'sticky',
    top: tokens.spacingVerticalM,
    zIndex: 3,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
  },
  comparisonScroll: { overflowX: 'auto' },
  comparisonTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontVariantNumeric: 'tabular-nums',
    '& th, & td': {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    '& th': {
      color: tokens.colorNeutralForeground3,
      fontSize: tokens.fontSizeBase200,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    },
    '& th:not(:first-child), & td:not(:first-child)': { textAlign: 'right' },
    '@media (max-width: 640px)': {
      '& thead': { display: 'none' },
      '& tr': {
        display: 'grid',
        gap: tokens.spacingVerticalXS,
        padding: tokens.spacingVerticalM,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      },
      '& td, & td:not(:first-child)': {
        padding: 0,
        borderBottomStyle: 'none',
        textAlign: 'left',
      },
      '& td::before': {
        content: 'attr(data-label)',
        display: 'block',
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
      },
    },
  },
});

type ForecastAccountComparison = {
  accountId: string;
  accountName: string;
  currentLowCents: number;
  currentLowDate: string;
  proposedLowCents: number;
  proposedLowDate: string;
};

type PlannerResult = ReturnType<typeof compareRefinance> & {
  currentCostKnown: boolean;
  currentTermKnown: boolean;
  currentMonthlyDebtServiceCents: number;
  currentMonthlyCashDraftCents: number;
  newMonthlyCashDraftCents: number;
  monthlyCashDraftChangeCents: number;
  currentMaturityPaymentCents: number;
  currentTermMonths: number;
  newTermMonths: number;
  plan: CommittedRefinancePlan;
  commitRequest: CommitRefinancePlanRequest;
  totalPayoffCents: number;
  maturityPaymentCents: number;
  forecastImpact: {
    horizonStart: string;
    horizonEnd: string;
    originalHorizonEnd: string;
    horizonExtended: boolean;
    currentConsolidatedLowCents: number;
    currentConsolidatedLowDate: string;
    proposedConsolidatedLowCents: number;
    proposedConsolidatedLowDate: string;
    currentAvailableToDeployCents: number;
    proposedAvailableToDeployCents: number;
    accounts: ForecastAccountComparison[];
  };
};

const get = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();
const cents = (value: string): MoneyCents => dollarsToCents(value);
const formatDifference = (valueCents: number): string =>
  valueCents > 0 ? `+${formatMoney(valueCents)}` : formatMoney(valueCents);
const formatMonths = (value: number): string =>
  value === 0 ? 'No change' : `${value > 0 ? '+' : ''}${value} months`;

export const averageMonthlyLoanPayments = (
  loans: ReadonlyArray<Pick<Loan, 'paymentCents' | 'cashPaymentCents' | 'paymentFrequency'>>,
): { debtServiceCents: MoneyCents; cashDraftCents: MoneyCents } => {
  const totals = loans.reduce(
    (sum, loan) => {
      const monthlyFactor = loan.paymentFrequency === 'biweekly' ? 26 / 12 : 1;
      return {
        debtServiceCents: sum.debtServiceCents + loan.paymentCents * monthlyFactor,
        cashDraftCents:
          sum.cashDraftCents + (loan.cashPaymentCents ?? loan.paymentCents) * monthlyFactor,
      };
    },
    { debtServiceCents: 0, cashDraftCents: 0 },
  );
  return {
    debtServiceCents: Math.round(totals.debtServiceCents),
    cashDraftCents: Math.round(totals.cashDraftCents),
  };
};

export const replacementLoanPaymentMetadata = (input: {
  debtPaymentCents: MoneyCents;
  cashPaymentCents?: MoneyCents;
  originalTermMonths: number;
}): {
  paymentCents: MoneyCents;
  cashPaymentCents: MoneyCents;
  originalTermMonths: number;
} => {
  const cashPaymentCents = input.cashPaymentCents ?? input.debtPaymentCents;
  if (cashPaymentCents < input.debtPaymentCents) {
    throw new Error('The total monthly cash draft cannot be below the debt payment.');
  }
  return {
    paymentCents: input.debtPaymentCents,
    cashPaymentCents,
    originalTermMonths: input.originalTermMonths,
  };
};

export const analyzeCurrentRefinanceContinuations = (input: {
  loanPayoffPairs: readonly RefinanceLoanPayoffPair[];
  payoffDate: PlainDateString;
  loanPaymentEvents?: readonly ForecastEvent[];
  actualThroughDate?: PlainDateString;
}): ReturnType<typeof analyzeLoanContinuationFromPayoff>[] =>
  input.loanPayoffPairs.map(({ loan, payoff }) =>
    analyzeLoanContinuationFromPayoff({
      loan,
      payoffDate: input.payoffDate,
      payoffAmountCents: payoff.projection.payoffCents,
      loanPaymentEvents: input.loanPaymentEvents,
      actualThroughDate: input.actualThroughDate,
    }),
  );

const loadRecords = async (): Promise<ManagedRecordsDto> => {
  const result = await window.balanceBook.listRecords();
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const lifecycleLabel = (lifecycle: ReturnType<typeof refinancePlanLifecycle>): string => {
  switch (lifecycle) {
    case 'cancelled':
      return 'Cancelled';
    case 'upcoming':
      return 'Committed · upcoming';
    case 'settling':
      return 'Closed · payoff pending';
    case 'active':
      return 'Current replacement loan';
    case 'completed':
      return 'Completed on its recorded schedule';
    case 'scheduled-to-refinance':
      return 'Current · another refinance is scheduled';
    case 'refinanced-again':
      return 'Refinanced again';
  }
};

export const RefinancePlannerPage = ({
  experimentalCardInterestForecastEnabled,
}: {
  experimentalCardInterestForecastEnabled: boolean;
}): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedLoanId = searchParams.get('loan');
  const systemToday = Temporal.Now.plainDateISO().toString();
  const [today, setToday] = useState(systemToday);
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [forecast, setForecast] = useState<ForecastSnapshotDto | null>(null);
  const [selectedLoanIds, setSelectedLoanIds] = useState<string[]>([]);
  const [closingDate, setClosingDate] = useState(today);
  const [separatePayoffDate, setSeparatePayoffDate] = useState(false);
  const [payoffDate, setPayoffDate] = useState(today);
  const [firstPaymentDate, setFirstPaymentDate] = useState(addMonthsConstrained(today, 1));
  const [payoffQuoteOverrides, setPayoffQuoteOverrides] = useState<Record<string, string>>({});
  const [newPrincipalEdit, setNewPrincipalEdit] = useState<{
    selectionKey: string;
    value: string;
  } | null>(null);
  const [closingCosts, setClosingCosts] = useState('0.00');
  const [financedFees, setFinancedFees] = useState('0.00');
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plannerStep, setPlannerStep] = useState<1 | 2 | 3>(1);
  const busyRef = useRef(false);

  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loaded, loadedForecast]) => {
        if (!loadedForecast.ok) throw new Error(loadedForecast.error);
        setRecords(loaded);
        setForecast(loadedForecast.value);
        const startDate = loadedForecast.value.startDate ?? systemToday;
        setToday(startDate);
        const defaultClosing = addDays(startDate, 1);
        setClosingDate(defaultClosing);
        setPayoffDate(defaultClosing);
        setFirstPaymentDate(addMonthsConstrained(defaultClosing, 1));
        const candidates = refinanceLoanCandidates({
          loans: loaded.loans,
          plans: loaded.committedRefinancePlans,
          loanPaymentEvents: loaded.events,
          asOfDate: startDate,
        });
        const requested = candidates.find((candidate) => candidate.loan.id === requestedLoanId);
        setSelectedLoanIds(
          requested ? [requested.loan.id] : candidates[0] ? [candidates[0].loan.id] : [],
        );
      })
      .catch((caught: Error) => setError(caught.message));
  }, [requestedLoanId, systemToday]);

  const candidates = useMemo(
    () =>
      records
        ? refinanceLoanCandidates({
            loans: records.loans,
            plans: records.committedRefinancePlans,
            loanPaymentEvents: records.events,
            asOfDate: today,
          })
        : [],
    [records, today],
  );
  const selectedCandidates = candidates.filter((candidate) =>
    selectedLoanIds.includes(candidate.loan.id),
  );
  const selectedLoans = selectedCandidates.map((candidate) => candidate.loan);
  const selectionKey = `${payoffDate}|${[...selectedLoanIds].sort().join('|')}`;
  const payoffDefaults = useMemo(() => {
    if (!records || selectedLoanIds.length === 0) {
      return { quotes: {} as Record<string, string>, principal: '0.00', error: null };
    }
    try {
      const projections = projectRefinancePayoffsAtDate({
        loans: records.loans,
        sourceLoanIds: selectedLoanIds,
        payoffDate,
        existingPlans: records.committedRefinancePlans,
        loanPaymentEvents: records.events,
        actualThroughDate: today,
      });
      return {
        quotes: Object.fromEntries(
          projections.map((payoff) => [
            payoff.sourceLoanId,
            (payoff.payoffAmountCents / 100).toFixed(2),
          ]),
        ),
        principal: (
          projections.reduce((total, payoff) => total + payoff.payoffAmountCents, 0) / 100
        ).toFixed(2),
        error: null,
      };
    } catch (caught) {
      return {
        quotes: {} as Record<string, string>,
        principal: '0.00',
        error: caught instanceof Error ? caught.message : 'Payoff estimates could not be prepared.',
      };
    }
  }, [payoffDate, records, selectedLoanIds, today]);
  const payoffQuotes = Object.fromEntries(
    selectedLoanIds.map((loanId) => [
      loanId,
      payoffQuoteOverrides[`${selectionKey}|${loanId}`] ?? payoffDefaults.quotes[loanId] ?? '',
    ]),
  );
  const newPrincipal =
    newPrincipalEdit?.selectionKey === selectionKey
      ? newPrincipalEdit.value
      : payoffDefaults.principal;

  const settlement = useMemo(() => {
    try {
      if (selectedLoanIds.length === 0) return null;
      return calculateRefinanceSettlement({
        payoffAmountsCents: selectedLoanIds.map((loanId) => cents(payoffQuotes[loanId] ?? '0')),
        newPrincipalCents: cents(newPrincipal),
        closingCostsCents: cents(closingCosts),
        financedFeesCents: cents(financedFees),
      });
    } catch {
      return null;
    }
  }, [closingCosts, financedFees, newPrincipal, payoffQuotes, selectedLoanIds]);

  const toggleLoan = (loanId: string, checked: boolean): void => {
    setSelectedLoanIds((current) =>
      checked ? [...current, loanId] : current.filter((candidate) => candidate !== loanId),
    );
    setResult(null);
    setMessage(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setResult(null);
    setError(null);
    try {
      if (!records || !records.policy || !forecast?.startDate) {
        throw new Error('Complete cash-account and guardrail setup before planning a refinance.');
      }
      if (payoffDefaults.error) throw new Error(payoffDefaults.error);
      if (selectedLoans.length === 0) throw new Error('Select at least one loan to pay off.');
      if (
        selectedCandidates.length !== selectedLoanIds.length ||
        new Set(selectedLoanIds).size !== selectedLoanIds.length
      ) {
        throw new Error('Loan availability changed; review the refreshed selection and try again.');
      }
      if (compareDates(payoffDate, closingDate) < 0) {
        throw new Error('The old lender payoff cannot post before the refinance closes.');
      }
      if (compareDates(closingDate, addDays(forecast.startDate, 3_650)) > 0) {
        throw new Error('Choose a refinance closing date within the next 10 years.');
      }
      if (compareDates(payoffDate, addDays(closingDate, 366)) > 0) {
        throw new Error('The old lender payoff must settle within one year of closing.');
      }
      if (compareDates(firstPaymentDate, closingDate) <= 0) {
        throw new Error('The first new-loan payment must be after the refinance closing date.');
      }
      if (compareDates(firstPaymentDate, addDays(closingDate, 366)) > 0) {
        throw new Error('The first new-loan payment must be within one year of closing.');
      }
      for (const candidate of selectedCandidates) {
        if (compareDates(closingDate, candidate.availableOn) <= 0) {
          throw new Error(
            `${candidate.loan.name} can only be refinanced after its source payoff settles.`,
          );
        }
      }
      const form = new FormData(event.currentTarget);
      const payoffProjections = projectRefinancePayoffsAtDate({
        loans: records.loans,
        sourceLoanIds: selectedLoanIds,
        payoffDate,
        existingPlans: records.committedRefinancePlans,
        loanPaymentEvents: records.events,
        actualThroughDate: today,
      });
      const payoffs = payoffProjections.map((payoff) => ({
        sourceLoanId: payoff.sourceLoanId,
        payoffAmountCents: cents(payoffQuotes[payoff.sourceLoanId] ?? '0'),
        ...(payoff.sourceRefinancePlanId
          ? { sourceRefinancePlanId: payoff.sourceRefinancePlanId }
          : {}),
      }));
      const breakdown = calculateRefinanceSettlement({
        payoffAmountsCents: payoffs.map((payoff) => payoff.payoffAmountCents),
        newPrincipalCents: cents(newPrincipal),
        closingCostsCents: cents(closingCosts),
        financedFeesCents: cents(financedFees),
      });
      const paymentAccountId = get(form, 'paymentAccountId');
      const cashSourceAccountId =
        breakdown.totalBankOutflowCents > 0 ? get(form, 'cashSourceAccountId') : undefined;
      const excessProceedsAccountId =
        breakdown.excessProceedsCents > 0 ? get(form, 'excessProceedsAccountId') : undefined;
      const newTermMonths = Number(get(form, 'newTerm'));
      if (!Number.isInteger(newTermMonths) || newTermMonths <= 0 || newTermMonths > 600) {
        throw new Error('New loan term must be a whole number from 1 to 600 months.');
      }
      const newAprBasisPoints = new Decimal(get(form, 'newApr'))
        .mul(100)
        .toDecimalPlaces(0)
        .toNumber();
      const replacementLoanId = crypto.randomUUID();
      const planId = crypto.randomUUID();
      const planName = get(form, 'planName');
      const userId = selectedLoans[0]!.userId;
      const replacementTemplate: Omit<Loan, 'userId'> = {
        id: replacementLoanId,
        name: get(form, 'newLoanName'),
        ...(get(form, 'newLender') ? { lender: get(form, 'newLender') } : {}),
        ...(get(form, 'newLoanType') ? { loanType: get(form, 'newLoanType') } : {}),
        principalCents: cents(newPrincipal),
        accruedInterestCents: 0,
        balanceDate: closingDate,
        annualRateBasisPoints: newAprBasisPoints,
        accrualConvention: get(form, 'accrualConvention') as Loan['accrualConvention'],
        paymentCents: 1,
        nextPaymentDate: firstPaymentDate,
        maturityDate: addMonthsConstrained(firstPaymentDate, newTermMonths - 1),
        originalPrincipalCents: cents(newPrincipal),
        originalDate: closingDate,
        originalTermMonths: newTermMonths,
        amortizationStructure: 'fully-amortizing',
        fundingAccountId: paymentAccountId,
        excludeFromEconomicNetWorthDoubleCount:
          form.get('excludeFromEconomicNetWorthDoubleCount') === 'on',
        paymentFrequency: 'monthly',
        includeInCashForecast: true,
        status: 'active',
      };
      const quotedNewPayment = get(form, 'newPayment') ? cents(get(form, 'newPayment')) : undefined;
      const effectiveNewPaymentCents =
        quotedNewPayment ??
        calculateDatedLoanPayment(loanSchema.parse({ ...replacementTemplate, userId }));
      const quotedNewCashPayment = get(form, 'newCashPayment')
        ? cents(get(form, 'newCashPayment'))
        : undefined;
      const newPaymentMetadata = replacementLoanPaymentMetadata({
        debtPaymentCents: effectiveNewPaymentCents,
        cashPaymentCents: quotedNewCashPayment,
        originalTermMonths: newTermMonths,
      });
      const replacementLoan: Omit<Loan, 'userId'> = {
        ...replacementTemplate,
        ...newPaymentMetadata,
      };
      const datedReplacement = analyzeDatedLoanSchedule(
        loanSchema.parse({ ...replacementLoan, userId }),
      );
      const loanPayoffPairs = pairRefinanceLoansWithPayoffs({
        loans: selectedLoans,
        payoffs: payoffProjections,
      });
      const currentContinuations = analyzeCurrentRefinanceContinuations({
        loanPayoffPairs,
        payoffDate,
        loanPaymentEvents: records.events,
        actualThroughDate: today,
      });
      const currentCostKnown = currentContinuations.every((analysis) => analysis.costKnown);
      const currentTermKnown = currentContinuations.every((analysis) => analysis.termKnown);
      const currentTermMonths = Math.max(
        0,
        ...currentContinuations.map((analysis) => analysis.remainingTermMonths ?? 0),
      );
      const currentMonthlyPayments = averageMonthlyLoanPayments(selectedLoans);
      const currentMonthlyPaymentCents = currentMonthlyPayments.debtServiceCents;
      const currentTotalBalanceCents = payoffProjections.reduce(
        (total, payoff) => total + payoff.projection.payoffCents,
        0,
      );
      const currentRemainingInterestCents = currentContinuations.reduce(
        (total, analysis) => total + (analysis.remainingInterestCents ?? 0),
        0,
      );
      const currentTotalRemainingCostCents = currentCostKnown
        ? currentContinuations.reduce((total, analysis) => total + analysis.totalPaymentsCents, 0)
        : currentTotalBalanceCents;
      const currentMaturityPaymentCents = currentContinuations.reduce(
        (total, analysis) => total + analysis.maturityPaymentCents,
        0,
      );
      const weightedCurrentApr = Math.round(
        loanPayoffPairs.reduce(
          (total, { loan, payoff }) =>
            total + loan.annualRateBasisPoints * payoff.projection.payoffCents,
          0,
        ) / Math.max(1, currentTotalBalanceCents),
      );
      const comparisonBase = compareRefinance({
        currentPayoffCents: currentTotalBalanceCents,
        currentPaymentCents: currentMonthlyPaymentCents,
        currentRemainingPayments: Math.max(1, currentTermMonths || newTermMonths),
        currentAnnualRateBasisPoints: weightedCurrentApr,
        newPrincipalCents: cents(newPrincipal),
        newAnnualRateBasisPoints: newAprBasisPoints,
        newPaymentCents: effectiveNewPaymentCents,
        newTermMonths,
        feesCents: breakdown.cashPaidClosingCostsCents,
        cashAtClosingCents: breakdown.principalCashContributionCents,
        cashProceedsCents: breakdown.excessProceedsCents,
      });
      const exactNewTotalCostCents =
        datedReplacement.totalPaymentsCents +
        breakdown.cashPaidClosingCostsCents +
        breakdown.principalCashContributionCents -
        breakdown.excessProceedsCents;
      const comparison = {
        ...comparisonBase,
        effectiveNewPaymentCents,
        currentTotalRemainingCostCents,
        currentRemainingInterestCents,
        currentCostKnown,
        currentTermKnown,
        currentMonthlyDebtServiceCents: currentMonthlyPayments.debtServiceCents,
        currentMonthlyCashDraftCents: currentMonthlyPayments.cashDraftCents,
        newMonthlyCashDraftCents: newPaymentMetadata.cashPaymentCents,
        monthlyCashDraftChangeCents:
          newPaymentMetadata.cashPaymentCents - currentMonthlyPayments.cashDraftCents,
        currentMaturityPaymentCents,
        newRemainingInterestCents: datedReplacement.remainingInterestCents,
        newResidualBalanceCents: datedReplacement.balloonCents,
        newTotalCostCents: exactNewTotalCostCents,
        monthlyPaymentChangeCents: effectiveNewPaymentCents - currentMonthlyPaymentCents,
        totalCostChangeCents: currentCostKnown
          ? exactNewTotalCostCents - currentTotalRemainingCostCents
          : 0,
        termChangeMonths: currentTermKnown ? newTermMonths - currentTermMonths : 0,
      };
      const commitRequest: CommitRefinancePlanRequest = {
        id: planId,
        name: planName,
        closingDate,
        payoffDate,
        firstPaymentDate,
        payoffs,
        replacementLoan,
        principalCashContributionCents: breakdown.principalCashContributionCents,
        closingCostsCents: cents(closingCosts),
        financedFeesCents: cents(financedFees),
        ...(cashSourceAccountId ? { cashSourceAccountId } : {}),
        excessProceedsCents: breakdown.excessProceedsCents,
        ...(excessProceedsAccountId ? { excessProceedsAccountId } : {}),
        ...(get(form, 'notes') ? { notes: get(form, 'notes') } : {}),
      };
      const plan = committedRefinancePlanSchema.parse({
        ...commitRequest,
        userId,
        status: 'committed',
        replacementLoan: { ...replacementLoan, userId },
      });
      const evaluation = evaluateCommittedRefinanceForecast({
        accounts: records.accounts,
        events: records.events,
        cards: records.cards,
        cardCycles: records.cardCycles,
        loans: records.loans,
        receivables: records.receivables,
        includeCardInterest: experimentalCardInterestForecastEnabled,
        policy: records.policy,
        requestedStartDate: forecast.startDate,
        existingPlans: records.committedRefinancePlans,
        plan,
      });
      const affectedAccountIds = new Set(
        [
          paymentAccountId,
          cashSourceAccountId,
          excessProceedsAccountId,
          ...selectedLoans.map((loan) => loan.fundingAccountId),
        ].filter((accountId): accountId is string => Boolean(accountId)),
      );
      const accountNameById = new Map(
        records.accounts.map((account) => [account.id, account.name]),
      );
      const accountComparisons = [...affectedAccountIds].map((accountId) => {
        const current = evaluation.baseline.conservative.accountTroughs.find(
          (trough) => trough.accountId === accountId,
        );
        const proposed = evaluation.proposed.conservative.accountTroughs.find(
          (trough) => trough.accountId === accountId,
        );
        if (!current || !proposed) {
          throw new Error('An affected bank account could not be evaluated in the forecast.');
        }
        return {
          accountId,
          accountName: accountNameById.get(accountId) ?? 'Unknown account',
          currentLowCents: current.balanceCents,
          currentLowDate: current.date,
          proposedLowCents: proposed.balanceCents,
          proposedLowDate: proposed.date,
        };
      });
      setResult({
        ...comparison,
        currentTermMonths,
        newTermMonths,
        plan,
        commitRequest,
        totalPayoffCents: breakdown.totalPayoffCents,
        maturityPaymentCents: datedReplacement.maturityPaymentCents,
        forecastImpact: {
          horizonStart: evaluation.startDate,
          horizonEnd: evaluation.endDate,
          originalHorizonEnd: evaluation.originalHorizonEndDate,
          horizonExtended: evaluation.horizonExtended,
          currentConsolidatedLowCents: evaluation.baseline.conservative.consolidatedTroughCents,
          currentConsolidatedLowDate: evaluation.baseline.conservative.consolidatedTroughDate,
          proposedConsolidatedLowCents: evaluation.proposed.conservative.consolidatedTroughCents,
          proposedConsolidatedLowDate: evaluation.proposed.conservative.consolidatedTroughDate,
          currentAvailableToDeployCents: evaluation.baseline.availableToDeployCents,
          proposedAvailableToDeployCents: evaluation.proposed.availableToDeployCents,
          accounts: accountComparisons,
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The refinance could not be compared.');
    }
  };

  const commitPlan = async (): Promise<void> => {
    if (!result || busyRef.current) return;
    if (
      !window.confirm(
        `Use ${result.plan.name} going forward? Balance Book will schedule the old-loan payoff, closing cash, cash-out proceeds, and the new loan payments on the entered dates.`,
      )
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await window.balanceBook.commitRefinancePlan(result.commitRequest);
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setSelectedLoanIds([]);
      setResult(null);
      setMessage(
        `${result.plan.name} is now in the live plan. Old payments stop on ${result.plan.payoffDate}; the new payment starts on ${result.plan.firstPaymentDate}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The refinance plan could not be saved.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const cancelPlan = async (plan: CommittedRefinancePlan): Promise<void> => {
    if (busyRef.current || !window.confirm(`Cancel the upcoming ${plan.name} refinance plan?`))
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await window.balanceBook.cancelRefinancePlan({
        planId: plan.id,
        confirmed: true,
      });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      const availableIds = new Set(
        refinanceLoanCandidates({
          loans: response.value.loans,
          plans: response.value.committedRefinancePlans,
          loanPaymentEvents: response.value.events,
          asOfDate: today,
        }).map((candidate) => candidate.loan.id),
      );
      setSelectedLoanIds((current) => [
        ...new Set(current.filter((loanId) => availableIds.has(loanId))),
      ]);
      setResult(null);
      setMessage(`${plan.name} was cancelled. Its future cash and loan changes were removed.`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The refinance plan could not be cancelled.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!records || !forecast)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading refinance planner" variant="form" />
    );

  const forecastStartDate = forecast.startDate ?? today;
  const visibleError = error ?? payoffDefaults.error;
  const selectedNames = selectedLoans.map((loan) => loan.name).join(' + ');
  const consolidatedLowChange = result
    ? result.forecastImpact.proposedConsolidatedLowCents -
      result.forecastImpact.currentConsolidatedLowCents
    : 0;
  const decisionHeadline = !result
    ? ''
    : result.newResidualBalanceCents > 0
      ? 'The quoted payment creates a maturity balloon'
      : !result.currentCostKnown
        ? 'The offer is fully modeled; the current lifetime cost needs more loan detail'
        : result.monthlyPaymentChangeCents < 0 && result.totalCostChangeCents < 0
          ? 'The offer lowers both payment burden and total remaining cost'
          : result.monthlyPaymentChangeCents < 0 && result.totalCostChangeCents > 0
            ? 'The payment falls, but total remaining cost rises'
            : result.monthlyPaymentChangeCents > 0 && result.totalCostChangeCents < 0
              ? 'Total remaining cost falls, but the payment rises'
              : 'Review the cash timing and total cost together';

  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Refinance planner</Title1>
        <Text>Compare an offer, review payment timing and cost, then add it to your plan.</Text>
      </div>

      {(message || visibleError) && (
        <Card className={styles.panel}>
          {message && (
            <div role="status" className={styles.positive}>
              {message}
            </div>
          )}
          {visibleError && (
            <div role="alert" className={styles.error}>
              {visibleError}
            </div>
          )}
        </Card>
      )}

      {candidates.length === 0 ? (
        <Card className={styles.panel}>
          <Title2 as="h2">No uncommitted loan is available</Title2>
          <Text>Add a loan, or review the committed refinance plans below.</Text>
          <Button appearance="primary" onClick={() => navigate('/loans')}>
            Add or review loans
          </Button>
        </Card>
      ) : (
        <Card className={styles.panel}>
          <form
            key={selectedLoanIds.join('|') || 'no-selected-loans'}
            className={styles.form}
            onSubmit={submit}
            onChange={() => setResult(null)}
          >
            <div className={styles.stepper} aria-label="Refinance steps">
              {(
                [
                  [1, 'Loans and timing'],
                  [2, 'New loan'],
                  [3, 'Cash and review'],
                ] as const
              ).map(([step, label]) => (
                <Button
                  key={step}
                  type="button"
                  size="small"
                  appearance={plannerStep === step ? 'primary' : 'subtle'}
                  onClick={() => setPlannerStep(step)}
                >
                  {step}. {label}
                </Button>
              ))}
            </div>
            <aside className={styles.stickySummary} aria-label="Refinance working summary">
              <div className={styles.compact}>
                <Text className={styles.muted}>Replacing</Text>
                <strong>{selectedNames || 'Choose loans'}</strong>
              </div>
              <div className={styles.compact}>
                <Text className={styles.muted}>Modeled payoff</Text>
                <strong>{formatMoney(settlement?.totalPayoffCents ?? 0)}</strong>
              </div>
              <div className={styles.compact}>
                <Text className={styles.muted}>New principal</Text>
                <strong>
                  {formatMoney(
                    Number.isFinite(Number(newPrincipal))
                      ? Math.round(Number(newPrincipal) * 100)
                      : 0,
                  )}
                </strong>
              </div>
              <div className={styles.compact}>
                <Text className={styles.muted}>Closing / first payment</Text>
                <strong>
                  {closingDate} / {firstPaymentDate}
                </strong>
              </div>
            </aside>
            <section
              hidden={plannerStep !== 1}
              className={styles.formSection}
              aria-labelledby="payoff-section-title"
            >
              <div className={styles.compact}>
                <Title2 id="payoff-section-title" as="h2">
                  1. Loans and payoff timing
                </Title2>
                <Text>
                  Select every loan the new lender will pay. Estimates include interest and every
                  scheduled payment before the payoff date; replace them with lender quotes when
                  available.
                </Text>
              </div>
              <div className={styles.stack} role="group" aria-label="Loans to pay off">
                {candidates.map((candidate) => (
                  <Checkbox
                    key={candidate.loan.id}
                    checked={selectedLoanIds.includes(candidate.loan.id)}
                    onChange={(_, data) => toggleLoan(candidate.loan.id, data.checked === true)}
                    label={`${candidate.loan.name}${compareDates(candidate.availableOn, today) > 0 ? ` · available after ${candidate.availableOn}` : ''}`}
                  />
                ))}
              </div>
              <div className={styles.grid}>
                <Field label="Refinance closing date">
                  <Input
                    type="date"
                    required
                    min={addDays(forecastStartDate, 1)}
                    max={addDays(forecastStartDate, 3_650)}
                    value={closingDate}
                    onChange={(event) => {
                      const value = event.target.value;
                      setClosingDate(value);
                      if (!separatePayoffDate) setPayoffDate(value);
                      if (value) setFirstPaymentDate(addMonthsConstrained(value, 1));
                    }}
                  />
                </Field>
                {separatePayoffDate && (
                  <Field label="Old lender payoff date">
                    <Input
                      type="date"
                      required
                      min={closingDate || undefined}
                      max={closingDate ? addDays(closingDate, 366) : undefined}
                      value={payoffDate}
                      onChange={(event) => setPayoffDate(event.target.value)}
                    />
                  </Field>
                )}
                <Field label="First new-loan payment date">
                  <Input
                    type="date"
                    required
                    min={closingDate ? addDays(closingDate, 1) : undefined}
                    max={closingDate ? addDays(closingDate, 366) : undefined}
                    value={firstPaymentDate}
                    onChange={(event) => setFirstPaymentDate(event.target.value)}
                  />
                </Field>
              </div>
              <Checkbox
                checked={separatePayoffDate}
                onChange={(_, data) => {
                  const checked = data.checked === true;
                  setSeparatePayoffDate(checked);
                  if (!checked) setPayoffDate(closingDate);
                }}
                label="The old lender payoff posts after closing"
              />
              {selectedLoans.length > 0 && (
                <div className={styles.recordGrid}>
                  {selectedLoans.map((loan) => (
                    <div className={styles.compactCard} key={loan.id}>
                      <strong>{loan.name}</strong>
                      <Text className={styles.muted}>
                        {loan.paymentFrequency === 'biweekly' ? 'Every two weeks' : 'Monthly'} debt
                        service {formatMoney(loan.paymentCents)} · cash draft{' '}
                        {formatMoney(loan.cashPaymentCents ?? loan.paymentCents)} ·{' '}
                        {(loan.annualRateBasisPoints / 100).toFixed(2)}%
                      </Text>
                      <Field label={`Payoff quote for ${loan.name}`}>
                        <Input
                          inputMode="decimal"
                          required
                          value={payoffQuotes[loan.id] ?? ''}
                          onChange={(event) =>
                            setPayoffQuoteOverrides((current) => ({
                              ...current,
                              [`${selectionKey}|${loan.id}`]: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Text className={styles.muted}>
                        Modeled through {payoffDate}; same-day payment excluded.
                      </Text>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section
              hidden={plannerStep !== 2}
              className={styles.formSection}
              aria-labelledby="new-loan-section-title"
            >
              <div className={styles.compact}>
                <Title2 id="new-loan-section-title" as="h2">
                  2. New loan
                </Title2>
                <Text>
                  Enter the lender offer. If payment is blank, Balance Book calculates the monthly
                  payment.
                </Text>
              </div>
              <div className={styles.grid}>
                <Field label="Plan name">
                  <Input
                    name="planName"
                    required
                    defaultValue={`${selectedNames || 'New'} refinance`}
                  />
                </Field>
                <Field label="New loan name">
                  <Input
                    name="newLoanName"
                    required
                    defaultValue={`${selectedNames || 'Replacement'} loan`}
                  />
                </Field>
                <Field label="New lender (optional)">
                  <Input name="newLender" />
                </Field>
                <Field label="Loan type (optional)">
                  <Input name="newLoanType" placeholder="Auto, personal, mortgage…" />
                </Field>
                <Field label="New principal">
                  <Input
                    inputMode="decimal"
                    required
                    value={newPrincipal}
                    onChange={(event) =>
                      setNewPrincipalEdit({
                        selectionKey,
                        value: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="New APR">
                  <Input name="newApr" inputMode="decimal" required defaultValue="0.00" />
                </Field>
                <Field
                  label="Monthly debt payment (optional)"
                  hint="Leave blank to calculate the amortizing principal-and-interest payment."
                >
                  <Input name="newPayment" inputMode="decimal" />
                </Field>
                <Field
                  label="Total monthly cash draft (optional)"
                  hint="Include escrow, insurance, or lender-collected fees. Blank means the debt payment is the full draft."
                >
                  <Input name="newCashPayment" inputMode="decimal" />
                </Field>
                <Field label="New term months">
                  <Input
                    name="newTerm"
                    type="number"
                    min="1"
                    max="600"
                    required
                    defaultValue="60"
                  />
                </Field>
                <Field label="Payment account">
                  <Select
                    name="paymentAccountId"
                    required
                    defaultValue={selectedLoans[0]?.fundingAccountId}
                  >
                    {records.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Interest accrual method">
                  <Select
                    name="accrualConvention"
                    defaultValue={selectedLoans[0]?.accrualConvention ?? 'actual-365'}
                  >
                    <option value="actual-365">Actual/365</option>
                    <option value="actual-360">Actual/360</option>
                    <option value="monthly">Monthly approximation</option>
                  </Select>
                </Field>
              </div>
              <Text className={styles.muted}>
                This planner creates a monthly replacement schedule. Existing monthly and biweekly
                loan payments are both honored through payoff.
              </Text>
              <Checkbox
                name="excludeFromEconomicNetWorthDoubleCount"
                defaultChecked={
                  selectedLoans.length === 1 &&
                  selectedLoans[0]?.excludeFromEconomicNetWorthDoubleCount
                }
                label="The replacement debt is already reflected in a linked asset’s value"
              />
            </section>

            <section
              hidden={plannerStep !== 3}
              className={styles.formSection}
              aria-labelledby="cash-section-title"
            >
              <div className={styles.compact}>
                <Title2 id="cash-section-title" as="h2">
                  3. Money moving through your bank accounts
                </Title2>
                <Text>
                  The old-lender payoff stays lender-to-lender. Only real cash you pay or receive
                  changes bank balances.
                </Text>
              </div>
              <div className={styles.grid}>
                <Field label="Total closing and lender fees">
                  <Input
                    inputMode="decimal"
                    required
                    value={closingCosts}
                    onChange={(event) => setClosingCosts(event.target.value)}
                  />
                </Field>
                <Field label="Fees included in the new principal">
                  <Input
                    inputMode="decimal"
                    required
                    value={financedFees}
                    onChange={(event) => setFinancedFees(event.target.value)}
                  />
                </Field>
                {settlement && settlement.totalBankOutflowCents > 0 && (
                  <Field label="Account paying cash due at closing">
                    <Select
                      name="cashSourceAccountId"
                      required
                      defaultValue={selectedLoans[0]?.fundingAccountId}
                    >
                      {records.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {settlement && settlement.excessProceedsCents > 0 && (
                  <Field label="Account receiving excess refinance cash">
                    <Select
                      name="excessProceedsAccountId"
                      required
                      defaultValue={records.accounts[0]?.id}
                    >
                      {records.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>
              {settlement && (
                <div className={styles.recordGrid} aria-label="Refinance settlement breakdown">
                  <div className={styles.compactCard}>
                    <Text>Old-loan payoffs</Text>
                    <Text className={styles.amount}>
                      {formatMoney(settlement.totalPayoffCents)}
                    </Text>
                  </div>
                  <div className={styles.compactCard}>
                    <Text>Bank cash leaving</Text>
                    <Text className={styles.amount}>
                      {formatMoney(settlement.totalBankOutflowCents)}
                    </Text>
                    <Text className={styles.muted}>
                      Principal contribution plus fees not financed
                    </Text>
                  </div>
                  <div className={styles.compactCard}>
                    <Text>Bank cash received</Text>
                    <Text className={styles.amount}>
                      {formatMoney(settlement.excessProceedsCents)}
                    </Text>
                    <Text className={styles.muted}>
                      Excess principal after payoffs and financed fees
                    </Text>
                  </div>
                </div>
              )}
              <Field label="Notes (optional)">
                <Textarea name="notes" resize="vertical" />
              </Field>
            </section>

            <div className={styles.actions}>
              {plannerStep > 1 && (
                <Button type="button" onClick={() => setPlannerStep(plannerStep === 3 ? 2 : 1)}>
                  Back
                </Button>
              )}
              {plannerStep < 3 ? (
                <Button
                  appearance="primary"
                  type="button"
                  disabled={selectedLoans.length === 0}
                  onClick={() => setPlannerStep(plannerStep === 1 ? 2 : 3)}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  appearance="primary"
                  type="submit"
                  disabled={selectedLoans.length === 0 || busy}
                >
                  Compare full refinance
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      {result && (
        <section className={styles.form} aria-labelledby="refinance-decision-title">
          <Card className={`${styles.panel} ${styles.decisionPanel}`}>
            <Title2 id="refinance-decision-title" as="h2">
              {decisionHeadline}
            </Title2>
            <div className={styles.recordGrid}>
              <div className={styles.compactCard}>
                <Text>Monthly cash draft</Text>
                <Text className={styles.amount}>
                  {formatDifference(result.monthlyCashDraftChangeCents)}
                </Text>
                <Text className={styles.muted}>
                  Debt service {formatDifference(result.monthlyPaymentChangeCents)}
                </Text>
              </div>
              <div className={styles.compactCard}>
                <Text>Net remaining cash cost</Text>
                <Text className={styles.amount}>
                  {result.currentCostKnown
                    ? formatDifference(result.totalCostChangeCents)
                    : 'Not comparable yet'}
                </Text>
              </div>
              <div className={styles.compactCard}>
                <Text>Conservative cash low</Text>
                <Text className={styles.amount}>{formatDifference(consolidatedLowChange)}</Text>
              </div>
            </div>
            {result.newResidualBalanceCents > 0 && (
              <div role="alert" className={styles.warning}>
                The quoted payment requires an extra {formatMoney(result.newResidualBalanceCents)}{' '}
                at maturity. Enter the lender's fully amortizing payment before committing it.
              </div>
            )}
            {!result.currentCostKnown && (
              <div role="status" className={styles.warning}>
                At least one current loan has no maturity date and does not fully amortize from its
                recorded payment. The dated cash forecast and refinance commitment remain valid, but
                a lifetime cost comparison would be misleading until that loan detail is added.
              </div>
            )}
          </Card>

          <Card className={styles.panel}>
            <Title2 as="h2">Current plan versus offer</Title2>
            <Text className={styles.muted}>
              Cash draft includes escrow and lender-collected fees. Debt service is the amount that
              amortizes the loan and is the basis for interest and lifetime debt-cost comparisons.
            </Text>
            <div className={styles.comparisonScroll}>
              <table className={styles.comparisonTable}>
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th>Current</th>
                    <th>Offer</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Measure">Monthly cash draft</td>
                    <td data-label="Current">{formatMoney(result.currentMonthlyCashDraftCents)}</td>
                    <td data-label="Offer">{formatMoney(result.newMonthlyCashDraftCents)}</td>
                    <td data-label="Difference">
                      {formatDifference(result.monthlyCashDraftChangeCents)}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Monthly debt service</td>
                    <td data-label="Current">
                      {formatMoney(result.currentMonthlyDebtServiceCents)}
                    </td>
                    <td data-label="Offer">{formatMoney(result.effectiveNewPaymentCents)}</td>
                    <td data-label="Difference">
                      {formatDifference(result.monthlyPaymentChangeCents)}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Net remaining cash cost</td>
                    <td data-label="Current">
                      {result.currentCostKnown
                        ? formatMoney(result.currentTotalRemainingCostCents)
                        : 'Not determinable'}
                    </td>
                    <td data-label="Offer">{formatMoney(result.newTotalCostCents)}</td>
                    <td data-label="Difference">
                      {result.currentCostKnown
                        ? formatDifference(result.totalCostChangeCents)
                        : 'Needs maturity or amortizing payment'}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Remaining interest</td>
                    <td data-label="Current">
                      {result.currentCostKnown
                        ? formatMoney(result.currentRemainingInterestCents)
                        : 'Not determinable'}
                    </td>
                    <td data-label="Offer">{formatMoney(result.newRemainingInterestCents)}</td>
                    <td data-label="Difference">
                      {result.currentCostKnown
                        ? formatDifference(
                            result.newRemainingInterestCents - result.currentRemainingInterestCents,
                          )
                        : 'Needs loan detail'}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Remaining term</td>
                    <td data-label="Current">
                      {result.currentTermKnown
                        ? `${result.currentTermMonths} months`
                        : 'Open-ended'}
                    </td>
                    <td data-label="Offer">{result.newTermMonths} months</td>
                    <td data-label="Difference">
                      {result.currentTermKnown
                        ? formatMonths(result.termChangeMonths)
                        : 'Not comparable'}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Final maturity payment</td>
                    <td data-label="Current">
                      {result.currentMaturityPaymentCents > 0
                        ? formatMoney(result.currentMaturityPaymentCents)
                        : result.currentCostKnown
                          ? 'No maturity balloon'
                          : 'Maturity not recorded'}
                    </td>
                    <td data-label="Offer">{formatMoney(result.maturityPaymentCents)}</td>
                    <td data-label="Difference">
                      {result.newResidualBalanceCents > 0
                        ? `${formatMoney(result.newResidualBalanceCents)} above the quote`
                        : 'Capped automatically'}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Consolidated cash low</td>
                    <td data-label="Current">
                      {formatMoney(result.forecastImpact.currentConsolidatedLowCents)}
                      <br />
                      <Text size={200}>{result.forecastImpact.currentConsolidatedLowDate}</Text>
                    </td>
                    <td data-label="Offer">
                      {formatMoney(result.forecastImpact.proposedConsolidatedLowCents)}
                      <br />
                      <Text size={200}>{result.forecastImpact.proposedConsolidatedLowDate}</Text>
                    </td>
                    <td data-label="Difference">{formatDifference(consolidatedLowChange)}</td>
                  </tr>
                  <tr>
                    <td data-label="Measure">Safe cash available</td>
                    <td data-label="Current">
                      {formatMoney(result.forecastImpact.currentAvailableToDeployCents)}
                    </td>
                    <td data-label="Offer">
                      {formatMoney(result.forecastImpact.proposedAvailableToDeployCents)}
                    </td>
                    <td data-label="Difference">
                      {formatDifference(
                        result.forecastImpact.proposedAvailableToDeployCents -
                          result.forecastImpact.currentAvailableToDeployCents,
                      )}
                    </td>
                  </tr>
                  {result.forecastImpact.accounts.map((account) => (
                    <tr key={account.accountId}>
                      <td data-label="Measure">{account.accountName} low</td>
                      <td data-label="Current">
                        {formatMoney(account.currentLowCents)}
                        <br />
                        <Text size={200}>{account.currentLowDate}</Text>
                      </td>
                      <td data-label="Offer">
                        {formatMoney(account.proposedLowCents)}
                        <br />
                        <Text size={200}>{account.proposedLowDate}</Text>
                      </td>
                      <td data-label="Difference">
                        {formatDifference(account.proposedLowCents - account.currentLowCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Text className={styles.muted}>
              The current keep-loan cost uses each modeled balance and exact dated schedule on{' '}
              {result.plan.payoffDate}; the refinance settlement uses the lender payoff quotes you
              entered. Biweekly payments are normalized only for the monthly-burden row, while the
              cost and cash forecast keep their exact two-week dates.
            </Text>
          </Card>

          <Card className={styles.panel}>
            <div className={styles.recordHeader}>
              <div className={styles.compact}>
                <Title2 as="h2">Use this refinance going forward</Title2>
                <Text>
                  Committing is effective-dated: existing payments remain before{' '}
                  {result.plan.payoffDate}, all selected loans retire on that date, closing cash
                  posts to the chosen accounts, and {result.plan.replacementLoan.name} begins
                  payments on {result.plan.firstPaymentDate}.
                </Text>
              </div>
              <Button
                appearance="primary"
                disabled={busy || result.newResidualBalanceCents > 0}
                onClick={() => void commitPlan()}
              >
                {busy ? 'Saving…' : 'Use this refinance'}
              </Button>
            </div>
            <Text className={styles.muted}>
              Forecast tested from {result.forecastImpact.horizonStart} through{' '}
              {result.forecastImpact.horizonEnd}
              {result.forecastImpact.horizonExtended
                ? ` (extended past ${result.forecastImpact.originalHorizonEnd} through the later of payoff and first payment)`
                : ''}
              .
            </Text>
          </Card>
        </section>
      )}

      <Card className={styles.panel}>
        <div className={styles.recordHeader}>
          <div className={styles.compact}>
            <Title2 as="h2">Committed refinance history</Title2>
            <Text>
              Each step remains visible, including a replacement loan that is refinanced again
              later.
            </Text>
          </div>
          <Button onClick={() => navigate('/loans')}>Review all loans</Button>
        </div>
        {records.committedRefinancePlans.length === 0 ? (
          <Text className={styles.muted}>No refinance has been committed yet.</Text>
        ) : (
          <div className={styles.stack}>
            {records.committedRefinancePlans
              .slice()
              .sort((left, right) => right.closingDate.localeCompare(left.closingDate))
              .map((plan) => {
                const lifecycle = refinancePlanLifecycle({
                  plan,
                  plans: records.committedRefinancePlans,
                  loanPaymentEvents: records.events,
                  asOfDate: today,
                });
                const sourceNames = plan.payoffs.map(
                  (payoff) =>
                    records.loans.find((loan) => loan.id === payoff.sourceLoanId)?.name ??
                    'Prior loan',
                );
                const bankOutflow =
                  plan.principalCashContributionCents +
                  plan.closingCostsCents -
                  plan.financedFeesCents;
                const cashSource = records.accounts.find(
                  (account) => account.id === plan.cashSourceAccountId,
                )?.name;
                const proceedsAccount = records.accounts.find(
                  (account) => account.id === plan.excessProceedsAccountId,
                )?.name;
                const committedLoan = plan.replacementLoanSnapshot ?? plan.replacementLoan;
                const currentTermsChanged =
                  committedLoan.principalCents !== plan.replacementLoan.principalCents ||
                  committedLoan.paymentCents !== plan.replacementLoan.paymentCents ||
                  (committedLoan.cashPaymentCents ?? committedLoan.paymentCents) !==
                    (plan.replacementLoan.cashPaymentCents ?? plan.replacementLoan.paymentCents) ||
                  committedLoan.originalTermMonths !== plan.replacementLoan.originalTermMonths ||
                  committedLoan.annualRateBasisPoints !==
                    plan.replacementLoan.annualRateBasisPoints;
                const canCancel =
                  plan.status === 'committed' && compareDates(today, plan.closingDate) < 0;
                const canRefinanceAgain = candidates.some(
                  (candidate) => candidate.loan.id === plan.replacementLoan.id,
                );
                return (
                  <div className={styles.formSection} key={plan.id}>
                    <div className={styles.recordHeader}>
                      <div className={styles.compact}>
                        <strong>{plan.name}</strong>
                        <Text
                          className={lifecycle === 'cancelled' ? styles.muted : styles.positive}
                        >
                          {lifecycleLabel(lifecycle)}
                        </Text>
                      </div>
                      <div className={styles.actions}>
                        {canRefinanceAgain && (
                          <Button
                            onClick={() => {
                              const candidate = candidates.find(
                                (item) => item.loan.id === plan.replacementLoan.id,
                              );
                              const earliestBase =
                                candidate &&
                                compareDates(candidate.availableOn, forecastStartDate) > 0
                                  ? candidate.availableOn
                                  : forecastStartDate;
                              const nextClosing = addDays(earliestBase, 1);
                              setSelectedLoanIds([plan.replacementLoan.id]);
                              setClosingDate(nextClosing);
                              setPayoffDate(nextClosing);
                              setSeparatePayoffDate(false);
                              setFirstPaymentDate(addMonthsConstrained(nextClosing, 1));
                              setResult(null);
                              setMessage(`Planning the next refinance after ${plan.name}.`);
                              globalThis.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          >
                            Refinance this replacement
                          </Button>
                        )}
                        {canCancel && (
                          <Button disabled={busy} onClick={() => void cancelPlan(plan)}>
                            Cancel upcoming plan
                          </Button>
                        )}
                      </div>
                    </div>
                    <Text>
                      {sourceNames.join(' + ')} → {plan.replacementLoan.name}
                    </Text>
                    <div className={styles.grid}>
                      <Text>Closes: {plan.closingDate}</Text>
                      <Text>Old loans paid: {plan.payoffDate}</Text>
                      <Text>First new payment: {plan.firstPaymentDate}</Text>
                      <Text>Committed principal: {formatMoney(committedLoan.principalCents)}</Text>
                      <Text>Committed debt payment: {formatMoney(committedLoan.paymentCents)}</Text>
                      <Text>
                        Committed cash draft:{' '}
                        {formatMoney(committedLoan.cashPaymentCents ?? committedLoan.paymentCents)}
                      </Text>
                      <Text>
                        Original term:{' '}
                        {committedLoan.originalTermMonths === undefined
                          ? 'Not recorded'
                          : `${committedLoan.originalTermMonths} months`}
                      </Text>
                      <Text>
                        Committed APR: {(committedLoan.annualRateBasisPoints / 100).toFixed(2)}%
                      </Text>
                      {currentTermsChanged && (
                        <Text>
                          Current loan record: {formatMoney(plan.replacementLoan.principalCents)}{' '}
                          balance · {formatMoney(plan.replacementLoan.paymentCents)} debt payment ·{' '}
                          {formatMoney(
                            plan.replacementLoan.cashPaymentCents ??
                              plan.replacementLoan.paymentCents,
                          )}{' '}
                          cash draft
                        </Text>
                      )}
                      <Text>
                        Bank cash paid: {formatMoney(bankOutflow)}
                        {cashSource ? ` from ${cashSource}` : ''}
                      </Text>
                      <Text>
                        Cash-out received: {formatMoney(plan.excessProceedsCents)}
                        {proceedsAccount ? ` in ${proceedsAccount}` : ''}
                      </Text>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </Card>
    </>
  );
};
