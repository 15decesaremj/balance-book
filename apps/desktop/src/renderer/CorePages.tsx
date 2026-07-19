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
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import { useNavigate, useSearchParams } from 'react-router';
import {
  buildForecastBundle,
  accrueSimpleInterest,
  activeLoansForDate,
  analyzeLoanContinuationFromPayoff,
  calculateNetWorth,
  contractualMonthlyPaymentDay,
  effectiveAssetsForDate,
  enrichCardCyclesWithActivities,
  expandRecurrence,
  firstAnchoredReceivableSettlementDate,
  hasRecurringReceivableSchedule,
  materializeForecastEvents,
  materializeCommittedRefinanceEvents,
  pendingRefinanceSettlementCentsForDate,
  pendingRefinanceEconomicSettlementCentsForDate,
  projectLoanBalanceAtEndOfDate,
  projectLoanPayoffAtDate,
  projectReceivableBalances,
  projectRollingReceivableBalances,
  prepareRollingForecastContext,
  projectedCycleObligation,
  reconcileScheduledLoanDraftCash,
  mergeReceivableSettlementUserNotes,
  receivableSettlementDates,
  receivableSettlementUserNotes,
  resolveReceivableScheduleOccurrenceDate,
  resolveCardCyclesAsOf,
  roundInterestToCents,
  solveInstallmentLoanSetup,
  summarizeRevolvingDebt,
} from '@balance-book/financial-engine';
import {
  addDays,
  addMonthsConstrained,
  compareDates,
  isRecurrenceOccurrence,
  type CardActivityTreatment,
  type CashAccount,
  type CreditCard,
  type CreditCardCycle,
  type ForecastEvent,
  type Loan,
  type LoanInferredField,
  type LoanPaymentTreatment,
  type PlainDateString,
  type RecurrenceRule,
} from '@balance-book/domain';
import type {
  ForecastSnapshotDto,
  ImportReviewDto,
  ManagedRecordsDto,
  UpsertManagedEntityRequest,
} from '../shared/contracts';
import {
  calculateRaiseAdjustmentCents,
  effectiveIncomePhase,
  effectiveIncomeStreamTotalCents,
  incomeStreamMemberEvents,
  incomePhaseForDate,
  linkedRaisePlansForStream,
  nextIncomePhaseStart,
  relatedOneTimeIncomeForStream,
  sortIncomePlanEvents,
  summarizeBaseIncomeStreams,
  summarizeIncomePlans,
  type IncomePlanSummary,
  type IncomeStreamSummary,
} from './income-view-model';
import {
  defaultDirectionForEventKind,
  expectedAccountBalanceOn,
  fixedDirectionForEventKind,
  reconciliationResolutionLabel,
} from './record-controls';
import { refinanceLoanCandidates } from './refinance-view-model';
import { dollarsToCents, formatMoney, formatPlainDate } from './utils';
import { LoadingSkeleton } from './LoadingSkeleton';
import { useEditorReveal } from './useEditorReveal';

const useCoreStyles = makeStyles({
  header: {
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    marginBottom: '28px',
    maxWidth: '900px',
    minWidth: 0,
    '& h1': { letterSpacing: '-0.035em', overflowWrap: 'anywhere' },
    '& > *': { minWidth: 0 },
  },
  panel: {
    minWidth: 0,
    padding: 'clamp(20px, 2.3vw, 28px)',
    marginBottom: '24px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  form: {
    display: 'grid',
    minWidth: 0,
    gap: tokens.spacingVerticalL,
    '& > *': { minWidth: 0 },
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalL,
    '& > *': { minWidth: 0 },
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
    minWidth: 0,
    '& > *': { minWidth: 0, maxWidth: '100%' },
    '& button': { whiteSpace: 'normal' },
  },
  dataActionArea: {
    minWidth: 0,
    margin: 0,
    padding: 0,
    border: 0,
  },
  dataActionStatus: {
    marginBottom: tokens.spacingVerticalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
  },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    gap: '18px',
    marginBottom: '24px',
  },
  metric: {
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  value: {
    fontSize: 'clamp(1.65rem, 3vw, 2.5rem)',
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  rows: { display: 'grid', gap: tokens.spacingVerticalS },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    minWidth: 0,
    '& > *': { minWidth: 0, overflowWrap: 'anywhere' },
    '@media (max-width: 640px)': {
      alignItems: 'stretch',
      flexDirection: 'column',
    },
  },
  recordGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
    gap: '18px',
  },
  recordCard: {
    padding: '20px',
    display: 'grid',
    gap: tokens.spacingVerticalM,
    alignContent: 'start',
    minWidth: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  recordFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  recordFact: {
    display: 'grid',
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    '& > *': { overflowWrap: 'anywhere' },
  },
  recordHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    '& > *': { minWidth: 0 },
    '& h2, & strong': { overflowWrap: 'anywhere' },
  },
  stack: { display: 'grid', minWidth: 0, gap: tokens.spacingVerticalM },
  compact: {
    display: 'grid',
    minWidth: 0,
    gap: tokens.spacingVerticalXS,
    '& > *': { minWidth: 0, overflowWrap: 'anywhere' },
  },
  sectionIntro: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    marginBottom: '18px',
  },
  eyebrow: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  amount: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  progressTrack: {
    width: '100%',
    height: '9px',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground4,
    boxShadow: `inset 0 1px 2px ${tokens.colorNeutralShadowAmbient}`,
  },
  progressFill: {
    display: 'block',
    height: '100%',
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: `linear-gradient(90deg, ${tokens.colorBrandBackground}, ${tokens.colorBrandForeground1})`,
    transitionProperty: 'width',
    transitionDuration: tokens.durationNormal,
  },
  progressFillPositive: {
    backgroundImage: `linear-gradient(90deg, ${tokens.colorPaletteGreenBackground3}, ${tokens.colorPaletteGreenForeground1})`,
  },
  summaryStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalXL,
  },
  summaryTile: {
    minWidth: 0,
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  payoffHero: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalXL,
    alignItems: 'center',
    '@media (max-width: 640px)': { gridTemplateColumns: '1fr' },
  },
  inactiveLoanDisclosure: {
    overflow: 'hidden',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    '&[open] > summary': {
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    '& > .fui-Card': {
      margin: tokens.spacingHorizontalM,
      boxShadow: 'none !important',
    },
  },
  inactiveLoanSummary: {
    minHeight: '72px',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalL,
    alignItems: 'center',
    '&::marker': { color: tokens.colorBrandForeground1 },
    '@media (max-width: 540px)': { gridTemplateColumns: '1fr' },
  },
  inactiveLoanSummaryMeta: {
    display: 'grid',
    gap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground2,
  },
  inlineEditor: {
    marginTop: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorBrandBackground2,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  divider: {
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalM,
  },
  formSection: {
    padding: tokens.spacingHorizontalXL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'grid',
    gap: tokens.spacingVerticalL,
  },
  receiptSection: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    boxShadow: `inset 3px 0 0 ${tokens.colorBrandStroke1}`,
  },
  allocationRows: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
  },
  allocationRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 1.2fr) minmax(150px, 0.9fr) minmax(130px, 0.8fr) auto',
    gap: tokens.spacingHorizontalM,
    alignItems: 'end',
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    '@media (max-width: 760px)': {
      gridTemplateColumns: '1fr',
      alignItems: 'stretch',
    },
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  previewCard: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground2 },
  positive: { color: tokens.colorPaletteGreenForeground1 },
  decisionPanel: {
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  residualWarning: {
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteDarkOrangeBorder1}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
    color: tokens.colorPaletteDarkOrangeForeground2,
  },
  comparisonScroll: {
    overflowX: 'auto',
    marginTop: tokens.spacingVerticalL,
  },
  comparisonTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontVariantNumeric: 'tabular-nums',
    '& th': {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke1}`,
      color: tokens.colorNeutralForeground3,
      fontSize: tokens.fontSizeBase200,
      fontWeight: tokens.fontWeightSemibold,
      textAlign: 'left',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    },
    '& td': {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      verticalAlign: 'top',
    },
    '& th:not(:first-child), & td:not(:first-child)': { textAlign: 'right' },
    '& td:first-child': { fontWeight: tokens.fontWeightSemibold },
    '& tbody tr:last-child td': { borderBottomStyle: 'none' },
    '@media (max-width: 640px)': {
      '& thead': {
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        border: '0',
      },
      '&, & tbody': { display: 'block' },
      '& tbody': { display: 'grid', gap: tokens.spacingVerticalM },
      '& tr': {
        display: 'block',
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        overflow: 'hidden',
      },
      '& td': {
        display: 'grid',
        gridTemplateColumns: 'minmax(108px, 0.8fr) minmax(0, 1.2fr)',
        gap: tokens.spacingHorizontalM,
        alignItems: 'start',
        textAlign: 'right',
      },
      '& td::before': {
        content: 'attr(data-label)',
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        textAlign: 'left',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
      '& td:first-child': {
        gridTemplateColumns: '1fr',
        backgroundColor: tokens.colorNeutralBackground2,
        textAlign: 'left',
      },
      '& td:first-child::before': { display: 'none' },
      '& tbody tr:last-child td': {
        borderBottomStyle: 'solid',
      },
      '& tbody tr td:last-child': { borderBottomStyle: 'none' },
    },
  },
  disclosure: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    '& > summary': {
      cursor: 'pointer',
      padding: tokens.spacingHorizontalL,
      fontWeight: tokens.fontWeightSemibold,
    },
    '&[open] > summary': {
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    '& > div': {
      padding: tokens.spacingHorizontalL,
    },
  },
  recordCreator: {
    marginBottom: tokens.spacingVerticalXL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    '& > summary': {
      cursor: 'pointer',
      padding: tokens.spacingHorizontalXL,
      fontWeight: tokens.fontWeightSemibold,
      fontSize: tokens.fontSizeBase400,
    },
    '&[open] > summary': {
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    '& > div': { padding: tokens.spacingHorizontalXL },
  },
});

const get = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();
const cents = (form: FormData, name: string): number => dollarsToCents(get(form, name));
const optionalCents = (form: FormData, name: string): number | undefined => {
  const value = get(form, name);
  return value ? dollarsToCents(value) : undefined;
};
const optionalBasisPoints = (form: FormData, name: string): number | undefined => {
  const value = get(form, name);
  return value ? new Decimal(value).mul(100).toDecimalPlaces(0).toNumber() : undefined;
};
const optionalInteger = (form: FormData, name: string): number | undefined => {
  const value = get(form, name);
  return value ? new Decimal(value).toDecimalPlaces(0).toNumber() : undefined;
};
const number = (form: FormData, name: string): number =>
  new Decimal(get(form, name) || 0).toNumber();
const centsInput = (value: number | undefined): string =>
  value === undefined ? '' : new Decimal(value).div(100).toFixed(2);
const loanSetupFieldLabels: Record<string, string> = {
  principalCents: 'current principal',
  accruedInterestCents: 'accrued interest',
  balanceDate: 'balance date',
  annualRateBasisPoints: 'APR',
  accrualConvention: 'accrual method',
  paymentCents: 'debt payment',
  cashPaymentCents: 'total cash payment',
  nextPaymentDate: 'next payment date',
  maturityDate: 'payoff or maturity date',
  originalPrincipalCents: 'original amount',
  originalDate: 'origination date',
  originalTermMonths: 'original term',
  amortizationStructure: 'payoff structure',
  expectedBalloonCents: 'expected balloon',
  paymentFrequency: 'payment frequency',
};
const loanSetupFieldLabel = (field: string): string => loanSetupFieldLabels[field] ?? field;

export const resolveLoanEditField = <T,>(input: {
  field: LoanInferredField;
  submitted: T | undefined;
  stored: T | undefined;
  inferredFields: ReadonlySet<LoanInferredField>;
  recalculate: boolean;
}): { value: T | undefined; preservedCalculatedValue: boolean } => {
  if (input.submitted !== undefined) {
    return { value: input.submitted, preservedCalculatedValue: false };
  }
  if (!input.recalculate && input.inferredFields.has(input.field)) {
    return { value: input.stored, preservedCalculatedValue: input.stored !== undefined };
  }
  return { value: undefined, preservedCalculatedValue: false };
};

export const monthlyEquivalentRunRateCents = (
  entries: ReadonlyArray<{ amountCents: number; recurrenceRule: RecurrenceRule }>,
): number => {
  const totalCents = entries.reduce((total, entry) => {
    const rule = entry.recurrenceRule;
    const occurrencesPerMonth = (() => {
      switch (rule.frequency) {
        case 'once':
          return new Decimal(0);
        case 'weekly':
          return new Decimal(52).div(new Decimal(12).mul(rule.interval));
        case 'biweekly':
          return new Decimal(26).div(12);
        case 'semimonthly':
          return new Decimal(2);
        case 'monthly':
          return new Decimal(1).div(rule.interval);
      }
    })();
    return total.add(new Decimal(entry.amountCents).mul(occurrencesPerMonth));
  }, new Decimal(0));
  const rounded = totalCents.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(rounded)) throw new Error('Monthly-equivalent run rate is too large');
  return rounded;
};

export const isRecurringRunRateActive = (
  recurrenceEndDate: PlainDateString | undefined,
  asOfDate: PlainDateString,
): boolean => !recurrenceEndDate || compareDates(recurrenceEndDate, asOfDate) >= 0;

export const defaultReceivableReceiptDate = (asOfDate: PlainDateString): PlainDateString =>
  Temporal.PlainDate.from(asOfDate).with({ day: 1 }).add({ months: 1 }).toString();

export const scheduledReceivableEffectText = (input: {
  date: PlainDateString;
  accountName: string;
  cashAmountCents: number;
  owedReductionCents: number;
}): string => {
  const cashText = formatMoney(input.cashAmountCents);
  const owedText = formatMoney(input.owedReductionCents);
  const prefix = `Scheduled effect on ${input.date}: +${cashText} to ${input.accountName}`;
  if (input.cashAmountCents === input.owedReductionCents) {
    return `${prefix} and -${owedText} from projected Money Owed.`;
  }
  if (input.owedReductionCents === 0) {
    return `${prefix}. Projected Money Owed does not fall because this receipt has no matching accrued balance.`;
  }
  const notYetOwedCents = Math.max(0, input.cashAmountCents - input.owedReductionCents);
  return `${prefix} and -${owedText} from projected Money Owed. The other ${formatMoney(
    notYetOwedCents,
  )} is scheduled cash that was not already owed.`;
};

export const receivableExpectedTimingText = (input: {
  expectedDate: PlainDateString;
  nextScheduledReceipt?: PlainDateString;
  settlementDateConfirmed?: boolean;
}): string =>
  input.settlementDateConfirmed === false
    ? `${input.nextScheduledReceipt ?? input.expectedDate} (unconfirmed)`
    : (input.nextScheduledReceipt ?? 'No future occurrence');

export const anchoredReceivableDateForEdit = (input: {
  existing?: ManagedRecordsDto['receivables'][number];
  anchorEvent: ForecastEvent;
  settlementOffsetDays: number;
  onOrAfter: PlainDateString;
}): PlainDateString => {
  if (
    input.existing?.settlementAnchorEventId === input.anchorEvent.id &&
    input.existing.settlementOffsetDays !== undefined
  ) {
    const originalAnchorOccurrence = addDays(
      input.existing.expectedDate,
      -input.existing.settlementOffsetDays,
    );
    return addDays(originalAnchorOccurrence, input.settlementOffsetDays);
  }
  return firstAnchoredReceivableSettlementDate({
    anchorEvent: input.anchorEvent,
    settlementOffsetDays: input.settlementOffsetDays,
    onOrAfter: input.onOrAfter,
  });
};

export const defaultReceivableSettlementOccurrence = (input: {
  receivable: ManagedRecordsDto['receivables'][number] | undefined;
  events: ForecastEvent[];
  settlementDate: PlainDateString;
  fallbackOccurrences: PlainDateString[];
}): PlainDateString | undefined => {
  if (!input.receivable || !hasRecurringReceivableSchedule(input.receivable)) return undefined;
  try {
    return resolveReceivableScheduleOccurrenceDate({
      receivable: input.receivable,
      events: input.events,
      settlementDate: input.settlementDate,
    });
  } catch {
    return (
      input.fallbackOccurrences.find((date) => compareDates(date, input.settlementDate) >= 0) ??
      input.fallbackOccurrences.at(-1)
    );
  }
};

export const receivableRecurrenceRuleForEdit = (input: {
  frequency: RecurrenceRule['frequency'];
  expectedDate: PlainDateString;
  existing?: RecurrenceRule;
}): RecurrenceRule | undefined => {
  if (input.frequency === 'once') return undefined;
  if (input.frequency === 'monthly') {
    return {
      frequency: 'monthly',
      dayOfMonth: Temporal.PlainDate.from(input.expectedDate).day,
      interval: input.existing?.frequency === 'monthly' ? input.existing.interval : 1,
    };
  }
  if (input.existing?.frequency === input.frequency) return input.existing;
  if (input.frequency === 'biweekly') return { frequency: 'biweekly' };
  if (input.frequency === 'semimonthly') {
    throw new Error('Twice-monthly receipt timing can only be preserved from an existing schedule');
  }
  return { frequency: 'weekly', interval: 1 };
};

export const receivableAccrualRecurrenceRuleForEdit = (input: {
  frequency: RecurrenceRule['frequency'] | 'none';
  accrualDate: PlainDateString;
  existing?: RecurrenceRule;
}): RecurrenceRule | undefined => {
  if (input.frequency === 'none') return undefined;
  if (input.frequency === 'once') return { frequency: 'once' };
  return receivableRecurrenceRuleForEdit({
    frequency: input.frequency,
    expectedDate: input.accrualDate,
    existing: input.existing,
  });
};

export const billRelativeReceiptTimingLabel = (
  settlementOffsetDays: number,
  billLabel: string,
): string => {
  if (settlementOffsetDays === 0) return `when ${billLabel} is due`;
  const dayCount = Math.abs(settlementOffsetDays);
  return `${dayCount} day${dayCount === 1 ? '' : 's'} ${
    settlementOffsetDays < 0 ? 'before' : 'after'
  } ${billLabel}`;
};

export const loanPageMetrics = (
  loan: Loan,
  asOf: PlainDateString,
  loanPaymentEvents: readonly ForecastEvent[] = [],
) => {
  const modeled = projectLoanBalanceAtEndOfDate(loan, asOf, {
    loanPaymentEvents,
    actualThroughDate: asOf,
  });
  const normalizedLoan: Loan = {
    ...loan,
    principalCents: modeled.principalCents,
    accruedInterestCents: modeled.accruedInterestCents,
    balanceDate: asOf,
  };
  return {
    modeled,
    dailyInterestCents: roundInterestToCents(
      accrueSimpleInterest({
        principalCents: modeled.principalCents,
        annualRateBasisPoints: loan.annualRateBasisPoints,
        fromDate: asOf,
        toDate: addDays(asOf, 1),
        convention: loan.accrualConvention,
      }),
    ),
    payoff: analyzeLoanContinuationFromPayoff({
      loan: normalizedLoan,
      payoffDate: asOf,
      payoffAmountCents: modeled.totalCents,
      loanPaymentEvents,
      actualThroughDate: asOf,
    }),
  };
};

export interface LoanAmortizationLedgerRow {
  id: string;
  date: PlainDateString;
  type: 'scheduled-payment' | 'additional-principal';
  label: string;
  cashDraftCents: number;
  interestPaidCents: number;
  principalPaidCents: number;
  remainingDebtCents: number;
}

/**
 * Builds the inspectable future debt allocation ledger from the same exact-dated projection used
 * by current balances, refinance payoffs, and cash scheduling. Rows begin on the financial as-of
 * date; past planned extra-principal entries are not silently treated as completed payments.
 */
export const loanAmortizationLedger = (
  loan: Loan,
  asOf: PlainDateString,
  loanPaymentEvents: readonly ForecastEvent[] = [],
): LoanAmortizationLedgerRow[] => {
  const startDate = compareDates(asOf, loan.balanceDate) < 0 ? loan.balanceDate : asOf;
  if (
    (loan.status ?? 'active') !== 'active' ||
    loan.principalCents + loan.accruedInterestCents === 0
  )
    return [];

  const metrics = loanPageMetrics(loan, startDate, loanPaymentEvents);
  const openEndedHorizon =
    loan.paymentFrequency === 'biweekly'
      ? addDays(startDate, 14 * 78)
      : addMonthsConstrained(startDate, 36);
  const finalDate = loan.maturityDate ?? metrics.payoff.paidOffDate ?? openEndedHorizon;
  const projection = projectLoanPayoffAtDate(loan, addDays(finalDate, 1), {
    loanPaymentEvents,
    actualThroughDate: asOf,
  });
  const nonDebtCashCents = Math.max(
    0,
    (loan.cashPaymentCents ?? loan.paymentCents) - loan.paymentCents,
  );
  const eventLabelById = new Map(
    loanPaymentEvents.map((event) => [event.id, event.label] as const),
  );
  return [
    ...projection.scheduledPayments
      .filter((payment) => compareDates(payment.date, startDate) >= 0)
      .map((payment): LoanAmortizationLedgerRow => {
        const generatedCashDraftCents = payment.appliedPaymentCents + nonDebtCashCents;
        return {
          id: `${loan.id}:scheduled:${payment.date}`,
          date: payment.date,
          type: 'scheduled-payment',
          label:
            loan.maturityDate === payment.date && payment.appliedPaymentCents > loan.paymentCents
              ? loan.amortizationStructure === 'balloon'
                ? 'Contractual maturity payment'
                : 'Final payoff adjustment'
              : 'Regular payment',
          cashDraftCents: reconcileScheduledLoanDraftCash({
            loan,
            date: payment.date,
            generatedCashDraftCents,
            loanPaymentEvents,
          }).totalCashDraftCents,
          interestPaidCents: payment.interestPaidCents,
          principalPaidCents: payment.principalPaidCents,
          remainingDebtCents:
            payment.remainingPrincipalCents + payment.remainingAccruedInterestCents,
        };
      }),
    ...projection.additionalPrincipalPayments
      .filter((payment) => compareDates(payment.date, startDate) >= 0)
      .map((payment): LoanAmortizationLedgerRow => ({
        id: `${loan.id}:extra:${payment.sourceEventId}:${payment.date}`,
        date: payment.date,
        type: 'additional-principal',
        label: eventLabelById.get(payment.sourceEventId) ?? 'Extra principal',
        cashDraftCents: payment.appliedPrincipalCents,
        interestPaidCents: 0,
        principalPaidCents: payment.appliedPrincipalCents,
        remainingDebtCents: payment.remainingPrincipalCents + payment.remainingAccruedInterestCents,
      })),
  ].sort(
    (left, right) =>
      compareDates(left.date, right.date) ||
      (left.type === right.type
        ? left.id.localeCompare(right.id)
        : left.type === 'scheduled-payment'
          ? -1
          : 1),
  );
};

export const selectCardStatementSummaryCycles = (
  cycles: readonly CreditCardCycle[],
): { comingDue?: CreditCardCycle; latestStatement?: CreditCardCycle } => {
  const comingDue = cycles
    .filter((cycle) => ['closed-statement', 'scheduled-payment'].includes(cycle.state))
    .sort(
      (left, right) =>
        left.dueOn.localeCompare(right.dueOn) || left.closesOn.localeCompare(right.closesOn),
    )[0];
  const latestStatement = cycles
    .filter(
      (cycle) =>
        cycle.lockedStatementCents !== undefined &&
        ['closed-statement', 'scheduled-payment', 'paid'].includes(cycle.state),
    )
    .sort(
      (left, right) =>
        right.closesOn.localeCompare(left.closesOn) || right.dueOn.localeCompare(left.dueOn),
    )[0];
  return { comingDue, latestStatement };
};

export const aggregateKnownLimitCardUtilization = (
  cards: readonly {
    currentBalanceCents: number;
    creditLimitCents?: number;
  }[],
): {
  currentBalanceCents: number;
  creditLimitCents: number;
  knownLimitCardCount: number;
  totalCardCount: number;
  utilizationPercent?: number;
} => {
  const cardsWithKnownLimits = cards.filter(
    (card): card is { currentBalanceCents: number; creditLimitCents: number } =>
      card.creditLimitCents !== undefined && card.creditLimitCents > 0,
  );
  const currentBalanceCents = cardsWithKnownLimits.reduce(
    (total, card) => total + card.currentBalanceCents,
    0,
  );
  const creditLimitCents = cardsWithKnownLimits.reduce(
    (total, card) => total + card.creditLimitCents,
    0,
  );
  return {
    currentBalanceCents,
    creditLimitCents,
    knownLimitCardCount: cardsWithKnownLimits.length,
    totalCardCount: cards.length,
    ...(creditLimitCents > 0
      ? { utilizationPercent: (currentBalanceCents / creditLimitCents) * 100 }
      : {}),
  };
};

export const cardUtilizationPresentation = (
  currentBalanceCents: number,
  creditLimitCents: number,
): { utilizationPercent: number; barPercent: number } | undefined => {
  if (creditLimitCents <= 0) return undefined;
  const utilizationPercent = Math.max(0, (currentBalanceCents / creditLimitCents) * 100);
  return {
    utilizationPercent,
    barPercent: Math.max(0, Math.min(100, utilizationPercent)),
  };
};

export const latestClosedStatementForReconciliation = (input: {
  cardId: string;
  asOfDate: PlainDateString;
  cycles: readonly CreditCardCycle[];
  modeled?: {
    latestStatementCents: number;
    latestStatementDate?: PlainDateString;
  };
}): { amountCents: number; date: PlainDateString } | undefined => {
  if (input.modeled?.latestStatementDate !== undefined) {
    return {
      amountCents: input.modeled.latestStatementCents,
      date: input.modeled.latestStatementDate,
    };
  }
  const latestStoredStatement = input.cycles
    .filter(
      (cycle) =>
        cycle.cardId === input.cardId &&
        cycle.lockedStatementCents !== undefined &&
        ['closed-statement', 'scheduled-payment', 'paid'].includes(cycle.state) &&
        compareDates(cycle.closesOn, input.asOfDate) <= 0,
    )
    .sort((left, right) => compareDates(right.closesOn, left.closesOn))[0];
  return latestStoredStatement?.lockedStatementCents === undefined
    ? undefined
    : {
        amountCents: latestStoredStatement.lockedStatementCents,
        date: latestStoredStatement.closesOn,
      };
};

export const nextActiveLoanPaymentDate = (
  loan: Loan,
  asOf: PlainDateString,
): PlainDateString | null => {
  const candidates: PlainDateString[] = [];
  if (loan.paymentCents > 0) {
    if (compareDates(loan.nextPaymentDate, asOf) > 0) {
      candidates.push(loan.nextPaymentDate);
    } else {
      const rule =
        loan.paymentFrequency === 'biweekly'
          ? ({ frequency: 'biweekly' } as const)
          : ({
              frequency: 'monthly',
              dayOfMonth: contractualMonthlyPaymentDay(loan),
              interval: 1,
            } as const);
      const next = expandRecurrence({
        startDate: loan.nextPaymentDate,
        endDate: addDays(asOf, 62),
        rule,
      }).find((date) => compareDates(date, asOf) > 0);
      if (next) candidates.push(next);
    }
  }
  if (loan.maturityDate && compareDates(loan.maturityDate, asOf) > 0) {
    candidates.push(loan.maturityDate);
  }
  return candidates.sort(compareDates)[0] ?? null;
};

export const effectiveLoanPageMetrics = (
  storedLoan: Loan,
  effectiveLoan: Loan | undefined,
  asOf: PlainDateString,
  loanPaymentEvents: readonly ForecastEvent[] = [],
) => {
  if (!effectiveLoan) {
    return {
      active: false,
      modeled: { principalCents: 0, accruedInterestCents: 0, totalCents: 0 },
      dailyInterestCents: 0,
      payoff: null,
      nextPaymentDate: null,
      recordedPaymentCents: storedLoan.paymentCents,
    };
  }
  const metrics = loanPageMetrics(effectiveLoan, asOf, loanPaymentEvents);
  return {
    active: true,
    ...metrics,
    nextPaymentDate: nextActiveLoanPaymentDate(effectiveLoan, asOf),
    recordedPaymentCents: storedLoan.paymentCents,
  };
};

export const netWorthCashBalance = (
  account: Pick<CashAccount, 'id' | 'openingBalanceCents'>,
  snapshotAccounts: ForecastSnapshotDto['cashAccounts'],
): { balanceCents: number; modeled: boolean } => {
  const modeledBalance = snapshotAccounts?.find((item) => item.id === account.id)?.balanceCents;
  return modeledBalance === undefined
    ? { balanceCents: account.openingBalanceCents, modeled: false }
    : { balanceCents: modeledBalance, modeled: true };
};

const formatLineageValue = (field: string, valueJson: string | null): string => {
  if (valueJson === null) return 'Not recorded';
  try {
    const value: unknown = JSON.parse(valueJson);
    if (value === null || value === undefined || value === '') return 'Not set';
    if (typeof value === 'number' && field.endsWith('Cents')) return formatMoney(value);
    if (typeof value === 'number' && field.endsWith('BasisPoints')) {
      return `${new Decimal(value).div(100).toFixed(2)}%`;
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return JSON.stringify(value);
  } catch {
    return valueJson;
  }
};

const cycleDisplayAmount = (cycle: ManagedRecordsDto['cardCycles'][number]): number =>
  cycle.projectionOverrideCents ??
  cycle.lockedStatementCents ??
  cycle.actualActivityCents + cycle.plannedActivityCents;

type EditorType =
  | 'cash-account'
  | 'forecast-event'
  | 'credit-card'
  | 'card-cycle'
  | 'loan'
  | 'receivable'
  | 'asset'
  | 'reward-program';
type RecordLibraryType = UpsertManagedEntityRequest['entityType'];
const editorTypes: EditorType[] = [
  'cash-account',
  'forecast-event',
  'credit-card',
  'card-cycle',
  'loan',
  'receivable',
  'asset',
  'reward-program',
];
const recordLibraryTypes: RecordLibraryType[] = [
  ...editorTypes,
  'reconciliation',
  'saved-scenario',
];
const forecastEventKinds: ForecastEvent['kind'][] = [
  'income',
  'direct-commitment',
  'payable',
  'card-payment',
  'loan-payment',
  'reward-deposit',
  'baseline-spending',
  'investment-contribution',
  'manual-adjustment',
  'scenario',
  'transfer-debit',
  'transfer-credit',
];
const isEditorType = (value: string | null): value is EditorType =>
  value !== null && editorTypes.includes(value as EditorType);
const isRecordLibraryType = (value: string | null): value is RecordLibraryType =>
  value !== null && recordLibraryTypes.includes(value as RecordLibraryType);
const isForecastEventKind = (value: string | null): value is ForecastEvent['kind'] =>
  value !== null && forecastEventKinds.includes(value as ForecastEvent['kind']);
const receivableSettlementGuidance =
  'Use Money Owed to schedule or record received money so the cash deposit stays linked to the correct owed balance and recurring installment.';
const makeEditRequest = (
  entityType: UpsertManagedEntityRequest['entityType'],
  record: object,
): UpsertManagedEntityRequest =>
  ({
    entityType,
    payload: Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'userId')),
  }) as UpsertManagedEntityRequest;

export const scheduledCardPaymentRequest = (input: {
  existing?: ForecastEvent;
  newId: string;
  accountId: string;
  date: PlainDateString;
  amountCents: number;
  label: string;
  sourceCycleId?: string;
  cardId: string;
}): UpsertManagedEntityRequest => {
  const existingPayload = input.existing
    ? (makeEditRequest('forecast-event', input.existing).payload as Record<string, unknown>)
    : {};
  return {
    entityType: 'forecast-event',
    payload: {
      ...existingPayload,
      id: input.existing?.id ?? input.newId,
      accountId: input.accountId,
      date: input.date,
      kind: 'card-payment',
      direction: 'outflow',
      amountCents: input.amountCents,
      certainty: 'confirmed',
      status: 'scheduled',
      label: input.label,
      sourceRecordId: input.sourceCycleId,
      hypothetical: false,
      accepted: false,
      paymentMethod: 'cash-account',
      cardId: input.cardId,
    },
  } as UpsertManagedEntityRequest;
};

const loadRecords = async (): Promise<ManagedRecordsDto> => {
  const result = await window.balanceBook.listRecords();
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const incomeCadenceLabel = (event: ForecastEvent): string => {
  switch (event.recurrenceRule?.frequency) {
    case 'weekly':
      return event.recurrenceRule.interval === 1
        ? 'Weekly'
        : `Every ${event.recurrenceRule.interval} weeks`;
    case 'biweekly':
      return 'Every two weeks';
    case 'monthly':
      return event.recurrenceRule.interval === 1
        ? `Monthly on day ${event.recurrenceRule.dayOfMonth}`
        : `Every ${event.recurrenceRule.interval} months on day ${event.recurrenceRule.dayOfMonth}`;
    case 'semimonthly':
      return `Twice monthly on days ${event.recurrenceRule.daysOfMonth.join(' and ')}`;
    case 'once':
    case undefined:
      return 'One time';
  }
};

const incomePhaseAllocationLabel = (
  phase: IncomePlanSummary,
  accounts: ManagedRecordsDto['accounts'],
): string =>
  sortIncomePlanEvents(phase.events)
    .map((event) => {
      const accountName =
        accounts.find((account) => account.id === event.accountId)?.name ?? 'Unknown account';
      const offset = event.incomeArrivalOffsetDays ?? 0;
      const timing =
        offset < 0
          ? `, ${Math.abs(offset)} day${Math.abs(offset) === 1 ? '' : 's'} early`
          : offset > 0
            ? `, ${offset} day${offset === 1 ? '' : 's'} after payday`
            : ', on payday';
      return `${formatMoney(event.amountCents)} to ${accountName}${timing}`;
    })
    .join('; ');

const incomeStreamTitle = (stream: IncomeStreamSummary, phase: IncomePlanSummary): string =>
  phase.first.label || stream.first.label || 'Income source';

const incomePhaseTimingLabel = (
  stream: IncomeStreamSummary,
  phase: IncomePlanSummary,
  asOfDate: string,
): string => {
  const startDate = phase.first.incomeNominalDate ?? phase.first.date;
  if (incomePhaseForDate(stream, asOfDate)) return `Current routing since ${startDate}`;
  if (compareDates(startDate, asOfDate) > 0) return `Next routing starts ${startDate}`;
  return phase.first.recurrenceEndDate
    ? `Most recent routing ended ${phase.first.recurrenceEndDate}`
    : `Most recent routing started ${startDate}`;
};

export const makeRequest = (type: EditorType, form: FormData): UpsertManagedEntityRequest => {
  const id = crypto.randomUUID();
  const accountId = get(form, 'accountId');
  const date = get(form, 'date');
  switch (type) {
    case 'cash-account':
      return {
        entityType: type,
        payload: {
          id,
          name: get(form, 'name'),
          type: get(form, 'accountType') as 'checking' | 'savings' | 'cash' | 'other',
          openingBalanceCents: cents(form, 'amount'),
          balanceAsOf: date,
          includedInLiquidity: true,
          canFundOtherAccounts: true,
          showOnOverview: true,
          hardFloorCents: cents(form, 'secondaryAmount'),
          transferDelayDays: number(form, 'delayDays'),
        },
      };
    case 'forecast-event': {
      const eventKind = get(form, 'eventKind') as ForecastEvent['kind'];
      if (eventKind === 'receivable-settlement') {
        throw new Error(receivableSettlementGuidance);
      }
      const recurrenceFrequency = get(form, 'recurrenceFrequency');
      const recurrenceRule =
        recurrenceFrequency === 'monthly'
          ? ({
              frequency: 'monthly' as const,
              dayOfMonth: Temporal.PlainDate.from(date).day,
              interval: 1,
            } as const)
          : recurrenceFrequency === 'biweekly'
            ? ({ frequency: 'biweekly' as const } as const)
            : recurrenceFrequency === 'weekly'
              ? ({ frequency: 'weekly' as const, interval: 1 } as const)
              : undefined;
      const paymentMethod = get(form, 'paymentMethod') as
        'cash-account' | 'credit-card' | 'payroll-deduction';
      const effectivePaymentMethod =
        eventKind === 'card-payment' || eventKind === 'loan-payment'
          ? 'cash-account'
          : paymentMethod;
      return {
        entityType: type,
        payload: {
          id,
          accountId,
          date,
          kind: eventKind,
          direction:
            fixedDirectionForEventKind(eventKind) ??
            (get(form, 'direction') as 'inflow' | 'outflow'),
          amountCents: cents(form, 'amount'),
          certainty: get(form, 'certainty') as 'confirmed' | 'expected' | 'uncertain',
          status: 'planned',
          label: get(form, 'name'),
          hypothetical: false,
          accepted: false,
          recurrenceRule,
          recurrenceEndDate: get(form, 'recurrenceEndDate') || undefined,
          paymentMethod: effectivePaymentMethod,
          cardId:
            effectivePaymentMethod === 'credit-card' || eventKind === 'card-payment'
              ? get(form, 'cardId')
              : undefined,
          cardActivityTreatment:
            effectivePaymentMethod === 'credit-card'
              ? (get(form, 'cardActivityTreatment') as CardActivityTreatment)
              : undefined,
          loanPaymentTreatment:
            eventKind === 'loan-payment'
              ? ((get(form, 'loanPaymentTreatment') ||
                  'scheduled-draft-override') as LoanPaymentTreatment)
              : undefined,
          sourceRecordId:
            eventKind === 'loan-payment'
              ? get(form, 'loanId')
              : eventKind === 'card-payment'
                ? get(form, 'cardCycleId') || undefined
                : undefined,
          incomeType: eventKind === 'income' ? 'other' : undefined,
        },
      } as UpsertManagedEntityRequest;
    }
    case 'credit-card':
      return {
        entityType: type,
        payload: {
          id,
          name: get(form, 'name'),
          fundingAccountId: accountId,
          accountKind: 'credit-card',
          status: 'active',
          defaultFutureStatementCents: cents(form, 'amount'),
          estimatePolicy: get(form, 'estimatePolicy') as 'actual-reset' | 'baseline-guardrail',
          paymentPolicy: get(form, 'paymentPolicy') as
            'full-statement' | 'minimum' | 'fixed' | 'manual',
          fixedPaymentCents: optionalCents(form, 'fixedPayment'),
          minimumPaymentCents: optionalCents(form, 'minimumPayment'),
          aprBasisPoints: get(form, 'apr')
            ? new Decimal(get(form, 'apr')).mul(100).toDecimalPlaces(0).toNumber()
            : undefined,
          promotionEndDate: get(form, 'promotionEndDate') || undefined,
          paymentDayOfMonth: optionalInteger(form, 'paymentDay'),
          statementCloseDayOfMonth: optionalInteger(form, 'statementCloseDay'),
        },
      };
    case 'card-cycle':
      return {
        entityType: type,
        payload: {
          id,
          cardId: get(form, 'cardId'),
          opensOn: date,
          closesOn: get(form, 'date2'),
          dueOn: get(form, 'date3'),
          paymentOn: get(form, 'date4') || undefined,
          state: get(form, 'cycleState') as
            'future-estimated' | 'open' | 'closed-statement' | 'scheduled-payment' | 'paid',
          defaultEstimateCents: cents(form, 'amount'),
          actualActivityCents: cents(form, 'secondaryAmount'),
          plannedActivityCents: 0,
          lockedStatementCents: get(form, 'lockedAmount') ? cents(form, 'lockedAmount') : undefined,
        },
      };
    case 'loan':
      return {
        entityType: type,
        payload: {
          id,
          name: get(form, 'name'),
          principalCents: cents(form, 'amount'),
          accruedInterestCents: cents(form, 'secondaryAmount'),
          balanceDate: date,
          annualRateBasisPoints: new Decimal(get(form, 'rate'))
            .mul(100)
            .toDecimalPlaces(0)
            .toNumber(),
          accrualConvention: get(form, 'accrualConvention') as
            'actual-365' | 'actual-360' | 'monthly',
          paymentCents: cents(form, 'paymentAmount'),
          nextPaymentDate: get(form, 'date2'),
          amortizationStructure: 'fully-amortizing',
          fundingAccountId: accountId,
          excludeFromEconomicNetWorthDoubleCount: form.get('economicExclusion') === 'on',
          paymentFrequency: get(form, 'paymentFrequency') as 'monthly' | 'biweekly',
          includeInCashForecast: form.get('includeInCashForecast') === 'on',
          status: 'active',
        },
      };
    case 'receivable': {
      const recurrenceFrequency = get(form, 'recurrenceFrequency');
      const recurrenceRule =
        recurrenceFrequency === 'monthly'
          ? ({
              frequency: 'monthly' as const,
              dayOfMonth: Temporal.PlainDate.from(date).day,
              interval: 1,
            } as const)
          : recurrenceFrequency === 'biweekly'
            ? ({ frequency: 'biweekly' as const } as const)
            : recurrenceFrequency === 'weekly'
              ? ({ frequency: 'weekly' as const, interval: 1 } as const)
              : undefined;
      return {
        entityType: type,
        payload: {
          id,
          source: get(form, 'name'),
          description: get(form, 'description'),
          originalAmountCents: cents(form, 'amount'),
          remainingAmountCents: cents(form, 'secondaryAmount'),
          expectedDate: date,
          destinationAccountId: accountId,
          certainty: get(form, 'certainty') as 'confirmed' | 'expected' | 'uncertain',
          recurringAmountCents: optionalCents(form, 'recurringAmount'),
          recurrenceRule,
          recurrenceEndDate: get(form, 'recurrenceEndDate') || undefined,
          includeInCashForecast: form.get('includeInCashForecast') === 'on',
        },
      };
    }
    case 'asset':
      return {
        entityType: type,
        payload: {
          id,
          name: get(form, 'name'),
          type: get(form, 'assetType') as 'investment' | 'tangible' | 'other',
          valueCents: cents(form, 'amount'),
          valuationDate: date,
          includedInNetWorth: true,
          includedInLiquidity: form.get('liquidAsset') === 'on',
        },
      };
    case 'reward-program':
      return {
        entityType: type,
        payload: {
          id,
          cardId: get(form, 'cardId'),
          rewardType: get(form, 'rewardType') as 'cash-back' | 'points',
          baseRateBasisPoints: new Decimal(get(form, 'rate'))
            .mul(100)
            .toDecimalPlaces(0)
            .toNumber(),
          annualFeeCents: cents(form, 'amount'),
          treatment: get(form, 'rewardTreatment') as
            'informational' | 'statement-credit' | 'cash-deposit',
          expectedReceiptDate: date || undefined,
        },
      };
  }
};

type CashAccountRequest = Extract<UpsertManagedEntityRequest, { entityType: 'cash-account' }>;
type ForecastEventRequest = Extract<UpsertManagedEntityRequest, { entityType: 'forecast-event' }>;
type GuidedEditorTarget = {
  entityType: 'cash-account' | 'forecast-event';
  entityId: string;
};
type EventRecurrenceChoice = 'one-time' | 'weekly' | 'biweekly' | 'monthly' | 'semimonthly';

const eventPaymentMethod = (
  event: ForecastEvent,
): 'cash-account' | 'credit-card' | 'payroll-deduction' =>
  event.kind === 'card-payment'
    ? 'cash-account'
    : (event.paymentMethod ?? (event.cardId ? 'credit-card' : 'cash-account'));

const eventCardActivityTreatment = (event: ForecastEvent): CardActivityTreatment =>
  event.cardActivityTreatment ?? 'additional';

const cardActivityTreatmentLabel = (event: ForecastEvent): string | null => {
  if (eventPaymentMethod(event) !== 'credit-card') return null;
  return eventCardActivityTreatment(event) === 'included-in-cycle-total'
    ? 'Already included in card cycle total'
    : 'Additional card purchase';
};

const eventLoanPaymentTreatment = (event: ForecastEvent): LoanPaymentTreatment =>
  event.loanPaymentTreatment ?? 'scheduled-draft-override';

const loanPaymentTreatmentLabel = (event: ForecastEvent): string | null => {
  if (event.kind !== 'loan-payment') return null;
  return eventLoanPaymentTreatment(event) === 'additional-principal'
    ? 'Extra principal (reduces debt)'
    : 'Scheduled draft override (cash timing only)';
};

const eventFinancialTreatmentLabel = (event: ForecastEvent): string | null =>
  cardActivityTreatmentLabel(event) ?? loanPaymentTreatmentLabel(event);

const eventRecurrenceChoice = (event: ForecastEvent): EventRecurrenceChoice => {
  const frequency = event.recurrenceRule?.frequency;
  return !frequency || frequency === 'once' ? 'one-time' : frequency;
};

const makeCashAccountEditRequest = (account: CashAccount, form: FormData): CashAccountRequest => ({
  entityType: 'cash-account',
  payload: {
    id: account.id,
    name: get(form, 'editAccountName'),
    type: get(form, 'editAccountType') as CashAccount['type'],
    openingBalanceCents: cents(form, 'editAccountBalance'),
    availableBalanceCents: optionalCents(form, 'editAccountAvailableBalance'),
    balanceAsOf: get(form, 'editAccountBalanceAsOf'),
    includedInLiquidity: form.get('editAccountLiquidity') === 'on',
    canFundOtherAccounts: form.get('editAccountFunding') === 'on',
    showOnOverview: account.showOnOverview,
    hardFloorCents: optionalCents(form, 'editAccountHardFloor'),
    preferredFloorCents: optionalCents(form, 'editAccountPreferredFloor'),
    transferDelayDays: Math.trunc(number(form, 'editAccountTransferDelay')),
    notes: get(form, 'editAccountNotes') || undefined,
  },
});

const makeEventRecurrence = (
  event: ForecastEvent,
  form: FormData,
): ForecastEvent['recurrenceRule'] => {
  const choice = get(form, 'editEventRecurrence') as EventRecurrenceChoice;
  switch (choice) {
    case 'weekly':
      return {
        frequency: 'weekly',
        interval: Math.trunc(number(form, 'editEventWeeklyInterval')),
      };
    case 'biweekly':
      return { frequency: 'biweekly' };
    case 'monthly':
      return {
        frequency: 'monthly',
        dayOfMonth: Math.trunc(number(form, 'editEventMonthlyDay')),
        interval: Math.trunc(number(form, 'editEventMonthlyInterval')),
      };
    case 'semimonthly':
      return {
        frequency: 'semimonthly',
        daysOfMonth: [
          Math.trunc(number(form, 'editEventSemimonthlyDayOne')),
          Math.trunc(number(form, 'editEventSemimonthlyDayTwo')),
        ],
      };
    case 'one-time':
      return event.recurrenceRule?.frequency === 'once' ? event.recurrenceRule : undefined;
  }
};

export const makeForecastEventEditRequest = (
  event: ForecastEvent,
  form: FormData,
): ForecastEventRequest => {
  const initialPaymentMethod = eventPaymentMethod(event);
  const selectedEventKind = get(form, 'editEventKind') as ForecastEvent['kind'];
  if (selectedEventKind === 'receivable-settlement' && event.kind !== 'receivable-settlement') {
    throw new Error(receivableSettlementGuidance);
  }
  if (event.kind === 'receivable-settlement' && selectedEventKind !== 'receivable-settlement') {
    throw new Error(
      'A linked received-money record must remain a receivable settlement. Use Money Owed to manage its owed-balance association.',
    );
  }
  const selectedPaymentMethod = get(form, 'editEventPaymentMethod') as ReturnType<
    typeof eventPaymentMethod
  >;
  const paymentMethod =
    selectedEventKind === 'card-payment' || selectedEventKind === 'loan-payment'
      ? 'cash-account'
      : selectedPaymentMethod;
  const recurrenceChoice = get(form, 'editEventRecurrence') as EventRecurrenceChoice;
  const initialRecurrenceChoice = eventRecurrenceChoice(event);
  const conservativeTreatment = get(form, 'editEventConservativeTreatment');
  const selectedCardId = get(form, 'editEventCardId');
  const cardActivityTreatment =
    form.get('editEventCardActivityTreatment') === 'included-in-cycle-total'
      ? 'included-in-cycle-total'
      : 'additional';

  return {
    entityType: 'forecast-event',
    payload: {
      id: event.id,
      accountId: get(form, 'editEventAccountId'),
      date: get(form, 'editEventDate'),
      kind: selectedEventKind,
      direction: get(form, 'editEventDirection') as ForecastEvent['direction'],
      amountCents: cents(form, 'editEventAmount'),
      certainty: get(form, 'editEventCertainty') as ForecastEvent['certainty'],
      status: get(form, 'editEventStatus') as ForecastEvent['status'],
      label: get(form, 'editEventLabel'),
      manualOrder: event.manualOrder,
      sourceRecordId:
        selectedEventKind === 'loan-payment'
          ? get(form, 'editEventLoanId')
          : selectedEventKind === 'card-payment'
            ? get(form, 'editEventCardCycleId') || undefined
            : event.sourceRecordId,
      incomeType: event.incomeType,
      parentIncomeEventId: event.parentIncomeEventId,
      notes:
        event.kind === 'receivable-settlement'
          ? mergeReceivableSettlementUserNotes(
              event.notes,
              get(form, 'editEventNotes') || undefined,
            )
          : get(form, 'editEventNotes') || undefined,
      receivableOccurrenceDate: event.receivableOccurrenceDate,
      receivableOccurrenceTargetCents: event.receivableOccurrenceTargetCents,
      transferId: event.transferId,
      hypothetical: event.hypothetical,
      accepted: event.accepted,
      includeInConservative:
        conservativeTreatment === 'automatic' ? undefined : conservativeTreatment === 'include',
      recurrenceRule: makeEventRecurrence(event, form),
      recurrenceEndDate:
        recurrenceChoice === 'one-time'
          ? initialRecurrenceChoice === 'one-time'
            ? event.recurrenceEndDate
            : undefined
          : get(form, 'editEventRecurrenceEnd') || undefined,
      paymentMethod:
        selectedEventKind === 'card-payment'
          ? 'cash-account'
          : paymentMethod === initialPaymentMethod
            ? event.paymentMethod
            : paymentMethod,
      cardId:
        paymentMethod === 'credit-card' || selectedEventKind === 'card-payment'
          ? selectedCardId
          : undefined,
      cardActivityTreatment: paymentMethod === 'credit-card' ? cardActivityTreatment : undefined,
      loanPaymentTreatment:
        selectedEventKind === 'loan-payment'
          ? ((get(form, 'editEventLoanPaymentTreatment') ||
              'scheduled-draft-override') as LoanPaymentTreatment)
          : undefined,
    },
  };
};

type GuidedEditorFeedbackProps = {
  message: string | null;
  error: string | null;
};

const GuidedEditorFeedback = ({ message, error }: GuidedEditorFeedbackProps): React.JSX.Element => {
  const styles = useCoreStyles();
  return (
    <>
      {message && (
        <div role="status" className={styles.positive}>
          {message}
        </div>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
    </>
  );
};

type CashAccountGuidedEditorProps = GuidedEditorFeedbackProps & {
  account: CashAccount;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

const CashAccountGuidedEditor = ({
  account,
  onSubmit,
  onCancel,
  message,
  error,
}: CashAccountGuidedEditorProps): React.JSX.Element => {
  const styles = useCoreStyles();
  return (
    <form aria-label="Cash account editor" className={styles.formSection} onSubmit={onSubmit}>
      <div className={styles.sectionIntro}>
        <Title2 as="h2">Edit cash account</Title2>
        <Text>
          The balance and date form the account's forecast starting point. Floors remain account
          guardrails; they do not change the balance.
        </Text>
      </div>
      <GuidedEditorFeedback message={message} error={error} />
      <div className={styles.grid}>
        <Field label="Account name">
          <Input name="editAccountName" defaultValue={account.name} required />
        </Field>
        <Field label="Account type">
          <Select name="editAccountType" defaultValue={account.type}>
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Balance">
          <Input
            name="editAccountBalance"
            inputMode="decimal"
            defaultValue={centsInput(account.openingBalanceCents)}
            required
          />
        </Field>
        <Field label="Balance as of">
          <Input
            name="editAccountBalanceAsOf"
            type="date"
            defaultValue={account.balanceAsOf}
            required
          />
        </Field>
        <Field
          label="Available balance (optional)"
          hint="Informational only. The dated balance remains the cash forecast starting point."
        >
          <Input
            name="editAccountAvailableBalance"
            inputMode="decimal"
            defaultValue={centsInput(account.availableBalanceCents)}
          />
        </Field>
        <Field label="Hard floor (optional)">
          <Input
            name="editAccountHardFloor"
            inputMode="decimal"
            defaultValue={centsInput(account.hardFloorCents)}
          />
        </Field>
        <Field label="Preferred floor (optional)">
          <Input
            name="editAccountPreferredFloor"
            inputMode="decimal"
            defaultValue={centsInput(account.preferredFloorCents)}
          />
        </Field>
        <Field label="Transfer delay days">
          <Input
            name="editAccountTransferDelay"
            type="number"
            min="0"
            max="30"
            step="1"
            defaultValue={String(account.transferDelayDays)}
            required
          />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <Textarea name="editAccountNotes" defaultValue={account.notes ?? ''} />
      </Field>
      <div className={styles.stack}>
        <Checkbox
          name="editAccountLiquidity"
          defaultChecked={account.includedInLiquidity}
          label="Include this account in liquid cash"
        />
        <Checkbox
          name="editAccountFunding"
          defaultChecked={account.canFundOtherAccounts}
          label="Allow this account to fund other accounts"
        />
      </div>
      <div className={styles.actions}>
        <Button appearance="primary" type="submit">
          Save account changes
        </Button>
        <Button type="button" onClick={onCancel}>
          Close editor
        </Button>
      </div>
    </form>
  );
};

type ForecastEventGuidedEditorProps = GuidedEditorFeedbackProps & {
  event: ForecastEvent;
  accounts: ManagedRecordsDto['accounts'];
  cards: ManagedRecordsDto['cards'];
  cardCycles: ManagedRecordsDto['cardCycles'];
  loans: ManagedRecordsDto['loans'];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

const ForecastEventGuidedEditor = ({
  event,
  accounts,
  cards,
  cardCycles,
  loans,
  onSubmit,
  onCancel,
  message,
  error,
}: ForecastEventGuidedEditorProps): React.JSX.Element => {
  const styles = useCoreStyles();
  const isTransfer = event.transferId !== undefined;
  const isTransferDebit = event.kind === 'transfer-debit';
  const initialPaymentMethod = eventPaymentMethod(event);
  const initialRecurrenceChoice = eventRecurrenceChoice(event);
  const [eventKind, setEventKind] = useState<ForecastEvent['kind']>(event.kind);
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod);
  const [selectedCardId, setSelectedCardId] = useState(event.cardId ?? cards[0]?.id ?? '');
  const [selectedCardCycleId, setSelectedCardCycleId] = useState(
    event.kind === 'card-payment' &&
      event.sourceRecordId &&
      cardCycles.some((cycle) => cycle.id === event.sourceRecordId && cycle.cardId === event.cardId)
      ? event.sourceRecordId
      : '',
  );
  const [selectedLoanId, setSelectedLoanId] = useState(
    event.kind === 'loan-payment' &&
      event.sourceRecordId &&
      loans.some((loan) => loan.id === event.sourceRecordId)
      ? event.sourceRecordId
      : (loans.find((loan) => (loan.status ?? 'active') === 'active')?.id ?? loans[0]?.id ?? ''),
  );
  const [direction, setDirection] = useState<ForecastEvent['direction']>(
    fixedDirectionForEventKind(event.kind) ?? event.direction,
  );
  const [certainty, setCertainty] = useState<ForecastEvent['certainty']>(event.certainty);
  const [conservativeTreatment, setConservativeTreatment] = useState(
    event.includeInConservative === undefined || event.certainty !== 'confirmed'
      ? 'automatic'
      : event.includeInConservative
        ? 'include'
        : 'exclude',
  );
  const [recurrenceChoice, setRecurrenceChoice] =
    useState<EventRecurrenceChoice>(initialRecurrenceChoice);
  const dateDay = Temporal.PlainDate.from(event.date).day;
  const monthlyRule = event.recurrenceRule?.frequency === 'monthly' ? event.recurrenceRule : null;
  const weeklyRule = event.recurrenceRule?.frequency === 'weekly' ? event.recurrenceRule : null;
  const semimonthlyRule =
    event.recurrenceRule?.frequency === 'semimonthly' ? event.recurrenceRule : null;
  const fixedDirection = isTransfer ? event.direction : fixedDirectionForEventKind(eventKind);
  const selectedCardCycles = cardCycles.filter((cycle) => cycle.cardId === selectedCardId);
  const selectedLoan = loans.find((loan) => loan.id === selectedLoanId);

  return (
    <form aria-label="Cash event editor" className={styles.formSection} onSubmit={onSubmit}>
      <div className={styles.sectionIntro}>
        <Title2 as="h2">Edit cash event</Title2>
        <Text>
          {isTransfer
            ? `This is the transfer ${isTransferDebit ? 'initiation' : 'arrival'} leg. Amount, status, label, and notes update both legs; changing the initiation date preserves the current transfer delay.`
            : 'Update when and how this item reaches the forecast. Import lineage and scenario metadata stay attached unless you deliberately use the advanced editor.'}
        </Text>
      </div>
      <GuidedEditorFeedback message={message} error={error} />
      <div className={styles.grid}>
        <Field label="Event label">
          <Input name="editEventLabel" defaultValue={event.label} required />
        </Field>
        <Field label="Notes (optional)">
          <Textarea
            name="editEventNotes"
            defaultValue={
              event.kind === 'receivable-settlement'
                ? (receivableSettlementUserNotes(event.notes) ?? '')
                : (event.notes ?? '')
            }
          />
        </Field>
        <Field label={isTransfer ? (isTransferDebit ? 'From account' : 'To account') : 'Account'}>
          <Select
            key={eventKind === 'loan-payment' ? selectedLoanId : 'ordinary-account'}
            name="editEventAccountId"
            defaultValue={
              eventKind === 'loan-payment'
                ? (selectedLoan?.fundingAccountId ?? event.accountId)
                : event.accountId
            }
            required
          >
            {accounts
              .filter(
                (account) =>
                  eventKind !== 'loan-payment' || account.id === selectedLoan?.fundingAccountId,
              )
              .map((account) => (
                <option value={account.id} key={account.id}>
                  {account.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={isTransfer ? (isTransferDebit ? 'Initiation date' : 'Arrival date') : 'Date'}>
          <Input name="editEventDate" type="date" defaultValue={event.date} required />
        </Field>
        <Field label="Amount">
          <Input
            name="editEventAmount"
            inputMode="decimal"
            defaultValue={centsInput(event.amountCents)}
            required
          />
        </Field>
        <Field label="Event type">
          {isTransfer ? (
            <>
              <input type="hidden" name="editEventKind" value={event.kind} />
              <Input
                value={isTransferDebit ? 'Transfer initiation' : 'Transfer arrival'}
                readOnly
              />
            </>
          ) : event.kind === 'receivable-settlement' ? (
            <>
              <input type="hidden" name="editEventKind" value="receivable-settlement" />
              <Input value="Receivable settlement (managed in Money Owed)" readOnly />
            </>
          ) : (
            <Select
              name="editEventKind"
              value={eventKind}
              onChange={(_, data) => {
                const nextKind = data.value as ForecastEvent['kind'];
                setEventKind(nextKind);
                const nextDirection = fixedDirectionForEventKind(nextKind);
                if (nextDirection) setDirection(nextDirection);
                if (nextKind === 'card-payment') {
                  setPaymentMethod('cash-account');
                  setSelectedCardId((current) => current || cards[0]?.id || '');
                }
              }}
            >
              <option value="income">Income</option>
              <option value="direct-commitment">Direct commitment</option>
              <option value="payable">Payable</option>
              <option value="card-payment">Card payment</option>
              <option value="loan-payment">Loan payment</option>
              <option value="reward-deposit">Cash reward deposit</option>
              <option value="manual-adjustment">Manual adjustment</option>
              <option value="baseline-spending">Baseline spending</option>
              <option value="scenario">Scenario commitment</option>
              <option value="investment-contribution">Investment contribution</option>
            </Select>
          )}
        </Field>
        {event.kind === 'receivable-settlement' && (
          <Text className={styles.muted}>{receivableSettlementGuidance}</Text>
        )}
        <Field label="Direction">
          {isTransfer ? (
            <>
              <input type="hidden" name="editEventDirection" value={event.direction} />
              <Input
                value={isTransferDebit ? 'Money leaves source' : 'Money reaches destination'}
                readOnly
              />
            </>
          ) : fixedDirection ? (
            <>
              <input type="hidden" name="editEventDirection" value={fixedDirection} />
              <Input
                value={
                  fixedDirection === 'inflow'
                    ? 'Money enters the account'
                    : 'Money leaves the account'
                }
                readOnly
              />
            </>
          ) : (
            <Select
              name="editEventDirection"
              value={direction}
              onChange={(_, data) => setDirection(data.value as ForecastEvent['direction'])}
            >
              <option value="inflow">Money in</option>
              <option value="outflow">Money out</option>
            </Select>
          )}
        </Field>
        <Field label="Certainty">
          {isTransfer ? (
            <>
              <input type="hidden" name="editEventCertainty" value="confirmed" />
              <Input value="Confirmed ownership transfer" readOnly />
            </>
          ) : (
            <Select
              name="editEventCertainty"
              value={certainty}
              onChange={(_, data) => {
                const next = data.value as ForecastEvent['certainty'];
                setCertainty(next);
                if (next !== 'confirmed' && conservativeTreatment !== 'automatic') {
                  setConservativeTreatment('automatic');
                }
              }}
            >
              <option value="confirmed">Confirmed amount and timing</option>
              <option value="expected">Expected</option>
              <option value="uncertain">Uncertain</option>
            </Select>
          )}
        </Field>
        <Field label="Status">
          <Select name="editEventStatus" defaultValue={event.status}>
            <option value="planned">Planned</option>
            <option value="scheduled">Scheduled</option>
            <option value="confirmed">Received or confirmed</option>
            <option value="paid">Paid</option>
            <option value="skipped">Skipped</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </Field>
        <Field label="Payment method">
          {isTransfer ? (
            <>
              <input type="hidden" name="editEventPaymentMethod" value="cash-account" />
              <Input value="Internal cash transfer" readOnly />
            </>
          ) : eventKind === 'card-payment' || eventKind === 'loan-payment' ? (
            <>
              <input type="hidden" name="editEventPaymentMethod" value="cash-account" />
              <Input
                value={
                  eventKind === 'card-payment'
                    ? 'Cash account payment to a card'
                    : 'Cash account payment to an installment loan'
                }
                readOnly
              />
            </>
          ) : (
            <Select
              name="editEventPaymentMethod"
              value={paymentMethod}
              onChange={(_, data) =>
                setPaymentMethod(data.value as ReturnType<typeof eventPaymentMethod>)
              }
            >
              <option value="cash-account">Cash account</option>
              <option value="credit-card" disabled={cards.length === 0}>
                Credit card activity
              </option>
              <option value="payroll-deduction">Already deducted from pay</option>
            </Select>
          )}
        </Field>
        {!isTransfer && (paymentMethod === 'credit-card' || eventKind === 'card-payment') && (
          <>
            <Field label={eventKind === 'card-payment' ? 'Card being paid' : 'Credit card'}>
              <Select
                name="editEventCardId"
                value={selectedCardId}
                onChange={(_, data) => {
                  setSelectedCardId(data.value);
                  setSelectedCardCycleId('');
                }}
                required
              >
                {cards.length === 0 && <option value="">Add a credit card first</option>}
                {cards.map((card) => (
                  <option value={card.id} key={card.id}>
                    {card.name}
                  </option>
                ))}
              </Select>
            </Field>
            {eventKind === 'card-payment' ? (
              <Field
                label="Statement cycle (optional)"
                hint="Link a statement when this payment is for one specific bill. Leave blank for a total-balance or manual card payment."
              >
                <Select
                  name="editEventCardCycleId"
                  value={selectedCardCycleId}
                  onChange={(_, data) => setSelectedCardCycleId(data.value)}
                >
                  <option value="">No specific statement cycle</option>
                  {selectedCardCycles.map((cycle) => (
                    <option value={cycle.id} key={cycle.id}>
                      Due {cycle.dueOn} · {cycle.state.replaceAll('-', ' ')} ·{' '}
                      {formatMoney(cycleDisplayAmount(cycle))}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field
                label="Card purchase treatment"
                hint="Choose already included when the card cycle total already contains this purchase, so it is not counted twice."
              >
                <Select
                  name="editEventCardActivityTreatment"
                  defaultValue={eventCardActivityTreatment(event)}
                  required
                >
                  <option value="additional">Additional — add this purchase to the cycle</option>
                  <option value="included-in-cycle-total">
                    Already included in card cycle total
                  </option>
                </Select>
              </Field>
            )}
          </>
        )}
        {!isTransfer && eventKind === 'loan-payment' && (
          <>
            <Field
              label="Installment loan being paid"
              hint="The payment must leave this loan's funding account."
            >
              <Select
                name="editEventLoanId"
                value={selectedLoanId}
                onChange={(_, data) => setSelectedLoanId(data.value)}
                required
              >
                {loans.length === 0 && <option value="">Add an installment loan first</option>}
                {loans.map((loan) => (
                  <option value={loan.id} key={loan.id}>
                    {loan.name} · {(loan.status ?? 'active').replaceAll('-', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="How this payment affects the loan"
              hint="A draft override prevents duplicate cash and must land on a regular due date. Extra principal is an additional cash outflow that lowers principal, interest, and payoff time without replacing the regular draft."
            >
              <Select
                name="editEventLoanPaymentTreatment"
                defaultValue={
                  event.kind === 'loan-payment'
                    ? eventLoanPaymentTreatment(event)
                    : 'scheduled-draft-override'
                }
                required
              >
                <option value="scheduled-draft-override">
                  Regular scheduled draft already entered — cash timing only
                </option>
                <option value="additional-principal">
                  Extra principal — reduce debt and keep the regular draft
                </option>
              </Select>
            </Field>
          </>
        )}
        {isTransfer ? (
          <Field
            label="Protected forecast treatment"
            hint="Transfers preserve consolidated ownership and remain paired in both views."
          >
            <input type="hidden" name="editEventConservativeTreatment" value="automatic" />
            <Input value="Always paired while active" readOnly />
          </Field>
        ) : direction === 'outflow' ? (
          <Field
            label="Protected forecast treatment"
            hint="Every active outflow stays in the protected forecast, regardless of certainty."
          >
            <input type="hidden" name="editEventConservativeTreatment" value="automatic" />
            <Input value="Always included while active" readOnly />
          </Field>
        ) : (
          <Field
            label="Protected forecast treatment"
            hint={
              certainty === 'confirmed'
                ? 'Confirmed inflows are included automatically; you may deliberately exclude one.'
                : 'Expected and uncertain inflows stay out of protected cash until confirmed.'
            }
          >
            <Select
              name="editEventConservativeTreatment"
              value={conservativeTreatment}
              onChange={(_, data) => setConservativeTreatment(data.value)}
            >
              <option value="automatic">Automatic from certainty</option>
              {certainty === 'confirmed' && (
                <option value="include">Include confirmed inflow</option>
              )}
              {certainty === 'confirmed' && (
                <option value="exclude">Exclude confirmed inflow</option>
              )}
            </Select>
          </Field>
        )}
        <Field label="Repeat">
          {isTransfer && !isTransferDebit ? (
            <>
              <input type="hidden" name="editEventRecurrence" value="one-time" />
              <Input value="Derived from transfer initiation" readOnly />
            </>
          ) : (
            <Select
              name="editEventRecurrence"
              value={recurrenceChoice}
              onChange={(_, data) => setRecurrenceChoice(data.value as EventRecurrenceChoice)}
            >
              <option value="one-time">One time</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every two weeks</option>
              <option value="monthly">Monthly</option>
              <option value="semimonthly">Twice a month</option>
            </Select>
          )}
        </Field>
        {(!isTransfer || isTransferDebit) && recurrenceChoice === 'weekly' && (
          <Field label="Repeat every (weeks)">
            <Input
              name="editEventWeeklyInterval"
              type="number"
              min="1"
              max="52"
              step="1"
              defaultValue={String(weeklyRule?.interval ?? 1)}
              required
            />
          </Field>
        )}
        {(!isTransfer || isTransferDebit) && recurrenceChoice === 'monthly' && (
          <>
            <Field label="Day of month">
              <Input
                name="editEventMonthlyDay"
                type="number"
                min="1"
                max="31"
                step="1"
                defaultValue={String(monthlyRule?.dayOfMonth ?? dateDay)}
                required
              />
            </Field>
            <Field label="Repeat every (months)">
              <Input
                name="editEventMonthlyInterval"
                type="number"
                min="1"
                max="24"
                step="1"
                defaultValue={String(monthlyRule?.interval ?? 1)}
                required
              />
            </Field>
          </>
        )}
        {(!isTransfer || isTransferDebit) && recurrenceChoice === 'semimonthly' && (
          <>
            <Field label="First day of month">
              <Input
                name="editEventSemimonthlyDayOne"
                type="number"
                min="1"
                max="31"
                step="1"
                defaultValue={String(semimonthlyRule?.daysOfMonth[0] ?? 1)}
                required
              />
            </Field>
            <Field label="Second day of month">
              <Input
                name="editEventSemimonthlyDayTwo"
                type="number"
                min="1"
                max="31"
                step="1"
                defaultValue={String(semimonthlyRule?.daysOfMonth[1] ?? 15)}
                required
              />
            </Field>
          </>
        )}
        {(!isTransfer || isTransferDebit) && recurrenceChoice !== 'one-time' && (
          <Field label="Repeat through (optional)">
            <Input
              name="editEventRecurrenceEnd"
              type="date"
              defaultValue={event.recurrenceEndDate ?? ''}
            />
          </Field>
        )}
      </div>
      <div className={styles.actions}>
        <Button appearance="primary" type="submit">
          Save event changes
        </Button>
        <Button type="button" onClick={onCancel}>
          Close editor
        </Button>
      </div>
    </form>
  );
};

export const RecordsPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedRecordType = searchParams.get('type');
  const requestedEventKind = searchParams.get('kind');
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [type, setType] = useState<EditorType>(() =>
    isEditorType(requestedRecordType) ? requestedRecordType : 'forecast-event',
  );
  const [createEventKind, setCreateEventKind] = useState<ForecastEvent['kind']>(() =>
    isForecastEventKind(requestedEventKind) ? requestedEventKind : 'income',
  );
  const [createEventDirection, setCreateEventDirection] = useState<ForecastEvent['direction']>(() =>
    defaultDirectionForEventKind(
      isForecastEventKind(requestedEventKind) ? requestedEventKind : 'income',
    ),
  );
  const [createEventPaymentMethod, setCreateEventPaymentMethod] = useState<
    'cash-account' | 'credit-card' | 'payroll-deduction'
  >('cash-account');
  const [createEventCardId, setCreateEventCardId] = useState('');
  const [createEventCardCycleId, setCreateEventCardCycleId] = useState('');
  const [createEventLoanId, setCreateEventLoanId] = useState('');
  const [recordFilter, setRecordFilter] = useState<'all' | RecordLibraryType>(() =>
    isRecordLibraryType(requestedRecordType) ? requestedRecordType : 'all',
  );
  const [addRecordOpen, setAddRecordOpen] = useState(searchParams.get('mode') === 'add');
  const [recordSearch, setRecordSearch] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UpsertManagedEntityRequest | null>(null);
  const [guidedEditing, setGuidedEditing] = useState<GuidedEditorTarget | null>(null);
  const [editingJson, setEditingJson] = useState('');
  const [importReview, setImportReview] = useState<ImportReviewDto | null>(null);
  const [importReviewLoaded, setImportReviewLoaded] = useState(false);
  const [importReviewError, setImportReviewError] = useState<string | null>(null);
  useEffect(() => {
    void window.balanceBook
      .getImportReview()
      .then((result) => {
        if (result.ok) setImportReview(result.value);
        else setImportReviewError(result.error);
      })
      .catch((caught: unknown) =>
        setImportReviewError(
          caught instanceof Error ? caught.message : 'Workbook import review could not be loaded.',
        ),
      )
      .finally(() => setImportReviewLoaded(true));
  }, []);
  useEffect(() => {
    void loadRecords()
      .then(setRecords)
      .catch((caught: Error) => setError(caught.message));
  }, []);
  useEffect(() => {
    if (searchParams.get('sourceReview') !== '1' || !importReview) return;
    document.getElementById('workbook-import-review')?.scrollIntoView({ block: 'start' });
  }, [importReview, searchParams]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError(null);
    setMessage(null);
    try {
      const request = makeRequest(type, new FormData(formElement));
      const result = await window.balanceBook.upsertRecord(request);
      if (!result.ok) throw new Error(result.error);
      setRecords(result.value);
      setGuidedEditing(null);
      formElement.reset();
      setCreateEventKind('income');
      setCreateEventDirection('inflow');
      setCreateEventPaymentMethod('cash-account');
      setCreateEventCardId('');
      setCreateEventCardCycleId('');
      setCreateEventLoanId('');
      setMessage('Record saved locally and added to the audit history.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Record could not be saved');
    }
  };

  const remove = async (entityType: UpsertManagedEntityRequest['entityType'], entityId: string) => {
    const pairedTransfer =
      entityType === 'forecast-event'
        ? records?.events.find((event) => event.id === entityId)?.transferId
        : undefined;
    if (
      !window.confirm(
        pairedTransfer
          ? 'Delete this entire internal transfer? Its initiation and arrival legs will be removed together.'
          : 'Delete this record? To protect your history, records with linked financial details must be cleared first.',
      )
    )
      return;
    const result = await window.balanceBook.deleteRecord({ entityType, entityId, confirmed: true });
    if (result.ok) {
      setRecords(result.value);
      if (pairedTransfer) setMessage('Transfer initiation and arrival deleted together.');
      if (guidedEditing?.entityType === entityType && guidedEditing.entityId === entityId) {
        setGuidedEditing(null);
      }
    } else setError(result.error);
  };

  const startEditing = (request: UpsertManagedEntityRequest) => {
    setError(null);
    setMessage(null);
    setGuidedEditing(null);
    setEditing(request);
    setEditingJson(JSON.stringify(request.payload, null, 2));
  };

  const startGuidedEditing = (entityType: GuidedEditorTarget['entityType'], entityId: string) => {
    setError(null);
    setMessage(null);
    setEditing(null);
    setEditingJson('');
    setGuidedEditing({ entityType, entityId });
  };

  const closeGuidedEditing = () => {
    setGuidedEditing(null);
    setError(null);
    setMessage(null);
  };

  const saveGuidedEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!guidedEditing || !records) return;
    setError(null);
    setMessage(null);
    try {
      let request: CashAccountRequest | ForecastEventRequest;
      if (guidedEditing.entityType === 'cash-account') {
        const account = records.accounts.find((item) => item.id === guidedEditing.entityId);
        if (!account) throw new Error('The cash account is no longer available.');
        request = makeCashAccountEditRequest(account, new FormData(event.currentTarget));
      } else {
        const forecastEvent = records.events.find((item) => item.id === guidedEditing.entityId);
        if (!forecastEvent) throw new Error('The cash event is no longer available.');
        request = makeForecastEventEditRequest(forecastEvent, new FormData(event.currentTarget));
      }
      const result = await window.balanceBook.upsertRecord(request);
      if (!result.ok) throw new Error(result.error);
      setRecords(result.value);
      setMessage(
        guidedEditing.entityType === 'cash-account'
          ? 'Cash account updated; the forecast now uses the new balance and guardrails.'
          : 'Cash event updated; timing, recurrence, and forecast treatment are now in effect.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Record could not be updated');
    }
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    setError(null);
    setMessage(null);
    try {
      const payload: unknown = JSON.parse(editingJson);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('The record must be a JSON object.');
      }
      if (editing.entityType === 'forecast-event') {
        const existingEvent = records?.events.find(
          (forecastEvent) => forecastEvent.id === editing.payload.id,
        );
        const nextKind = (payload as { kind?: unknown }).kind;
        if (nextKind === 'receivable-settlement' && existingEvent?.kind !== nextKind) {
          throw new Error(receivableSettlementGuidance);
        }
        if (
          existingEvent?.kind === 'receivable-settlement' &&
          nextKind !== 'receivable-settlement'
        ) {
          throw new Error(
            'A linked received-money record must remain a receivable settlement. Use Money Owed to manage its owed-balance association.',
          );
        }
      }
      const result = await window.balanceBook.upsertRecord({
        entityType: editing.entityType,
        payload,
      } as UpsertManagedEntityRequest);
      if (!result.ok) throw new Error(result.error);
      setRecords(result.value);
      setEditing(null);
      setEditingJson('');
      setMessage('Record changes saved locally and added to the audit history.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Record could not be updated');
    }
  };

  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading records" variant="list" />
    );
  const createEventFixedDirection = fixedDirectionForEventKind(createEventKind);
  const accountOptions = records.accounts.map((account) => (
    <option key={account.id} value={account.id}>
      {account.name}
    </option>
  ));
  const cardOptions = records.cards.map((card) => (
    <option key={card.id} value={card.id}>
      {card.name}
    </option>
  ));
  const createEventCards =
    createEventKind === 'card-payment'
      ? records.cards
      : records.cards.filter((card) => card.status === 'active');
  const effectiveCreateEventCardId = createEventCards.some((card) => card.id === createEventCardId)
    ? createEventCardId
    : (createEventCards[0]?.id ?? '');
  const effectiveCreateEventLoanId =
    createEventLoanId ||
    records.loans.find((loan) => (loan.status ?? 'active') === 'active')?.id ||
    records.loans[0]?.id ||
    '';
  const effectiveCreateEventLoan = records.loans.find(
    (loan) => loan.id === effectiveCreateEventLoanId,
  );
  const createEventCardCycles = records.cardCycles.filter(
    (cycle) => cycle.cardId === effectiveCreateEventCardId,
  );
  const recordPaymentInstrumentName = (value?: string): string => {
    if (!value) return '';
    const [kind, id] = value.split(':', 2);
    if (kind === 'cash-account') {
      return records.accounts.find((account) => account.id === id)?.name ?? value;
    }
    if (kind === 'credit-card') {
      return records.cards.find((card) => card.id === id)?.name ?? value;
    }
    return value;
  };
  const recordAsOfDate = Temporal.Now.plainDateISO().toString();
  const incomePlans = summarizeIncomePlans(records.events);
  const incomeStreams = summarizeBaseIncomeStreams(incomePlans);
  const groupedIncomeEventIds = new Set(
    incomeStreams.flatMap((stream) =>
      incomeStreamMemberEvents(records.events, incomePlans, stream).map((event) => event.id),
    ),
  );
  const logicalIncomeRows = incomeStreams.map((stream) => {
    const phase = effectiveIncomePhase(stream, recordAsOfDate);
    const currentTotalCents = effectiveIncomeStreamTotalCents(stream, incomePlans, recordAsOfDate);
    const linkedChanges = [
      ...linkedRaisePlansForStream(incomePlans, stream),
      ...relatedOneTimeIncomeForStream(records.events, stream),
    ];
    const linkedChangeLabel =
      linkedChanges.length === 0
        ? ''
        : ` · ${linkedChanges.length} linked pay change${linkedChanges.length === 1 ? '' : 's'}/one-time item${linkedChanges.length === 1 ? '' : 's'}`;
    return {
      type: 'forecast-event' as const,
      id: `income-stream:${stream.id}`,
      title: incomeStreamTitle(stream, phase),
      detail: `One income source · ${formatMoney(currentTotalCents)} current take-home (${formatMoney(phase.totalCents)} base) · ${incomeCadenceLabel(
        phase.first,
      )}${linkedChangeLabel} · ${stream.phases.length} routing phase${stream.phases.length === 1 ? '' : 's'} · ${incomePhaseTimingLabel(
        stream,
        phase,
        recordAsOfDate,
      )}: ${incomePhaseAllocationLabel(phase, records.accounts)}`,
      request: makeEditRequest('forecast-event', phase.first),
      memberEventIds: incomeStreamMemberEvents(records.events, incomePlans, stream).map(
        (event) => event.id,
      ),
    };
  });
  const groupedIncomeRowIds = new Set(logicalIncomeRows.map((row) => row.id));
  const rows = [
    ...records.accounts.map((item) => ({
      type: 'cash-account' as const,
      id: item.id,
      title: item.name,
      detail: `${formatMoney(item.openingBalanceCents)} as of ${item.balanceAsOf}${
        item.availableBalanceCents === undefined
          ? ''
          : ` · ${formatMoney(item.availableBalanceCents)} available`
      }${item.notes ? ' · notes added' : ''}`,
      request: makeEditRequest('cash-account', item),
    })),
    ...logicalIncomeRows,
    ...records.events
      .filter((item) => !groupedIncomeEventIds.has(item.id))
      .map((item) => ({
        type: 'forecast-event' as const,
        id: item.id,
        title: item.label,
        detail: `${item.date} · ${item.direction} ${formatMoney(item.amountCents)} · ${item.kind}${
          eventFinancialTreatmentLabel(item) ? ` · ${eventFinancialTreatmentLabel(item)}` : ''
        }`,
        request: makeEditRequest('forecast-event', item),
      })),
    ...records.cards.map((item) => ({
      type: 'credit-card' as const,
      id: item.id,
      title: item.name,
      detail: `${[item.issuer, item.lastFour ? `ending ${item.lastFour}` : undefined]
        .filter(Boolean)
        .join(' · ')}${item.issuer || item.lastFour ? ' · ' : ''}Future estimate ${formatMoney(
        item.defaultFutureStatementCents,
      )} · ${item.estimatePolicy}`,
      request: makeEditRequest('credit-card', item),
    })),
    ...records.cardCycles.map((item) => ({
      type: 'card-cycle' as const,
      id: item.id,
      title: `Card cycle due ${item.dueOn}`,
      detail: `${item.state} · recorded/locked ${formatMoney(cycleDisplayAmount(item))} · baseline ${formatMoney(item.defaultEstimateCents)} · payment ${item.paymentOn ?? item.dueOn}`,
      request: makeEditRequest('card-cycle', item),
    })),
    ...records.loans.map((item) => ({
      type: 'loan' as const,
      id: item.id,
      title: item.name,
      detail: `${[item.lender, item.loanType].filter(Boolean).join(' · ')}${
        item.lender || item.loanType ? ' · ' : ''
      }${formatMoney(item.principalCents)} principal · ${(item.annualRateBasisPoints / 100).toFixed(
        2,
      )}%${item.maturityDate ? ` · matures ${item.maturityDate}` : ''}`,
      request: makeEditRequest('loan', item),
    })),
    ...records.receivables.map((item) => ({
      type: 'receivable' as const,
      id: item.id,
      title: item.description,
      detail: `${
        hasRecurringReceivableSchedule(item)
          ? item.settlementAnchorEventId
            ? `${formatMoney(
                item.recurringAmountCents ?? item.originalAmountCents,
              )} · ${billRelativeReceiptTimingLabel(
                item.settlementOffsetDays ?? 0,
                records.events.find((event) => event.id === item.settlementAnchorEventId)?.label ??
                  'linked bill',
              )} · first ${item.expectedDate}`
            : `${formatMoney(item.recurringAmountCents ?? item.originalAmountCents)} ${item.recurrenceRule?.frequency ?? 'repeating'} · next ${item.expectedDate}`
          : `${formatMoney(item.remainingAmountCents)} remaining · ${item.certainty}`
      }${
        item.paymentInstrument
          ? ` · paid with ${recordPaymentInstrumentName(item.paymentInstrument)}`
          : ''
      }${item.relatedExpenseId ? ' · expense linked' : ''}`,
      request: makeEditRequest('receivable', item),
    })),
    ...records.assets.map((item) => ({
      type: 'asset' as const,
      id: item.id,
      title: item.name,
      detail: `${formatMoney(item.valueCents)} · ${item.type}${
        item.contributionAmountCents === undefined
          ? ''
          : ` · ${formatMoney(item.contributionAmountCents)} contribution`
      }${
        item.contributionRateBasisPoints === undefined
          ? ''
          : ` · ${(item.contributionRateBasisPoints / 100).toFixed(2)}% contribution`
      }${item.restrictionStatus ? ` · ${item.restrictionStatus.replaceAll('-', ' ')}` : ''}${
        item.linkedLiabilityId ? ' · liability linked' : ''
      }`,
      request: makeEditRequest('asset', item),
    })),
    ...records.rewardPrograms.map((item) => ({
      type: 'reward-program' as const,
      id: item.id,
      title: `${item.rewardType} rewards`,
      detail: `${(item.baseRateBasisPoints / 100).toFixed(2)}% · ${item.treatment}`,
      request: makeEditRequest('reward-program', item),
    })),
    ...records.reconciliations.map((item) => ({
      type: 'reconciliation' as const,
      id: item.id,
      title: `Balance check on ${item.date}`,
      detail: `${formatMoney(item.actualBalanceCents)} actual · ${formatMoney(item.varianceCents)} variance · ${item.resolution}`,
      request: makeEditRequest('reconciliation', item),
    })),
    ...records.savedScenarios.map((item) => ({
      type: 'saved-scenario' as const,
      id: item.id,
      title: item.description,
      detail: `${formatMoney(item.amountCents)} on ${item.settlementDate} · ${item.status}`,
      request: makeEditRequest('saved-scenario', item),
    })),
  ];
  const normalizedSearch = recordSearch.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (recordFilter === 'all' || row.type === recordFilter) &&
      (normalizedSearch === '' ||
        `${row.title} ${row.detail} ${row.type}`.toLocaleLowerCase().includes(normalizedSearch)),
  );

  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Financial records</Title1>
        <Text>
          This is the complete, advanced record library behind the guided pages. Use it for setup,
          unusual fields, and audit work; use the topic pages for faster day-to-day updates.
        </Text>
      </div>
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Choose the simplest place to make a change</Title2>
          <Text>
            Every guided editor saves into this same native record set. Nothing here is a second
            database, and editing a card statement or receivable immediately feeds the cash model.
          </Text>
        </div>
        <div className={styles.actions}>
          <Button onClick={() => navigate('/income')}>Income and raises</Button>
          <Button onClick={() => navigate('/cards')}>Cards and statements</Button>
          <Button onClick={() => navigate('/receivables')}>Money owed to you</Button>
          <Button onClick={() => navigate('/loans')}>Loans</Button>
          <Button onClick={() => navigate('/baseline')}>Transfer planner</Button>
          <Button onClick={() => navigate('/net-worth')}>Assets and net worth</Button>
          <Button onClick={() => navigate('/refinance')}>Refinance planner</Button>
          <Button onClick={() => navigate('/forecast')}>Cash forecast</Button>
        </div>
      </Card>
      <details
        className={styles.recordCreator}
        open={addRecordOpen}
        onToggle={(event) => setAddRecordOpen(event.currentTarget.open)}
      >
        <summary>Add a financial record</summary>
        <div>
          <div className={styles.sectionIntro}>
            <Title2 as="h2">Advanced record creation</Title2>
            <Text>
              Use this when the guided page does not expose the record type you need. All saves are
              validated, profile-owned, and written to audit history.
            </Text>
          </div>
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            {!guidedEditing && error && (
              <div role="alert" className={styles.error}>
                {error}
              </div>
            )}
            {!guidedEditing && message && (
              <div role="status" className={styles.positive}>
                {message}
              </div>
            )}
            <Field label="Record type">
              <Select
                value={type}
                onChange={(_, data) => {
                  setType(data.value as EditorType);
                  setCreateEventKind('income');
                  setCreateEventDirection('inflow');
                  setCreateEventPaymentMethod('cash-account');
                }}
              >
                <option value="forecast-event">Cash event or obligation</option>
                <option value="cash-account">Cash account</option>
                <option value="credit-card">Credit card</option>
                <option value="card-cycle">Card statement cycle</option>
                <option value="loan">Loan</option>
                <option value="receivable">Receivable/shared expense</option>
                <option value="asset">Investment or tangible asset</option>
                <option value="reward-program">Reward program</option>
              </Select>
            </Field>
            {type !== 'card-cycle' && type !== 'reward-program' && (
              <Field
                label={
                  type === 'receivable' ? 'Source' : type === 'forecast-event' ? 'Label' : 'Name'
                }
              >
                <Input name="name" required />
              </Field>
            )}
            {type === 'receivable' && (
              <Field label="Description">
                <Textarea name="description" required />
              </Field>
            )}
            {[
              'cash-account',
              'forecast-event',
              'credit-card',
              'loan',
              'receivable',
              'asset',
              'reward-program',
            ].includes(type) && (
              <Field
                label={
                  type === 'reward-program'
                    ? 'Annual fee'
                    : type === 'credit-card'
                      ? 'Default future statement'
                      : type === 'loan'
                        ? 'Principal'
                        : type === 'receivable'
                          ? 'Original amount'
                          : type === 'asset'
                            ? 'Value'
                            : type === 'cash-account'
                              ? 'Opening balance'
                              : 'Amount'
                }
              >
                <Input name="amount" inputMode="decimal" required defaultValue="0.00" />
              </Field>
            )}
            {['cash-account', 'loan', 'receivable', 'card-cycle'].includes(type) && (
              <Field
                label={
                  type === 'cash-account'
                    ? 'Account hard floor'
                    : type === 'loan'
                      ? 'Accrued interest'
                      : type === 'receivable'
                        ? 'Remaining amount'
                        : 'Actual activity'
                }
              >
                <Input name="secondaryAmount" inputMode="decimal" required defaultValue="0.00" />
              </Field>
            )}
            {[
              'cash-account',
              'forecast-event',
              'card-cycle',
              'loan',
              'receivable',
              'asset',
              'reward-program',
            ].includes(type) && (
              <Field
                label={
                  type === 'cash-account'
                    ? 'Balance as of'
                    : type === 'card-cycle'
                      ? 'Cycle opens'
                      : type === 'loan'
                        ? 'Balance date'
                        : type === 'asset'
                          ? 'Valuation date'
                          : type === 'reward-program'
                            ? 'Expected receipt date (optional)'
                            : 'Date'
                }
              >
                <Input name="date" type="date" required={type !== 'reward-program'} />
              </Field>
            )}
            {['forecast-event', 'credit-card', 'loan', 'receivable'].includes(type) && (
              <Field
                label={
                  type === 'credit-card' || type === 'loan'
                    ? 'Funding account'
                    : type === 'receivable'
                      ? 'Destination account'
                      : 'Account'
                }
              >
                <Select
                  key={
                    type === 'forecast-event' && createEventKind === 'loan-payment'
                      ? effectiveCreateEventLoanId
                      : 'ordinary-create-account'
                  }
                  name="accountId"
                  defaultValue={
                    type === 'forecast-event' && createEventKind === 'loan-payment'
                      ? effectiveCreateEventLoan?.fundingAccountId
                      : undefined
                  }
                  required
                >
                  {type === 'forecast-event' && createEventKind === 'loan-payment'
                    ? accountOptions.filter(
                        (option) => option.key === effectiveCreateEventLoan?.fundingAccountId,
                      )
                    : accountOptions}
                </Select>
              </Field>
            )}
            {['card-cycle', 'reward-program'].includes(type) && (
              <Field label="Card">
                <Select name="cardId" required>
                  {cardOptions}
                </Select>
              </Field>
            )}
            {type === 'cash-account' && (
              <div className={styles.grid}>
                <Field label="Account type">
                  <Select name="accountType">
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                    <option value="cash">Cash</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Field label="Transfer delay days">
                  <Input name="delayDays" type="number" min="0" max="30" defaultValue="0" />
                </Field>
              </div>
            )}
            {type === 'forecast-event' && (
              <div className={styles.grid}>
                <Field label="Event kind">
                  <Select
                    name="eventKind"
                    value={createEventKind}
                    onChange={(_, data) => {
                      const nextKind = data.value as ForecastEvent['kind'];
                      setCreateEventKind(nextKind);
                      setCreateEventDirection(defaultDirectionForEventKind(nextKind));
                      if (nextKind === 'card-payment') {
                        setCreateEventPaymentMethod('cash-account');
                        setCreateEventCardId((current) => current || records.cards[0]?.id || '');
                      }
                      if (nextKind === 'loan-payment') {
                        setCreateEventPaymentMethod('cash-account');
                        setCreateEventLoanId(
                          (current) =>
                            current ||
                            records.loans.find((loan) => (loan.status ?? 'active') === 'active')
                              ?.id ||
                            records.loans[0]?.id ||
                            '',
                        );
                      }
                    }}
                  >
                    <option value="income">Income</option>
                    <option value="direct-commitment">Direct commitment</option>
                    <option value="payable">Payable</option>
                    <option value="card-payment">Card payment</option>
                    <option value="loan-payment">Loan payment</option>
                    <option value="reward-deposit">Cash reward deposit</option>
                    <option value="baseline-spending">Baseline spending</option>
                    <option value="investment-contribution">Investment contribution</option>
                    <option value="manual-adjustment">Manual adjustment</option>
                  </Select>
                </Field>
                <Text className={styles.muted}>{receivableSettlementGuidance}</Text>
                <Field
                  label="Direction"
                  hint={
                    createEventFixedDirection
                      ? 'This event type has a fixed cash-flow direction.'
                      : undefined
                  }
                >
                  {createEventFixedDirection ? (
                    <>
                      <input type="hidden" name="direction" value={createEventFixedDirection} />
                      <Input
                        value={
                          createEventFixedDirection === 'inflow'
                            ? 'Money enters the account'
                            : 'Money leaves the account'
                        }
                        readOnly
                      />
                    </>
                  ) : (
                    <Select
                      name="direction"
                      value={createEventDirection}
                      onChange={(_, data) =>
                        setCreateEventDirection(data.value as ForecastEvent['direction'])
                      }
                    >
                      <option value="inflow">Money enters the account</option>
                      <option value="outflow">Money leaves the account</option>
                    </Select>
                  )}
                </Field>
                <Field label="Certainty">
                  <Select name="certainty">
                    <option value="confirmed">Confirmed</option>
                    <option value="expected">Expected</option>
                    <option value="uncertain">Uncertain</option>
                  </Select>
                </Field>
                <Field label="Payment method">
                  {createEventKind === 'card-payment' || createEventKind === 'loan-payment' ? (
                    <>
                      <input type="hidden" name="paymentMethod" value="cash-account" />
                      <Input
                        value={
                          createEventKind === 'card-payment'
                            ? 'Cash account payment to a card'
                            : 'Cash account payment to an installment loan'
                        }
                        readOnly
                      />
                    </>
                  ) : (
                    <Select
                      name="paymentMethod"
                      value={createEventPaymentMethod}
                      onChange={(_, data) =>
                        setCreateEventPaymentMethod(data.value as typeof createEventPaymentMethod)
                      }
                    >
                      <option value="cash-account">Cash account</option>
                      <option value="credit-card" disabled={records.cards.length === 0}>
                        Credit card activity
                      </option>
                      <option value="payroll-deduction">Already deducted from pay</option>
                    </Select>
                  )}
                </Field>
                {(createEventPaymentMethod === 'credit-card' ||
                  createEventKind === 'card-payment') && (
                  <>
                    <Field
                      label={createEventKind === 'card-payment' ? 'Card being paid' : 'Credit card'}
                    >
                      <Select
                        name="cardId"
                        value={effectiveCreateEventCardId}
                        onChange={(_, data) => {
                          setCreateEventCardId(data.value);
                          setCreateEventCardCycleId('');
                        }}
                        required
                      >
                        {createEventCards.length === 0 && (
                          <option value="">No active card is available</option>
                        )}
                        {createEventCards.map((card) => (
                          <option key={card.id} value={card.id}>
                            {card.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {createEventKind === 'card-payment' ? (
                      <Field
                        label="Statement cycle (optional)"
                        hint="Link a statement when this payment is for one specific bill. Leave blank for a total-balance or manual card payment."
                      >
                        <Select
                          name="cardCycleId"
                          value={createEventCardCycleId}
                          onChange={(_, data) => setCreateEventCardCycleId(data.value)}
                        >
                          <option value="">No specific statement cycle</option>
                          {createEventCardCycles.map((cycle) => (
                            <option value={cycle.id} key={cycle.id}>
                              Due {cycle.dueOn} · {cycle.state.replaceAll('-', ' ')} ·{' '}
                              {formatMoney(cycleDisplayAmount(cycle))}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : (
                      <Field
                        label="Card purchase treatment"
                        hint="Choose already included when the card cycle total already contains this purchase, so it is not counted twice."
                      >
                        <Select name="cardActivityTreatment" defaultValue="additional" required>
                          <option value="additional">
                            Additional — add this purchase to the cycle
                          </option>
                          <option value="included-in-cycle-total">
                            Already included in card cycle total
                          </option>
                        </Select>
                      </Field>
                    )}
                  </>
                )}
                {createEventKind === 'loan-payment' && (
                  <>
                    <Field
                      label="Installment loan being paid"
                      hint="The payment account is set from the selected loan so cash and debt stay linked."
                    >
                      <Select
                        name="loanId"
                        value={effectiveCreateEventLoanId}
                        onChange={(_, data) => setCreateEventLoanId(data.value)}
                        required
                      >
                        {records.loans.length === 0 && (
                          <option value="">Add an installment loan first</option>
                        )}
                        {records.loans.map((loan) => (
                          <option value={loan.id} key={loan.id}>
                            {loan.name} · {(loan.status ?? 'active').replaceAll('-', ' ')}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="How this payment affects the loan"
                      hint="A draft override prevents duplicate cash and must land on a regular due date. Extra principal is additional cash that lowers principal and future interest without replacing the regular draft."
                    >
                      <Select
                        name="loanPaymentTreatment"
                        defaultValue="scheduled-draft-override"
                        required
                      >
                        <option value="scheduled-draft-override">
                          Regular scheduled draft already entered — cash timing only
                        </option>
                        <option value="additional-principal">
                          Extra principal — reduce debt and keep the regular draft
                        </option>
                      </Select>
                    </Field>
                  </>
                )}
                <Field label="Recurrence">
                  <Select name="recurrenceFrequency" defaultValue="once">
                    <option value="once">One time</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every two weeks</option>
                    <option value="monthly">Monthly</option>
                  </Select>
                </Field>
                <Field label="Recurrence end (optional)">
                  <Input name="recurrenceEndDate" type="date" />
                </Field>
              </div>
            )}
            {type === 'credit-card' && (
              <>
                <div className={styles.grid}>
                  <Field label="Estimate policy">
                    <Select name="estimatePolicy">
                      <option value="baseline-guardrail">Baseline guardrail</option>
                      <option value="actual-reset">Actual reset</option>
                    </Select>
                  </Field>
                  <Field label="Payment policy">
                    <Select name="paymentPolicy">
                      <option value="full-statement">Full statement</option>
                      <option value="minimum">Minimum</option>
                      <option value="fixed">Fixed</option>
                      <option value="manual">Manual</option>
                    </Select>
                  </Field>
                </div>
                <details>
                  <summary>Advanced card terms (optional)</summary>
                  <div className={styles.grid}>
                    <Field label="APR (optional)">
                      <Input name="apr" inputMode="decimal" />
                    </Field>
                    <Field label="Fixed payment (optional)">
                      <Input name="fixedPayment" inputMode="decimal" />
                    </Field>
                    <Field label="Minimum payment (optional)">
                      <Input name="minimumPayment" inputMode="decimal" />
                    </Field>
                    <Field label="Promotion end date (optional)">
                      <Input name="promotionEndDate" type="date" />
                    </Field>
                    <Field
                      label="Payment day (optional)"
                      hint="Leave blank when the source date is unknown; Balance Book will not invent statement timing."
                    >
                      <Input name="paymentDay" type="number" min="1" max="31" />
                    </Field>
                    <Field label="Statement close day (optional)">
                      <Input name="statementCloseDay" type="number" min="1" max="31" />
                    </Field>
                  </div>
                </details>
              </>
            )}
            {type === 'card-cycle' && (
              <>
                <div className={styles.grid}>
                  <Field label="Cycle closes">
                    <Input name="date2" type="date" required />
                  </Field>
                  <Field label="Payment due">
                    <Input name="date3" type="date" required />
                  </Field>
                  <Field label="Scheduled or paid on (optional)">
                    <Input name="date4" type="date" />
                  </Field>
                </div>
                <div className={styles.grid}>
                  <Field label="Cycle state">
                    <Select name="cycleState">
                      <option value="future-estimated">Future estimated</option>
                      <option value="open">Open</option>
                      <option value="closed-statement">Closed statement</option>
                      <option value="scheduled-payment">Scheduled payment</option>
                      <option value="paid">Paid</option>
                    </Select>
                  </Field>
                  <Field label="Default estimate">
                    <Input name="amount" defaultValue="0.00" required />
                  </Field>
                  <Field label="Locked statement (optional)">
                    <Input name="lockedAmount" />
                  </Field>
                </div>
              </>
            )}
            {type === 'loan' && (
              <>
                <div className={styles.grid}>
                  <Field label="Annual rate (%)">
                    <Input name="rate" inputMode="decimal" required />
                  </Field>
                  <Field label="Payment">
                    <Input name="paymentAmount" required />
                  </Field>
                  <Field label="Next payment">
                    <Input name="date2" type="date" required />
                  </Field>
                  <Field label="Accrual convention">
                    <Select name="accrualConvention">
                      <option value="actual-365">Actual/365</option>
                      <option value="actual-360">Actual/360</option>
                      <option value="monthly">Monthly approximation</option>
                    </Select>
                  </Field>
                  <Field label="Payment frequency">
                    <Select name="paymentFrequency" defaultValue="monthly">
                      <option value="monthly">Monthly</option>
                      <option value="biweekly">Every two weeks</option>
                    </Select>
                  </Field>
                </div>
                <Checkbox
                  name="includeInCashForecast"
                  defaultChecked
                  label="Include scheduled payments in cash forecast"
                />
                <Checkbox
                  name="economicExclusion"
                  label="Exclude from a second economic-net-worth subtraction"
                />
              </>
            )}
            {type === 'receivable' && (
              <>
                <div className={styles.grid}>
                  <Field label="Certainty">
                    <Select name="certainty">
                      <option value="confirmed">Confirmed</option>
                      <option value="expected">Expected</option>
                      <option value="uncertain">Uncertain</option>
                    </Select>
                  </Field>
                  <Field label="Recurrence">
                    <Select name="recurrenceFrequency" defaultValue="once">
                      <option value="once">One time</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Every two weeks</option>
                      <option value="monthly">Monthly</option>
                    </Select>
                  </Field>
                  <Field label="Amount per future occurrence (optional)">
                    <Input name="recurringAmount" inputMode="decimal" />
                  </Field>
                  <Field label="Recurrence end (optional)">
                    <Input name="recurrenceEndDate" type="date" />
                  </Field>
                </div>
                <Checkbox
                  name="includeInCashForecast"
                  defaultChecked
                  label="Include expected settlements in the cash forecast"
                />
              </>
            )}
            {type === 'asset' && (
              <>
                <Field label="Asset type">
                  <Select name="assetType">
                    <option value="investment">Investment</option>
                    <option value="tangible">Tangible</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Checkbox name="liquidAsset" label="Include in liquidity (uncommon)" />
              </>
            )}
            {type === 'reward-program' && (
              <div className={styles.grid}>
                <Field label="Reward type">
                  <Select name="rewardType">
                    <option value="cash-back">Cash back</option>
                    <option value="points">Points</option>
                  </Select>
                </Field>
                <Field label="Base rate (%)">
                  <Input name="rate" required />
                </Field>
                <Field label="Forecast treatment">
                  <Select name="rewardTreatment">
                    <option value="informational">Informational until redeemed</option>
                    <option value="statement-credit">Statement credit</option>
                    <option value="cash-deposit">Cash deposit</option>
                  </Select>
                </Field>
              </div>
            )}
            <Button appearance="primary" type="submit">
              Save record
            </Button>
          </form>
        </div>
      </details>
      {editing && (
        <Card className={styles.panel}>
          <form className={styles.form} onSubmit={(event) => void saveEdit(event)}>
            <Title2 as="h2">Advanced record editor</Title2>
            <Text>
              Use the guided topic page when possible. This fallback exposes every stored field;
              validation and profile-ownership checks still apply.
            </Text>
            <details>
              <summary>Show advanced structured fields</summary>
              <div className={styles.form}>
                <Field label="Record fields (JSON)">
                  <Textarea
                    aria-label="Record fields JSON"
                    rows={14}
                    value={editingJson}
                    onChange={(_, data) => setEditingJson(data.value)}
                  />
                </Field>
                <div className={styles.actions}>
                  <Button appearance="primary" type="submit">
                    Save changes
                  </Button>
                  <Button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </details>
          </form>
        </Card>
      )}
      <Card className={styles.panel}>
        <div className={styles.recordHeader}>
          <div>
            <Title2 as="h2">All financial entries ({rows.length})</Title2>
            <Text className={styles.muted}>
              Filter the library, then use the advanced editor only when a guided editor is not
              enough. A paycheck split across accounts appears once here; its allocation legs remain
              linked underneath.
            </Text>
          </div>
          <div className={styles.actions}>
            <Field label="Search records">
              <Input
                type="search"
                value={recordSearch}
                onChange={(_, data) => setRecordSearch(data.value)}
                placeholder="Name, date, amount, or type"
              />
            </Field>
            <Field label="Filter records">
              <Select
                aria-label="Filter records"
                value={recordFilter}
                onChange={(_, data) => setRecordFilter(data.value as 'all' | RecordLibraryType)}
              >
                <option value="all">All record types</option>
                <option value="cash-account">Cash accounts</option>
                <option value="forecast-event">Cash events and obligations</option>
                <option value="credit-card">Credit cards</option>
                <option value="card-cycle">Card statement cycles</option>
                <option value="loan">Loans</option>
                <option value="receivable">Receivables</option>
                <option value="asset">Assets</option>
                <option value="reward-program">Rewards</option>
                <option value="reconciliation">Reconciliations</option>
                <option value="saved-scenario">Saved scenarios</option>
              </Select>
            </Field>
          </div>
        </div>
        <div className={styles.rows}>
          {visibleRows.length === 0 && (
            <Text>No records match this search and record-type filter.</Text>
          )}
          {visibleRows.map((row) => {
            const account =
              row.type === 'cash-account'
                ? records.accounts.find((item) => item.id === row.id)
                : undefined;
            const forecastEvent =
              row.type === 'forecast-event'
                ? records.events.find((item) => item.id === row.id)
                : undefined;
            const groupedIncome = groupedIncomeRowIds.has(row.id);
            const supportsGuidedEdit =
              row.type === 'cash-account' || (row.type === 'forecast-event' && !groupedIncome);
            const isGuidedEditing =
              guidedEditing?.entityType === row.type && guidedEditing.entityId === row.id;
            return (
              <div className={styles.stack} key={`${row.type}-${row.id}`}>
                <div className={styles.row}>
                  <div>
                    <strong>{row.title}</strong>
                    <br />
                    <Text>{row.detail}</Text>
                  </div>
                  <div className={styles.actions}>
                    {supportsGuidedEdit && (
                      <Button
                        appearance="primary"
                        aria-label={`Edit ${row.title}`}
                        onClick={() =>
                          startGuidedEditing(row.type as GuidedEditorTarget['entityType'], row.id)
                        }
                      >
                        Edit
                      </Button>
                    )}
                    {groupedIncome ? (
                      <Button onClick={() => navigate('/income')}>Manage paycheck</Button>
                    ) : (
                      <Button
                        aria-label={`Advanced edit ${row.title}`}
                        onClick={() => startEditing(row.request)}
                      >
                        {supportsGuidedEdit ? 'Advanced' : 'Advanced edit'}
                      </Button>
                    )}
                    {!groupedIncome && (
                      <Button
                        aria-label={`Delete ${row.title}`}
                        onClick={() => void remove(row.type, row.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                {isGuidedEditing && account && (
                  <CashAccountGuidedEditor
                    account={account}
                    message={message}
                    error={error}
                    onSubmit={(event) => void saveGuidedEdit(event)}
                    onCancel={closeGuidedEditing}
                  />
                )}
                {isGuidedEditing && forecastEvent && (
                  <ForecastEventGuidedEditor
                    key={forecastEvent.id}
                    event={forecastEvent}
                    accounts={records.accounts}
                    cards={records.cards}
                    cardCycles={records.cardCycles}
                    loans={records.loans}
                    message={message}
                    error={error}
                    onSubmit={(event) => void saveGuidedEdit(event)}
                    onCancel={closeGuidedEditing}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card className={styles.panel} id="workbook-import-review">
        <Title2 as="h2">Workbook import review</Title2>
        {!importReviewLoaded ? (
          <LoadingSkeleton label="Loading workbook import review" variant="inline-form" />
        ) : importReviewError ? (
          <div role="alert" className={styles.error}>
            {importReviewError}
          </div>
        ) : !importReview || importReview.batches.length === 0 ? (
          <Text>No workbook import has been applied to this profile.</Text>
        ) : (
          <>
            <p>
              {importReview.batches.length} import batch(es) · {importReview.fields.length} mapped
              fields
            </p>
            <div className={styles.rows}>
              {importReview.fields.map((field) => {
                const targetRow =
                  rows.find((row) => row.id === field.entityId && row.type === field.entityType) ??
                  logicalIncomeRows.find(
                    (row) =>
                      field.entityType === 'forecast-event' &&
                      row.memberEventIds.includes(field.entityId),
                  );
                const relatedNames = field.relatedRecordIds.map((id) => {
                  const directRow = rows.find((row) => row.id === id);
                  if (directRow) return directRow.title;
                  return (
                    logicalIncomeRows.find((row) => row.memberEventIds.includes(id))?.title ?? id
                  );
                });
                const targetIsGroupedIncome = Boolean(
                  targetRow && groupedIncomeRowIds.has(targetRow.id),
                );
                return (
                  <div
                    className={styles.row}
                    key={`${field.entityId}-${field.field}-${field.sourceRange}`}
                  >
                    <div className={styles.compact}>
                      <strong>
                        {targetRow?.title ?? field.entityType} · {field.field}
                      </strong>
                      <Text>
                        Current value: {formatLineageValue(field.field, field.currentValueJson)} ·
                        imported as {formatLineageValue(field.field, field.importedValueJson)}
                      </Text>
                      <Text className={styles.muted}>
                        Source: {field.sourceSheet}!{field.sourceRange} · {field.transformation} ·{' '}
                        {field.confidence} confidence
                        {field.destinationEdited ? ' · edited after import' : ''}
                      </Text>
                      <Text className={styles.muted}>
                        Imported {new Date(field.importedAt).toLocaleString()} · last changed{' '}
                        {field.lastModifiedAt
                          ? new Date(field.lastModifiedAt).toLocaleString()
                          : 'record no longer present'}
                      </Text>
                      <Text className={styles.muted}>Forecast impact: {field.forecastImpact}</Text>
                      {relatedNames.length > 0 && (
                        <Text className={styles.muted}>
                          Related records: {relatedNames.join(', ')}
                        </Text>
                      )}
                      {field.warning && <Text className={styles.warning}>{field.warning}</Text>}
                    </div>
                    {targetRow && (
                      <Button
                        onClick={() => {
                          if (targetIsGroupedIncome) {
                            navigate('/income');
                          } else if (
                            targetRow.type === 'cash-account' ||
                            targetRow.type === 'forecast-event'
                          ) {
                            startGuidedEditing(targetRow.type, targetRow.id);
                          } else startEditing(targetRow.request);
                        }}
                      >
                        Edit current record
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </>
  );
};

type IncomeType = NonNullable<ForecastEvent['incomeType']>;

const incomeTypeLabels: Record<IncomeType, string> = {
  paycheck: 'Paycheck',
  bonus: 'Bonus',
  commission: 'Commission',
  'self-employment': 'Self-employment',
  'partner-contribution': 'Partner contribution',
  'raise-adjustment': 'Raise adjustment',
  other: 'Other income',
};

type IncomeForecastSnapshot = {
  horizonStart: string;
  horizonEnd: string;
  expectedLowCents: number;
  expectedFloorMarginCents: number;
  expectedEndingCashCents: number;
  conservativeLowCents: number;
  conservativeFloorMarginCents: number;
  conservativeEndingCashCents: number;
};

type IncomeForecastImpact = {
  label: string;
  before: IncomeForecastSnapshot;
  after: IncomeForecastSnapshot;
};

const rollingForecastContext = (
  records: ManagedRecordsDto,
  requestedStartDate: string,
): {
  accounts: ManagedRecordsDto['accounts'];
  startDate: string;
  endDate: string;
} | null => {
  if (!records.policy || records.accounts.length === 0) return null;
  const { accounts, startDate, endDate } = prepareRollingForecastContext({
    accounts: records.accounts,
    events: records.events,
    cards: records.cards,
    cardCycles: records.cardCycles,
    loans: records.loans,
    committedRefinancePlans: records.committedRefinancePlans,
    receivables: records.receivables,
    policy: records.policy,
    requestedStartDate,
  });
  return { accounts, startDate, endDate };
};

const forecastSnapshotForIncome = (
  records: ManagedRecordsDto,
  requestedStartDate: string,
): IncomeForecastSnapshot | null => {
  const context = rollingForecastContext(records, requestedStartDate);
  if (!context || !records.policy) return null;
  const { accounts, startDate, endDate } = context;
  const events = materializeCommittedRefinanceEvents({
    accounts,
    events: records.events,
    cards: records.cards,
    cardCycles: records.cardCycles,
    loans: records.loans,
    plans: records.committedRefinancePlans,
    receivables: records.receivables,
    startDate,
    endDate,
  });
  const bundle = buildForecastBundle({
    accounts,
    events,
    policy: records.policy,
    startDate,
    endDate,
  });
  return {
    horizonStart: startDate,
    horizonEnd: endDate,
    expectedLowCents: bundle.expected.consolidatedTroughCents,
    expectedFloorMarginCents: bundle.expected.hardFloorMarginCents,
    expectedEndingCashCents: bundle.expected.days.at(-1)!.consolidatedCashCents,
    conservativeLowCents: bundle.conservative.consolidatedTroughCents,
    conservativeFloorMarginCents: bundle.conservative.hardFloorMarginCents,
    conservativeEndingCashCents: bundle.conservative.days.at(-1)!.consolidatedCashCents,
  };
};

type IncomeRoutingMode = 'single' | 'routed';

type IncomeAllocationDraft = {
  key: string;
  eventId?: string;
  accountId: string;
  amount: string;
  rule: 'fixed' | 'remainder';
  daysEarly: string;
};

function sortIncomePlanEventsForEditor<
  T extends Pick<
    ForecastEvent,
    'incomeAllocationOrder' | 'incomeAllocationRule' | 'incomeArrivalOffsetDays' | 'accountId'
  >,
>(events: T[]): T[] {
  return [...events].sort((left, right) => {
    const leftOrder = left.incomeAllocationOrder;
    const rightOrder = right.incomeAllocationOrder;
    if (leftOrder !== undefined || rightOrder !== undefined) {
      const orderDifference =
        (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      if (orderDifference !== 0) return orderDifference;
    }
    const remainderDifference =
      Number(left.incomeAllocationRule !== 'remainder') -
      Number(right.incomeAllocationRule !== 'remainder');
    if (remainderDifference !== 0) return remainderDifference;
    return (
      (left.incomeArrivalOffsetDays ?? 0) - (right.incomeArrivalOffsetDays ?? 0) ||
      left.accountId.localeCompare(right.accountId)
    );
  });
}

const incomeAmountText = (amountCents: number): string => (amountCents / 100).toFixed(2);

const safeIncomeCents = (value: string): number => {
  try {
    return value.trim() ? dollarsToCents(value) : 0;
  } catch {
    return 0;
  }
};

const makeIncomeRecurrence = (form: FormData, date: string): ForecastEvent['recurrenceRule'] => {
  const cadence = get(form, 'incomeCadence') as EventRecurrenceChoice;
  switch (cadence) {
    case 'one-time':
      return undefined;
    case 'weekly': {
      const interval = Math.trunc(number(form, 'incomeWeeklyInterval'));
      if (interval < 1 || interval > 52) {
        throw new Error('Weekly income interval must be between 1 and 52 weeks.');
      }
      return { frequency: 'weekly', interval };
    }
    case 'biweekly':
      return { frequency: 'biweekly' };
    case 'monthly': {
      const interval = Math.trunc(number(form, 'incomeMonthlyInterval'));
      if (interval < 1 || interval > 24) {
        throw new Error('Monthly income interval must be between 1 and 24 months.');
      }
      return {
        frequency: 'monthly',
        dayOfMonth: Temporal.PlainDate.from(date).day,
        interval,
      };
    }
    case 'semimonthly': {
      const first = Math.trunc(number(form, 'incomeSemimonthlyDayOne'));
      const second = Math.trunc(number(form, 'incomeSemimonthlyDayTwo'));
      if (first < 1 || first > 31 || second < 1 || second > 31 || first === second) {
        throw new Error('Choose two different semimonthly days between 1 and 31.');
      }
      const rule: NonNullable<ForecastEvent['recurrenceRule']> = {
        frequency: 'semimonthly',
        daysOfMonth: [Math.min(first, second), Math.max(first, second)],
      };
      if (!isRecurrenceOccurrence(date, date, rule)) {
        throw new Error(
          'The next official payday must be one of the two twice-monthly schedule dates.',
        );
      }
      return rule;
    }
  }
};

const makeTransferRecurrence = (
  form: FormData,
  initiationDate: string,
): ForecastEvent['recurrenceRule'] => {
  const cadence = get(form, 'transferCadence') as EventRecurrenceChoice;
  switch (cadence) {
    case 'one-time':
      return undefined;
    case 'weekly': {
      const interval = Math.trunc(number(form, 'transferWeeklyInterval'));
      if (interval < 1 || interval > 52) {
        throw new Error('Transfer interval must be between 1 and 52 weeks.');
      }
      return { frequency: 'weekly', interval };
    }
    case 'biweekly':
      return { frequency: 'biweekly' };
    case 'monthly': {
      const interval = Math.trunc(number(form, 'transferMonthlyInterval'));
      if (interval < 1 || interval > 24) {
        throw new Error('Transfer interval must be between 1 and 24 months.');
      }
      return {
        frequency: 'monthly',
        dayOfMonth: Temporal.PlainDate.from(initiationDate).day,
        interval,
      };
    }
    case 'semimonthly': {
      const first = Math.trunc(number(form, 'transferSemimonthlyDayOne'));
      const second = Math.trunc(number(form, 'transferSemimonthlyDayTwo'));
      if (first < 1 || first > 31 || second < 1 || second > 31 || first === second) {
        throw new Error('Choose two different transfer days between 1 and 31.');
      }
      return {
        frequency: 'semimonthly',
        daysOfMonth: [Math.min(first, second), Math.max(first, second)],
      };
    }
  }
};

const recurringBaseIncome = (event: ForecastEvent): boolean =>
  event.kind === 'income' &&
  event.direction === 'inflow' &&
  event.incomeType !== 'raise-adjustment' &&
  event.recurrenceRule !== undefined &&
  event.recurrenceRule.frequency !== 'once' &&
  event.status !== 'cancelled' &&
  event.status !== 'skipped';

export const IncomePage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [incomeCadence, setIncomeCadence] = useState<EventRecurrenceChoice>('biweekly');
  const [incomeRoutingMode, setIncomeRoutingMode] = useState<IncomeRoutingMode>('single');
  const [incomeLabel, setIncomeLabel] = useState('');
  const [incomeType, setIncomeType] = useState<Exclude<IncomeType, 'raise-adjustment'>>('paycheck');
  const [incomeAmount, setIncomeAmount] = useState('');
  const [incomeNominalDate, setIncomeNominalDate] = useState('');
  const [incomeCertainty, setIncomeCertainty] = useState<ForecastEvent['certainty']>('confirmed');
  const [incomeNotes, setIncomeNotes] = useState('');
  const [incomeEndDate, setIncomeEndDate] = useState('');
  const [incomeWeeklyInterval, setIncomeWeeklyInterval] = useState('1');
  const [incomeMonthlyInterval, setIncomeMonthlyInterval] = useState('1');
  const [incomeSemimonthlyDayOne, setIncomeSemimonthlyDayOne] = useState('1');
  const [incomeSemimonthlyDayTwo, setIncomeSemimonthlyDayTwo] = useState('15');
  const [incomeAccountId, setIncomeAccountId] = useState('');
  const [incomeAllocations, setIncomeAllocations] = useState<IncomeAllocationDraft[]>([]);
  const [editingIncomePlanId, setEditingIncomePlanId] = useState<string | null>(null);
  const [targetIncomeStreamId, setTargetIncomeStreamId] = useState<string | null>(null);
  const [raiseMode, setRaiseMode] = useState<'new-net' | 'additional' | 'percent'>('new-net');
  const [raiseBaseId, setRaiseBaseId] = useState('');
  const [raiseEffectiveDate, setRaiseEffectiveDate] = useState('');
  const [raiseAccountId, setRaiseAccountId] = useState('');
  const [bonusAccountId, setBonusAccountId] = useState('');
  const [editingIncomeId, setEditingIncomeId] = useState<string | null>(null);
  const [forecastStartDate, setForecastStartDate] = useState(
    Temporal.Now.plainDateISO().toString(),
  );
  const [impact, setImpact] = useState<IncomeForecastImpact | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loaded, forecast]) => {
        const currentForecastStart =
          forecast.ok && forecast.value.startDate
            ? forecast.value.startDate
            : Temporal.Now.plainDateISO().toString();
        setForecastStartDate(currentForecastStart);
        setRecords(loaded);
        const firstAccount = loaded.accounts[0];
        const firstAccountId = firstAccount?.id ?? '';
        const firstIncomeDate = firstAccount
          ? compareDates(currentForecastStart, addDays(firstAccount.balanceAsOf, 1)) > 0
            ? currentForecastStart
            : addDays(firstAccount.balanceAsOf, 1)
          : currentForecastStart;
        setIncomeAccountId(firstAccountId);
        setIncomeNominalDate(firstIncomeDate);
        setIncomeAllocations(
          firstAccountId
            ? [
                {
                  key: crypto.randomUUID(),
                  accountId: firstAccountId,
                  amount: '',
                  rule: 'remainder',
                  daysEarly: '0',
                },
              ]
            : [],
        );
        const groupedPlans = summarizeIncomePlans(
          loaded.events.filter((candidate) => candidate.kind === 'income'),
        );
        const groupedStreams = summarizeBaseIncomeStreams(groupedPlans);
        const initialGroupedBase = groupedStreams
          .map((stream) => effectiveIncomePhase(stream, currentForecastStart))
          .find(
            (plan) =>
              recurringBaseIncome(plan.first) &&
              (!plan.first.recurrenceEndDate ||
                plan.first.recurrenceEndDate >= currentForecastStart),
          );
        const initialRaiseBase =
          initialGroupedBase?.first ??
          loaded.events.find(
            (income) =>
              !income.incomePlanId &&
              recurringBaseIncome(income) &&
              (!income.recurrenceEndDate || income.recurrenceEndDate >= currentForecastStart),
          );
        setRaiseBaseId(initialRaiseBase?.id ?? '');
        const defaultRaiseDestination =
          initialGroupedBase?.events.find((item) => item.incomeAllocationRule === 'remainder') ??
          initialGroupedBase?.first ??
          initialRaiseBase;
        setRaiseAccountId(defaultRaiseDestination?.accountId ?? firstAccountId);
        setBonusAccountId(defaultRaiseDestination?.accountId ?? firstAccountId);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading income plan" variant="form" />
    );

  const incomeEvents = records.events
    .filter((event) => event.kind === 'income' && event.direction === 'inflow')
    .sort(
      (left, right) => left.date.localeCompare(right.date) || left.label.localeCompare(right.label),
    );
  const incomePlans = summarizeIncomePlans(incomeEvents);
  const incomeStreams = summarizeBaseIncomeStreams(incomePlans);
  const incomePlanEventIds = new Set(
    incomePlans.flatMap((plan) => plan.events.map((item) => item.id)),
  );
  const relatedIncomeEventIds = new Set(
    incomeStreams.flatMap((stream) =>
      incomeStreamMemberEvents(incomeEvents, incomePlans, stream).map((event) => event.id),
    ),
  );
  const supersededIncomeEventIds = new Set(
    incomePlans.flatMap((plan) =>
      plan.events
        .map((item) => item.sourceRecordId)
        .filter((value): value is string => value !== undefined),
    ),
  );
  const standaloneIncomeEvents = incomeEvents.filter(
    (event) =>
      !incomePlanEventIds.has(event.id) &&
      !relatedIncomeEventIds.has(event.id) &&
      !(event.status === 'cancelled' && supersededIncomeEventIds.has(event.id)),
  );
  const baseIncomeEvents = [
    ...incomeStreams.map((stream) => effectiveIncomePhase(stream, forecastStartDate).first),
    ...standaloneIncomeEvents,
  ].filter(
    (income) =>
      recurringBaseIncome(income) &&
      (!income.recurrenceEndDate || income.recurrenceEndDate >= forecastStartDate),
  );
  const selectedRaiseOption = baseIncomeEvents.find((event) => event.id === raiseBaseId);
  const selectedRaiseOptionPlan = selectedRaiseOption?.incomePlanId
    ? incomePlans.find((plan) => plan.id === selectedRaiseOption.incomePlanId)
    : undefined;
  const selectedRaiseStream = selectedRaiseOptionPlan
    ? incomeStreams.find((stream) => stream.id === selectedRaiseOptionPlan.streamId)
    : undefined;
  const selectedRaisePlan =
    (selectedRaiseStream && raiseEffectiveDate
      ? incomePhaseForDate(selectedRaiseStream, raiseEffectiveDate)
      : undefined) ?? selectedRaiseOptionPlan;
  const selectedRaiseBase = selectedRaisePlan?.first ?? selectedRaiseOption;
  const selectedIncomeAccount =
    records.accounts.find((account) => account.id === incomeAccountId) ?? records.accounts[0];
  const selectedRaiseAccount = records.accounts.find((account) => account.id === raiseAccountId);
  const selectedRaiseAllocation = selectedRaisePlan?.events.find(
    (item) => item.accountId === raiseAccountId,
  );
  const selectedRaiseOffsetDays = selectedRaiseAllocation?.incomeArrivalOffsetDays ?? 0;
  const firstSafeRaiseNominalDate = selectedRaiseAccount
    ? addDays(selectedRaiseAccount.balanceAsOf, 1 - selectedRaiseOffsetDays)
    : forecastStartDate;
  const earliestRaiseDate =
    compareDates(forecastStartDate, firstSafeRaiseNominalDate) > 0
      ? forecastStartDate
      : firstSafeRaiseNominalDate;
  const selectedRaiseNominalStart =
    selectedRaiseBase?.incomeNominalDate ?? selectedRaiseBase?.date ?? earliestRaiseDate;
  const selectedRaiseDefaultDate =
    selectedRaiseBase?.recurrenceRule && selectedRaiseBase.recurrenceRule.frequency !== 'once'
      ? (expandRecurrence({
          startDate: selectedRaiseNominalStart,
          endDate: selectedRaiseBase.recurrenceEndDate ?? addDays(earliestRaiseDate, 730),
          rule: selectedRaiseBase.recurrenceRule,
        }).find((date) => date >= earliestRaiseDate) ?? earliestRaiseDate)
      : earliestRaiseDate;
  const selectedRaiseTotalCents = selectedRaiseStream
    ? effectiveIncomeStreamTotalCents(
        selectedRaiseStream,
        incomePlans,
        raiseEffectiveDate || selectedRaiseDefaultDate,
      )
    : (selectedRaisePlan?.totalCents ?? selectedRaiseBase?.amountCents ?? 0) +
      records.events
        .filter(
          (event) =>
            event.incomeType === 'raise-adjustment' &&
            event.parentIncomeEventId === selectedRaiseBase?.id &&
            event.status !== 'cancelled' &&
            event.status !== 'skipped' &&
            compareDates(event.date, raiseEffectiveDate || selectedRaiseDefaultDate) <= 0,
        )
        .reduce((total, event) => total + event.amountCents, 0);

  const incomeTotalCents = safeIncomeCents(incomeAmount);
  const fixedAllocationCents = incomeAllocations.reduce(
    (sum, allocation) =>
      sum + (allocation.rule === 'fixed' ? safeIncomeCents(allocation.amount) : 0),
    0,
  );
  const remainderAllocationCents = incomeTotalCents - fixedAllocationCents;
  const allocationAmountCents = (allocation: IncomeAllocationDraft): number =>
    allocation.rule === 'remainder' ? remainderAllocationCents : safeIncomeCents(allocation.amount);
  const duplicateAllocationAccount = incomeAllocations.find(
    (allocation, index) =>
      incomeAllocations.findIndex((candidate) => candidate.accountId === allocation.accountId) !==
      index,
  );
  const routingIssue =
    incomeRoutingMode !== 'routed'
      ? null
      : incomeAllocations.length === 0
        ? 'Add at least one destination.'
        : incomeAllocations.filter((allocation) => allocation.rule === 'remainder').length !== 1
          ? 'Choose exactly one account to receive whatever is left.'
          : duplicateAllocationAccount
            ? 'Each destination account can appear only once.'
            : remainderAllocationCents <= 0
              ? 'Fixed deposits must leave a positive amount for the remainder account.'
              : incomeAllocations.some((allocation) => allocationAmountCents(allocation) <= 0)
                ? 'Every deposit allocation must be greater than zero.'
                : null;
  const semimonthlyDays = [
    Math.trunc(Number(incomeSemimonthlyDayOne)),
    Math.trunc(Number(incomeSemimonthlyDayTwo)),
  ] as [number, number];
  const incomeScheduleIssue = (() => {
    if (incomeCadence !== 'semimonthly' || !incomeNominalDate) return null;
    if (
      semimonthlyDays.some((day) => !Number.isInteger(day) || day < 1 || day > 31) ||
      semimonthlyDays[0] === semimonthlyDays[1]
    ) {
      return null;
    }
    try {
      return isRecurrenceOccurrence(incomeNominalDate, incomeNominalDate, {
        frequency: 'semimonthly',
        daysOfMonth: semimonthlyDays,
      })
        ? null
        : 'Next official payday must match one of these twice-monthly dates.';
    } catch {
      return null;
    }
  })();

  const incomeDraftRecurrence = (() => {
    if (!incomeNominalDate) return undefined;
    try {
      switch (incomeCadence) {
        case 'one-time':
          return undefined;
        case 'weekly':
          return {
            frequency: 'weekly' as const,
            interval: Math.trunc(Number(incomeWeeklyInterval)),
          };
        case 'biweekly':
          return { frequency: 'biweekly' as const };
        case 'monthly':
          return {
            frequency: 'monthly' as const,
            dayOfMonth: Temporal.PlainDate.from(incomeNominalDate).day,
            interval: Math.trunc(Number(incomeMonthlyInterval)),
          };
        case 'semimonthly':
          return {
            frequency: 'semimonthly' as const,
            daysOfMonth: [
              Math.trunc(Number(incomeSemimonthlyDayOne)),
              Math.trunc(Number(incomeSemimonthlyDayTwo)),
            ] as [number, number],
          };
      }
    } catch {
      return undefined;
    }
  })();
  const previewNominalDates = (() => {
    if (!incomeNominalDate) return [];
    try {
      return incomeDraftRecurrence
        ? expandRecurrence({
            startDate: incomeNominalDate,
            endDate: addDays(incomeNominalDate, 730),
            rule: incomeDraftRecurrence,
          }).slice(0, 3)
        : [incomeNominalDate];
    } catch {
      return [];
    }
  })();

  const setSavedImpact = (
    label: string,
    beforeRecords: ManagedRecordsDto,
    afterRecords: ManagedRecordsDto,
  ) => {
    const before = forecastSnapshotForIncome(beforeRecords, forecastStartDate);
    const after = forecastSnapshotForIncome(afterRecords, forecastStartDate);
    setImpact(before && after ? { label, before, after } : null);
  };

  const validateCashArrival = (accountId: string, date: string): CashAccount => {
    const account = records.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error('Choose a valid destination cash account.');
    Temporal.PlainDate.from(date);
    if (date <= account.balanceAsOf) {
      throw new Error(
        `The first arrival must be after ${account.balanceAsOf}, the selected account's balance date.`,
      );
    }
    return account;
  };

  const resetIncomeEditor = () => {
    const account = records.accounts[0];
    const nextDate = account
      ? compareDates(forecastStartDate, addDays(account.balanceAsOf, 1)) > 0
        ? forecastStartDate
        : addDays(account.balanceAsOf, 1)
      : forecastStartDate;
    setEditingIncomePlanId(null);
    setTargetIncomeStreamId(null);
    setIncomeRoutingMode('single');
    setIncomeLabel('');
    setIncomeType('paycheck');
    setIncomeAmount('');
    setIncomeNominalDate(nextDate);
    setIncomeCadence('biweekly');
    setIncomeCertainty('confirmed');
    setIncomeNotes('');
    setIncomeEndDate('');
    setIncomeWeeklyInterval('1');
    setIncomeMonthlyInterval('1');
    setIncomeSemimonthlyDayOne('1');
    setIncomeSemimonthlyDayTwo('15');
    setIncomeAccountId(account?.id ?? '');
    setIncomeAllocations(
      account
        ? [
            {
              key: crypto.randomUUID(),
              accountId: account.id,
              amount: '',
              rule: 'remainder',
              daysEarly: '0',
            },
          ]
        : [],
    );
  };

  const updateIncomeAllocation = (
    key: string,
    patch: Partial<Omit<IncomeAllocationDraft, 'key'>>,
  ) => {
    setIncomeAllocations((current) =>
      current.map((allocation) => {
        if (allocation.key === key) return { ...allocation, ...patch };
        if (patch.rule === 'remainder') return { ...allocation, rule: 'fixed' };
        return allocation;
      }),
    );
  };

  const addIncomeAllocation = () => {
    const usedAccounts = new Set(incomeAllocations.map((allocation) => allocation.accountId));
    const nextAccount = records.accounts.find((account) => !usedAccounts.has(account.id));
    if (!nextAccount) {
      setError('Every cash account is already part of this paycheck split.');
      return;
    }
    setError(null);
    setIncomeAllocations((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        accountId: nextAccount.id,
        amount: '',
        rule: 'fixed',
        daysEarly: '0',
      },
    ]);
  };

  const editIncomePlan = (plan: IncomePlanSummary) => {
    const first = plan.first;
    setEditingIncomePlanId(plan.id);
    setTargetIncomeStreamId(plan.streamId);
    setEditingIncomeId(null);
    setIncomeRoutingMode('routed');
    setIncomeLabel(first.label);
    setIncomeType(
      first.incomeType && first.incomeType !== 'raise-adjustment' ? first.incomeType : 'other',
    );
    setIncomeAmount(incomeAmountText(plan.totalCents));
    setIncomeNominalDate(first.incomeNominalDate!);
    setIncomeCertainty(first.certainty);
    setIncomeNotes(first.notes ?? '');
    setIncomeEndDate(first.recurrenceEndDate ?? '');
    const cadence = eventRecurrenceChoice(first);
    setIncomeCadence(cadence);
    if (first.recurrenceRule?.frequency === 'weekly') {
      setIncomeWeeklyInterval(String(first.recurrenceRule.interval));
    }
    if (first.recurrenceRule?.frequency === 'monthly') {
      setIncomeMonthlyInterval(String(first.recurrenceRule.interval));
    }
    if (first.recurrenceRule?.frequency === 'semimonthly') {
      setIncomeSemimonthlyDayOne(String(first.recurrenceRule.daysOfMonth[0]));
      setIncomeSemimonthlyDayTwo(String(first.recurrenceRule.daysOfMonth[1]));
    }
    setIncomeAllocations(
      sortIncomePlanEventsForEditor(plan.events).map((allocation) => ({
        key: allocation.id,
        eventId: allocation.id,
        accountId: allocation.accountId,
        amount: incomeAmountText(allocation.amountCents),
        rule: allocation.incomeAllocationRule!,
        daysEarly: String(Math.max(0, -(allocation.incomeArrivalOffsetDays ?? 0))),
      })),
    );
    document.getElementById('income-plan-editor')?.scrollIntoView({ behavior: 'smooth' });
  };

  const scheduleIncomePhase = (stream: IncomeStreamSummary) => {
    const priorPlan = stream.phases.at(-1)!;
    const first = priorPlan.first;
    if (
      !first.recurrenceRule ||
      first.recurrenceRule.frequency === 'once' ||
      !first.recurrenceEndDate
    ) {
      setError(
        'Set an end date on the latest routing phase first, then schedule its replacement from the next official payday.',
      );
      return;
    }
    const nextPayday = nextIncomePhaseStart(priorPlan);
    if (!nextPayday) {
      setError('Balance Book could not find the next official payday for this routing change.');
      return;
    }
    setError(null);
    setMessage(
      'Routing change started from the base paycheck. Active raises stay linked automatically and will follow the new routing without being counted twice.',
    );
    setEditingIncomePlanId(null);
    setTargetIncomeStreamId(stream.id);
    setEditingIncomeId(null);
    setIncomeRoutingMode('routed');
    setIncomeLabel(first.label);
    setIncomeType(
      first.incomeType && first.incomeType !== 'raise-adjustment' ? first.incomeType : 'other',
    );
    setIncomeAmount(incomeAmountText(priorPlan.totalCents));
    setIncomeNominalDate(nextPayday);
    setIncomeCertainty(first.certainty);
    setIncomeNotes(first.notes ?? '');
    setIncomeEndDate('');
    const cadence = eventRecurrenceChoice(first);
    setIncomeCadence(cadence);
    if (first.recurrenceRule.frequency === 'weekly') {
      setIncomeWeeklyInterval(String(first.recurrenceRule.interval));
    }
    if (first.recurrenceRule.frequency === 'monthly') {
      setIncomeMonthlyInterval(String(first.recurrenceRule.interval));
    }
    if (first.recurrenceRule.frequency === 'semimonthly') {
      setIncomeSemimonthlyDayOne(String(first.recurrenceRule.daysOfMonth[0]));
      setIncomeSemimonthlyDayTwo(String(first.recurrenceRule.daysOfMonth[1]));
    }
    setIncomeAllocations(
      sortIncomePlanEventsForEditor(priorPlan.events).map((allocation) => ({
        key: crypto.randomUUID(),
        accountId: allocation.accountId,
        amount: incomeAmountText(allocation.amountCents),
        rule: allocation.incomeAllocationRule!,
        daysEarly: String(Math.max(0, -(allocation.incomeArrivalOffsetDays ?? 0))),
      })),
    );
    document.getElementById('income-plan-editor')?.scrollIntoView({ behavior: 'smooth' });
  };

  const deleteIncomePlan = async (plan: IncomePlanSummary) => {
    if (
      !window.confirm(
        `Delete ${plan.first.label} and all ${plan.events.length} routed deposit${plan.events.length === 1 ? '' : 's'}?`,
      )
    )
      return;
    setMessage(null);
    setError(null);
    const response = await window.balanceBook.deleteRecord({
      entityType: 'forecast-event',
      entityId: plan.first.id,
      confirmed: true,
    });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setSavedImpact('Deleted income plan', records, response.value);
    setRecords(response.value);
    if (editingIncomePlanId === plan.id || targetIncomeStreamId === plan.streamId) {
      resetIncomeEditor();
    }
    setMessage('Income plan and every routed deposit were deleted together.');
  };

  const addIncome = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setMessage(null);
    setError(null);
    try {
      if (records.accounts.length === 0) {
        throw new Error('Add a cash account before adding income.');
      }
      const date = incomeNominalDate;
      Temporal.PlainDate.from(date);
      const amountCents = safeIncomeCents(incomeAmount);
      if (amountCents <= 0) throw new Error('Net income amount must be greater than zero.');
      const recurrenceRule = makeIncomeRecurrence(form, date);
      const recurrenceEndDate = incomeEndDate || undefined;
      if (recurrenceEndDate && recurrenceEndDate < date) {
        throw new Error('Income end date cannot be before its first official payday.');
      }
      if (!incomeLabel.trim()) throw new Error('Enter a source or label.');

      if (incomeRoutingMode === 'single' && !editingIncomePlanId && !targetIncomeStreamId) {
        validateCashArrival(incomeAccountId, date);
        const request: ForecastEventRequest = {
          entityType: 'forecast-event',
          payload: {
            id: crypto.randomUUID(),
            accountId: incomeAccountId,
            date,
            kind: 'income',
            direction: 'inflow',
            amountCents,
            certainty: incomeCertainty,
            status: 'planned',
            label: incomeLabel.trim(),
            hypothetical: false,
            accepted: false,
            recurrenceRule,
            recurrenceEndDate: recurrenceRule ? recurrenceEndDate : undefined,
            paymentMethod: 'cash-account',
            incomeType,
            notes: incomeNotes.trim() || undefined,
          },
        };
        const response = await window.balanceBook.upsertRecord(request);
        if (!response.ok) throw new Error(response.error);
        setSavedImpact('Income stream', records, response.value);
        setRecords(response.value);
        if (recurrenceRule) setRaiseBaseId(request.payload.id);
        resetIncomeEditor();
        setMessage(
          incomeCertainty === 'confirmed'
            ? 'Income saved and applied to both expected and protected cash projections.'
            : incomeCertainty === 'expected'
              ? 'Income saved in the expected projection. Confirm it to include it in protected cash.'
              : 'Income saved as uncertain and held outside cash projections until its confidence changes.',
        );
        return;
      }

      if (routingIssue) throw new Error(routingIssue);
      const planId = editingIncomePlanId ?? crypto.randomUUID();
      const streamId =
        targetIncomeStreamId ??
        (editingIncomePlanId
          ? (incomePlans.find((plan) => plan.id === editingIncomePlanId)?.streamId ?? planId)
          : planId);
      const planEvents = incomeAllocations.map((allocation, incomeAllocationOrder) => {
        const daysEarly = Math.trunc(Number(allocation.daysEarly));
        if (!Number.isInteger(daysEarly) || daysEarly < 0 || daysEarly > 31) {
          throw new Error('Days early must be a whole number between 0 and 31.');
        }
        const arrivalDate = addDays(date, -daysEarly);
        validateCashArrival(allocation.accountId, arrivalDate);
        return {
          id: allocation.eventId ?? crypto.randomUUID(),
          accountId: allocation.accountId,
          date: arrivalDate,
          kind: 'income' as const,
          direction: 'inflow' as const,
          amountCents: allocationAmountCents(allocation),
          certainty: incomeCertainty,
          status: 'planned' as const,
          label: incomeLabel.trim(),
          hypothetical: false,
          accepted: false,
          recurrenceRule,
          recurrenceEndDate: recurrenceRule ? recurrenceEndDate : undefined,
          paymentMethod: 'cash-account' as const,
          incomeType,
          incomePlanId: planId,
          incomeStreamId: streamId,
          incomePlanTotalCents: amountCents,
          incomeNominalDate: date,
          incomeArrivalOffsetDays: -daysEarly,
          incomeAllocationRule: allocation.rule,
          incomeAllocationOrder,
          notes: incomeNotes.trim() || undefined,
        };
      });
      const response = await window.balanceBook.upsertIncomePlan({
        events: planEvents,
        replacePlanId: editingIncomePlanId ?? undefined,
      });
      if (!response.ok) throw new Error(response.error);
      setSavedImpact(
        incomeType === 'paycheck' ? 'Paycheck routing' : 'Income routing',
        records,
        response.value,
      );
      setRecords(response.value);
      if (recurrenceRule) {
        setRaiseBaseId(sortIncomePlanEvents(planEvents)[0]!.id);
        const defaultDestination =
          planEvents.find((item) => item.incomeAllocationRule === 'remainder') ?? planEvents[0]!;
        setRaiseAccountId(defaultDestination.accountId);
        setBonusAccountId(defaultDestination.accountId);
      }
      resetIncomeEditor();
      setMessage(
        incomeCertainty === 'confirmed'
          ? 'Paycheck routing saved. Each deposit now reaches its own account on its actual arrival date in both projections.'
          : incomeCertainty === 'expected'
            ? 'Paycheck routing saved in the expected projection. Confirm it to include every deposit in protected cash.'
            : 'Paycheck routing saved as uncertain and held outside cash projections until its confidence changes.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Income could not be saved.');
    }
  };

  const addRaise = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setMessage(null);
    setError(null);
    try {
      const selectedBase = baseIncomeEvents.find(
        (candidate) => candidate.id === get(form, 'raiseBaseId'),
      );
      const effectiveDate = get(form, 'raiseEffectiveDate');
      const selectedBasePlan = selectedBase?.incomePlanId
        ? incomePlans.find((plan) => plan.id === selectedBase.incomePlanId)
        : undefined;
      const selectedStream = selectedBasePlan
        ? incomeStreams.find((stream) => stream.id === selectedBasePlan.streamId)
        : undefined;
      const basePlan = selectedStream
        ? incomePhaseForDate(selectedStream, effectiveDate)
        : selectedBasePlan;
      if (selectedStream && !basePlan) {
        throw new Error(
          'No routing phase covers that payday. End the prior phase and schedule the next routing first.',
        );
      }
      const base = basePlan?.first ?? selectedBase;
      if (!base || !base.recurrenceRule || base.recurrenceRule.frequency === 'once') {
        throw new Error('Choose a recurring income stream for this raise.');
      }
      const baseTotalCents = basePlan?.totalCents ?? base.amountCents;
      const effectiveBaseTotalCents = selectedStream
        ? effectiveIncomeStreamTotalCents(selectedStream, incomePlans, effectiveDate)
        : baseTotalCents +
          records.events
            .filter(
              (candidate) =>
                candidate.incomeType === 'raise-adjustment' &&
                candidate.parentIncomeEventId === base.id &&
                candidate.status !== 'cancelled' &&
                candidate.status !== 'skipped' &&
                compareDates(candidate.date, effectiveDate) <= 0,
            )
            .reduce((total, candidate) => total + candidate.amountCents, 0);
      const destinationAccountId = get(form, 'raiseAccountId');
      const destinationAllocation = basePlan?.events.find(
        (allocation) => allocation.accountId === destinationAccountId,
      );
      const arrivalOffsetDays = destinationAllocation?.incomeArrivalOffsetDays ?? 0;
      validateCashArrival(destinationAccountId, addDays(effectiveDate, arrivalOffsetDays));
      if (base.recurrenceEndDate && effectiveDate > base.recurrenceEndDate) {
        throw new Error('The raise cannot begin after the base income stream ends.');
      }
      const isBaseOccurrence = expandRecurrence({
        startDate: base.incomeNominalDate ?? base.date,
        endDate: effectiveDate,
        rule: base.recurrenceRule,
      }).includes(effectiveDate);
      if (!isBaseOccurrence) {
        throw new Error('Choose an official payday from the recurring base-pay schedule.');
      }
      const enteredValue = get(form, 'raiseValue');
      if (!enteredValue || new Decimal(enteredValue).lte(0)) {
        throw new Error('Enter a raise amount or percentage greater than zero.');
      }
      const mode = get(form, 'raiseMode') as typeof raiseMode;
      const adjustmentCents = calculateRaiseAdjustmentCents(
        effectiveBaseTotalCents,
        mode,
        enteredValue,
      );
      if (adjustmentCents <= 0) {
        throw new Error('The new net amount must be higher than the recurring net amount.');
      }
      const raiseCertainty = get(form, 'raiseCertainty') as 'expected' | 'confirmed';
      const bonusAmountText = get(form, 'bonusAmount');
      const bonusDate = get(form, 'bonusDate');
      if (Boolean(bonusAmountText) !== Boolean(bonusDate)) {
        throw new Error('Enter both a bonus amount and date, or leave both blank.');
      }
      const raisePlanId = basePlan ? crypto.randomUUID() : undefined;
      const requests: ForecastEventRequest[] = [
        {
          entityType: 'forecast-event',
          payload: {
            id: crypto.randomUUID(),
            accountId: destinationAccountId,
            date: addDays(effectiveDate, arrivalOffsetDays),
            kind: 'income',
            direction: 'inflow',
            amountCents: adjustmentCents,
            certainty: raiseCertainty,
            status: 'planned',
            label: `${base.label} raise adjustment`,
            hypothetical: false,
            accepted: false,
            recurrenceRule: base.recurrenceRule,
            recurrenceEndDate: base.recurrenceEndDate,
            paymentMethod: 'cash-account',
            incomeType: 'raise-adjustment',
            parentIncomeEventId: basePlan ? undefined : base.id,
            incomePlanId: raisePlanId,
            incomeStreamId: raisePlanId,
            incomePlanTotalCents: basePlan ? adjustmentCents : undefined,
            incomeNominalDate: basePlan ? effectiveDate : undefined,
            incomeArrivalOffsetDays: basePlan ? arrivalOffsetDays : undefined,
            incomeAllocationRule: basePlan ? 'remainder' : undefined,
            parentIncomePlanId: basePlan?.id,
          },
        },
      ];
      if (bonusAmountText && bonusDate) {
        const bonusDestinationAccountId = get(form, 'bonusAccountId');
        validateCashArrival(bonusDestinationAccountId, bonusDate);
        const bonusAmountCents = dollarsToCents(bonusAmountText);
        if (bonusAmountCents <= 0) throw new Error('Bonus amount must be greater than zero.');
        requests.push({
          entityType: 'forecast-event',
          payload: {
            id: crypto.randomUUID(),
            accountId: bonusDestinationAccountId,
            date: bonusDate,
            kind: 'income',
            direction: 'inflow',
            amountCents: bonusAmountCents,
            certainty: get(form, 'bonusCertainty') as 'expected' | 'confirmed',
            status: 'planned',
            label: `${base.label} bonus`,
            hypothetical: false,
            accepted: false,
            paymentMethod: 'cash-account',
            incomeType: 'bonus',
            sourceRecordId: basePlan?.id ?? base.id,
          },
        });
      }

      const response = await window.balanceBook.upsertIncomePlan({
        events: requests.map((request) => request.payload),
      });
      if (!response.ok) throw new Error(response.error);
      const updatedRecords = response.value;
      setSavedImpact('Raise and bonus plan', records, updatedRecords);
      setRecords(updatedRecords);
      formElement.reset();
      setRaiseMode('new-net');
      setRaiseEffectiveDate('');
      setMessage(
        raiseCertainty === 'confirmed'
          ? 'Confirmed higher pay saved and included in the protected projection.'
          : 'Projected higher pay saved in the expected projection only.',
      );
    } catch (caught) {
      void loadRecords().then(setRecords);
      setError(caught instanceof Error ? caught.message : 'Raise plan could not be saved.');
    }
  };

  const saveIncomeEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = incomeEvents.find((candidate) => candidate.id === editingIncomeId);
    if (!current) return;
    setMessage(null);
    setError(null);
    const request = makeForecastEventEditRequest(current, new FormData(event.currentTarget));
    request.payload.kind = 'income';
    request.payload.direction = 'inflow';
    request.payload.incomeType = current.incomeType ?? 'other';
    request.payload.parentIncomeEventId = current.parentIncomeEventId;
    request.payload.paymentMethod = 'cash-account';
    request.payload.cardId = undefined;
    request.payload.cardActivityTreatment = undefined;
    const response = await window.balanceBook.upsertRecord(request);
    if (response.ok) {
      setSavedImpact('Edited income', records, response.value);
      setRecords(response.value);
      setEditingIncomeId(null);
      setMessage('Income changes saved and recalculated through the cash forecast.');
    } else setError(response.error);
  };

  return (
    <>
      <div className={styles.header}>
        <Text className={styles.eyebrow}>Plan</Text>
        <Title1 as="h1">Income and raises</Title1>
        <Text>
          Record the cash that will actually arrive, where it lands, and how certain it is. Raises
          are stored as linked adjustments, so your original pay history stays intact.
        </Text>
      </div>

      {records.accounts.length === 0 ? (
        <Card className={styles.panel}>
          <Title2 as="h2">Start with a cash account</Title2>
          <Text>Income needs a destination balance before it can affect the cash forecast.</Text>
          <Button
            appearance="primary"
            onClick={() => navigate('/records?type=cash-account&mode=add')}
          >
            Add a cash account
          </Button>
        </Card>
      ) : (
        <Card className={styles.panel}>
          <div className={styles.sectionIntro}>
            <Title2 as="h2">
              {editingIncomePlanId
                ? 'Edit paycheck routing'
                : targetIncomeStreamId
                  ? 'Schedule routing change'
                  : 'Add income'}
            </Title2>
            <Text>
              Use net take-home pay or the actual deposit amount. Recurrence creates future cash
              arrivals natively; it does not copy workbook formulas.
            </Text>
          </div>
          <form
            id="income-plan-editor"
            className={styles.form}
            onSubmit={(event) => void addIncome(event)}
          >
            <div className={styles.grid}>
              <Field label="Source or label">
                <Input
                  name="incomeLabel"
                  value={incomeLabel}
                  onChange={(_, data) => setIncomeLabel(data.value)}
                  placeholder="Main paycheck"
                  required
                />
              </Field>
              <Field label="Income type">
                <Select
                  name="incomeType"
                  value={incomeType}
                  onChange={(_, data) =>
                    setIncomeType(data.value as Exclude<IncomeType, 'raise-adjustment'>)
                  }
                  required
                >
                  {(Object.entries(incomeTypeLabels) as [IncomeType, string][])
                    .filter(([value]) => value !== 'raise-adjustment')
                    .map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field
                label={
                  incomeRoutingMode === 'routed' ? 'Total take-home per paycheck' : 'Net amount'
                }
                hint="Enter what reaches your accounts after payroll deductions. Retirement or benefit deductions already reflected here are never subtracted again."
              >
                <Input
                  name="incomeAmount"
                  inputMode="decimal"
                  value={incomeAmount}
                  onChange={(_, data) => setIncomeAmount(data.value)}
                  placeholder="0.00"
                  required
                />
              </Field>
              <Field
                label={
                  incomeRoutingMode === 'routed' ? 'Next official payday' : 'First or next arrival'
                }
                hint={
                  incomeRoutingMode === 'routed'
                    ? 'Set the employer payday. Each account arrival is calculated from this date.'
                    : undefined
                }
              >
                <Input
                  name="incomeDate"
                  aria-label={
                    incomeRoutingMode === 'routed'
                      ? 'Next official payday'
                      : 'First or next arrival'
                  }
                  type="date"
                  value={incomeNominalDate}
                  onChange={(_, data) => setIncomeNominalDate(data.value)}
                  required
                />
              </Field>
              <Field label="Cadence">
                <Select
                  name="incomeCadence"
                  value={incomeCadence}
                  onChange={(_, data) => setIncomeCadence(data.value as EventRecurrenceChoice)}
                >
                  <option value="one-time">One time</option>
                  <option value="weekly">Weekly or custom weeks</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="semimonthly">Twice monthly</option>
                  <option value="monthly">Monthly or custom months</option>
                </Select>
              </Field>
              {incomeCadence === 'weekly' && (
                <Field label="Repeat every (weeks)">
                  <Input
                    name="incomeWeeklyInterval"
                    type="number"
                    min="1"
                    max="52"
                    step="1"
                    value={incomeWeeklyInterval}
                    onChange={(_, data) => setIncomeWeeklyInterval(data.value)}
                    required
                  />
                </Field>
              )}
              {incomeCadence === 'monthly' && (
                <Field label="Repeat every (months)">
                  <Input
                    name="incomeMonthlyInterval"
                    type="number"
                    min="1"
                    max="24"
                    step="1"
                    value={incomeMonthlyInterval}
                    onChange={(_, data) => setIncomeMonthlyInterval(data.value)}
                    required
                  />
                </Field>
              )}
              {incomeCadence === 'semimonthly' && (
                <>
                  <Field
                    label="First day of month"
                    validationState={incomeScheduleIssue ? 'error' : 'none'}
                    validationMessage={incomeScheduleIssue ?? undefined}
                  >
                    <Input
                      name="incomeSemimonthlyDayOne"
                      type="number"
                      min="1"
                      max="31"
                      step="1"
                      value={incomeSemimonthlyDayOne}
                      onChange={(_, data) => setIncomeSemimonthlyDayOne(data.value)}
                      required
                    />
                  </Field>
                  <Field label="Second day of month">
                    <Input
                      name="incomeSemimonthlyDayTwo"
                      type="number"
                      min="1"
                      max="31"
                      step="1"
                      value={incomeSemimonthlyDayTwo}
                      onChange={(_, data) => setIncomeSemimonthlyDayTwo(data.value)}
                      required
                    />
                  </Field>
                </>
              )}
              <Field
                label="Deposit routing"
                hint="Use routed pay when one paycheck is split, any account receives it early, or both."
              >
                <Select
                  aria-label="Deposit routing"
                  value={incomeRoutingMode}
                  onChange={(_, data) => setIncomeRoutingMode(data.value as IncomeRoutingMode)}
                  disabled={Boolean(editingIncomePlanId || targetIncomeStreamId)}
                >
                  <option value="single">One account on this date</option>
                  <option value="routed">Split accounts or early arrival</option>
                </Select>
              </Field>
              {incomeRoutingMode === 'single' && (
                <Field label="Destination account">
                  <Select
                    name="incomeAccountId"
                    value={selectedIncomeAccount?.id ?? ''}
                    onChange={(_, data) => setIncomeAccountId(data.value)}
                    required
                  >
                    {records.accounts.map((account) => (
                      <option value={account.id} key={account.id}>
                        {account.name} (balance dated {account.balanceAsOf})
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field
                label="Certainty"
                hint="Confirmed income protects the conservative plan; expected income appears only in the expected view."
              >
                <Select
                  name="incomeCertainty"
                  value={incomeCertainty}
                  onChange={(_, data) =>
                    setIncomeCertainty(data.value as ForecastEvent['certainty'])
                  }
                  required
                >
                  <option value="confirmed">Confirmed</option>
                  <option value="expected">Expected</option>
                  <option value="uncertain">Uncertain</option>
                </Select>
              </Field>
              <Field label="Notes (optional)">
                <Textarea
                  name="incomeNotes"
                  value={incomeNotes}
                  onChange={(_, data) => setIncomeNotes(data.value)}
                  placeholder="Take-home assumptions, payroll details, or reminders"
                />
              </Field>
              {incomeCadence !== 'one-time' && (
                <Field label="End date (optional)">
                  <Input
                    name="incomeEndDate"
                    type="date"
                    value={incomeEndDate}
                    onChange={(_, data) => setIncomeEndDate(data.value)}
                  />
                </Field>
              )}
            </div>

            {incomeRoutingMode === 'routed' && (
              <div className={styles.formSection}>
                <div className={styles.sectionIntro}>
                  <strong>Where this paycheck lands</strong>
                  <Text className={styles.muted}>
                    Fixed deposits stay fixed when pay changes. One account receives whatever is
                    left. “Days early” uses calendar days and 0 means the official payday. To
                    schedule a later routing change, end the current phase and use Schedule routing
                    change on its income card.
                  </Text>
                </div>
                <div className={styles.allocationRows}>
                  {incomeAllocations.map((allocation, index) => (
                    <div
                      className={styles.allocationRow}
                      key={allocation.key}
                      role="group"
                      aria-label={`Paycheck allocation for ${records.accounts.find((account) => account.id === allocation.accountId)?.name ?? `destination ${index + 1}`}`}
                    >
                      <Field label={`Destination ${index + 1}`}>
                        <Select
                          aria-label={`Paycheck destination ${index + 1}`}
                          value={allocation.accountId}
                          onChange={(_, data) =>
                            updateIncomeAllocation(allocation.key, { accountId: data.value })
                          }
                        >
                          {records.accounts.map((account) => (
                            <option value={account.id} key={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Deposit rule">
                        <Select
                          aria-label={`Deposit rule ${index + 1}`}
                          value={allocation.rule}
                          onChange={(_, data) =>
                            updateIncomeAllocation(allocation.key, {
                              rule: data.value as IncomeAllocationDraft['rule'],
                            })
                          }
                        >
                          <option value="fixed">Fixed amount</option>
                          <option value="remainder">Whatever is left</option>
                        </Select>
                      </Field>
                      <Field
                        label={
                          allocation.rule === 'remainder' ? 'Calculated deposit' : 'Fixed deposit'
                        }
                      >
                        <Input
                          aria-label={`Deposit amount ${index + 1}`}
                          inputMode="decimal"
                          value={
                            allocation.rule === 'remainder'
                              ? incomeAmountText(Math.max(0, remainderAllocationCents))
                              : allocation.amount
                          }
                          onChange={(_, data) =>
                            updateIncomeAllocation(allocation.key, { amount: data.value })
                          }
                          readOnly={allocation.rule === 'remainder'}
                          required
                        />
                      </Field>
                      <Field label="Days early">
                        <Input
                          aria-label={`Days early ${index + 1}`}
                          type="number"
                          min="0"
                          max="31"
                          step="1"
                          value={allocation.daysEarly}
                          onChange={(_, data) =>
                            updateIncomeAllocation(allocation.key, { daysEarly: data.value })
                          }
                          required
                        />
                      </Field>
                      <Button
                        type="button"
                        size="small"
                        disabled={incomeAllocations.length === 1}
                        onClick={() =>
                          setIncomeAllocations((current) =>
                            current.filter((candidate) => candidate.key !== allocation.key),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    onClick={addIncomeAllocation}
                    disabled={incomeAllocations.length >= records.accounts.length}
                  >
                    Add destination
                  </Button>
                  <Text className={routingIssue ? styles.warning : styles.positive}>
                    {routingIssue ??
                      `${formatMoney(fixedAllocationCents)} fixed; ${formatMoney(remainderAllocationCents)} goes to the remainder account; ${formatMoney(incomeTotalCents)} total.`}
                  </Text>
                </div>
                {previewNominalDates.length > 0 &&
                  incomeTotalCents > 0 &&
                  !routingIssue &&
                  !incomeScheduleIssue && (
                    <div className={styles.compact}>
                      <strong>Next deposits</strong>
                      <div className={styles.previewGrid}>
                        {previewNominalDates.map((nominalDate) => (
                          <div className={styles.previewCard} key={nominalDate}>
                            <Text className={styles.eyebrow}>Official payday {nominalDate}</Text>
                            {incomeAllocations.map((allocation) => {
                              const account = records.accounts.find(
                                (candidate) => candidate.id === allocation.accountId,
                              );
                              const daysEarly = Math.max(
                                0,
                                Math.trunc(Number(allocation.daysEarly)),
                              );
                              return (
                                <Text key={allocation.key}>
                                  {account?.name ?? 'Choose an account'} receives{' '}
                                  {formatMoney(allocationAmountCents(allocation))} on{' '}
                                  {addDays(nominalDate, -daysEarly)}
                                  {daysEarly === 0
                                    ? ' (payday)'
                                    : ` (${daysEarly} day${daysEarly === 1 ? '' : 's'} early)`}
                                </Text>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}

            <div className={styles.actions}>
              <Button
                appearance="primary"
                type="submit"
                disabled={Boolean(routingIssue || incomeScheduleIssue)}
              >
                {editingIncomePlanId
                  ? 'Save paycheck plan'
                  : targetIncomeStreamId
                    ? 'Schedule routing change'
                    : 'Save income stream'}
              </Button>
              {(editingIncomePlanId || targetIncomeStreamId) && (
                <Button type="button" onClick={resetIncomeEditor}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Plan a raise and optional bonus</Title2>
          <Text>
            Start from the whole recurring paycheck, not one deposit leg. Balance Book saves only
            the increase and asks exactly where that extra pay and any bonus will arrive.
          </Text>
        </div>
        {baseIncomeEvents.length === 0 ? (
          <Text className={styles.muted}>
            Add at least one recurring income stream above before planning a raise.
          </Text>
        ) : (
          <form className={styles.form} onSubmit={(event) => void addRaise(event)}>
            <div className={styles.grid}>
              <Field label="Recurring base pay">
                <Select
                  name="raiseBaseId"
                  value={raiseBaseId}
                  onChange={(_, data) => {
                    setRaiseBaseId(data.value);
                    setRaiseEffectiveDate('');
                    const nextBase = baseIncomeEvents.find((item) => item.id === data.value);
                    const nextPlan = nextBase?.incomePlanId
                      ? incomePlans.find((plan) => plan.id === nextBase.incomePlanId)
                      : undefined;
                    const nextDestination =
                      nextPlan?.events.find((item) => item.incomeAllocationRule === 'remainder') ??
                      nextPlan?.first ??
                      nextBase;
                    setRaiseAccountId(nextDestination?.accountId ?? '');
                    setBonusAccountId(nextDestination?.accountId ?? '');
                  }}
                  required
                >
                  {baseIncomeEvents.map((income) => (
                    <option value={income.id} key={income.id}>
                      {income.label} -{' '}
                      {formatMoney(
                        income.incomePlanId
                          ? (incomePlans.find((plan) => plan.id === income.incomePlanId)
                              ?.totalCents ?? income.amountCents)
                          : income.amountCents,
                      )}{' '}
                      {incomeCadenceLabel(income)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How are you entering the raise?">
                <Select
                  name="raiseMode"
                  value={raiseMode}
                  onChange={(_, data) =>
                    setRaiseMode(data.value as 'new-net' | 'additional' | 'percent')
                  }
                >
                  <option value="new-net">New total take-home per paycheck</option>
                  <option value="additional">Additional take-home per paycheck</option>
                  <option value="percent">Percentage increase</option>
                </Select>
              </Field>
              <Field
                label={
                  raiseMode === 'new-net'
                    ? 'New total take-home per paycheck'
                    : raiseMode === 'additional'
                      ? 'Additional take-home per paycheck'
                      : 'Increase percentage'
                }
                hint={
                  selectedRaiseBase && raiseMode === 'new-net'
                    ? `Current total take-home is ${formatMoney(selectedRaiseTotalCents)}.`
                    : undefined
                }
              >
                <Input
                  name="raiseValue"
                  aria-label={
                    raiseMode === 'new-net'
                      ? 'New net deposit'
                      : raiseMode === 'additional'
                        ? 'Additional net per deposit'
                        : 'Increase percentage'
                  }
                  inputMode="decimal"
                  required
                />
              </Field>
              <Field label="First official payday with higher pay">
                <Input
                  key={`${selectedRaiseBase?.id ?? ''}:${raiseAccountId}`}
                  name="raiseEffectiveDate"
                  aria-label="First higher-pay arrival"
                  type="date"
                  value={raiseEffectiveDate || selectedRaiseDefaultDate}
                  onChange={(_, data) => setRaiseEffectiveDate(data.value)}
                  required
                />
              </Field>
              <Field
                label="Where does the extra pay land?"
                hint={
                  selectedRaiseAllocation
                    ? `This keeps that account's ${Math.abs(selectedRaiseOffsetDays)}-day-early timing.`
                    : 'An account outside the current split receives the increase on payday.'
                }
              >
                <Select
                  name="raiseAccountId"
                  value={raiseAccountId}
                  onChange={(_, data) => setRaiseAccountId(data.value)}
                  required
                >
                  {records.accounts.map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                      {selectedRaisePlan?.events.some(
                        (item) =>
                          item.accountId === account.id &&
                          item.incomeAllocationRule === 'remainder',
                      )
                        ? ' (current remainder account)'
                        : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Raise status"
                hint="Projected affects the expected view only. Confirmed also funds the protected view."
              >
                <Select name="raiseCertainty" defaultValue="expected" required>
                  <option value="expected">Projected</option>
                  <option value="confirmed">Confirmed</option>
                </Select>
              </Field>
            </div>
            <div className={styles.formSection}>
              <div className={styles.compact}>
                <strong>Optional one-time bonus</strong>
                <Text className={styles.muted}>
                  Leave both amount and date blank when no bonus is part of this change.
                </Text>
              </div>
              <div className={styles.grid}>
                <Field label="Bonus net amount">
                  <Input name="bonusAmount" inputMode="decimal" placeholder="0.00" />
                </Field>
                <Field label="Bonus arrival date">
                  <Input name="bonusDate" type="date" />
                </Field>
                <Field label="Bonus destination">
                  <Select
                    name="bonusAccountId"
                    value={bonusAccountId}
                    onChange={(_, data) => setBonusAccountId(data.value)}
                    required
                  >
                    {records.accounts.map((account) => (
                      <option value={account.id} key={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Bonus status">
                  <Select name="bonusCertainty" defaultValue="expected">
                    <option value="expected">Projected</option>
                    <option value="confirmed">Confirmed</option>
                  </Select>
                </Field>
              </div>
            </div>
            <Button appearance="primary" type="submit">
              Save raise plan
            </Button>
          </form>
        )}
      </Card>

      <GuidedEditorFeedback message={message} error={error} />

      {impact && (
        <Card className={styles.panel}>
          <div className={styles.sectionIntro}>
            <Title2 as="h2">Exact forecast impact: {impact.label}</Title2>
            <Text>
              Before and after use the same native forecast engine and horizon (
              {impact.after.horizonStart} to {impact.after.horizonEnd}).
            </Text>
          </div>
          <div className={styles.metrics}>
            {[
              {
                label: 'Expected future low',
                before: impact.before.expectedLowCents,
                after: impact.after.expectedLowCents,
              },
              {
                label: 'Expected floor margin',
                before: impact.before.expectedFloorMarginCents,
                after: impact.after.expectedFloorMarginCents,
              },
              {
                label: 'Expected cash at horizon',
                before: impact.before.expectedEndingCashCents,
                after: impact.after.expectedEndingCashCents,
              },
              {
                label: 'Protected future low',
                before: impact.before.conservativeLowCents,
                after: impact.after.conservativeLowCents,
              },
              {
                label: 'Protected floor margin',
                before: impact.before.conservativeFloorMarginCents,
                after: impact.after.conservativeFloorMarginCents,
              },
              {
                label: 'Protected cash at horizon',
                before: impact.before.conservativeEndingCashCents,
                after: impact.after.conservativeEndingCashCents,
              },
            ].map((metric) => (
              <Card className={styles.metric} key={metric.label}>
                <Text className={styles.eyebrow}>{metric.label}</Text>
                <Text className={styles.value}>{formatMoney(metric.after)}</Text>
                <Text className={styles.muted}>
                  Before {formatMoney(metric.before)} - change{' '}
                  {formatMoney(metric.after - metric.before)}
                </Text>
              </Card>
            ))}
          </div>
        </Card>
      )}

      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Income records</Title2>
          <Text>
            Routed paychecks stay together as one editable plan, while each account deposit enters
            the daily forecast only on its actual date.
          </Text>
        </div>
        {incomeEvents.length === 0 ? (
          <Text className={styles.muted}>No income records yet.</Text>
        ) : (
          <div className={styles.recordGrid}>
            {incomeStreams.map((stream) => {
              const effectivePlan = effectiveIncomePhase(stream, forecastStartDate);
              const effectiveIncome = effectivePlan.first;
              const linkedRaises = linkedRaisePlansForStream(incomePlans, stream);
              const linkedOneTimeIncome = relatedOneTimeIncomeForStream(incomeEvents, stream);
              const effectiveTotalCents = effectiveIncomeStreamTotalCents(
                stream,
                incomePlans,
                forecastStartDate,
              );
              return (
                <Card className={styles.recordCard} key={stream.id}>
                  <div className={styles.recordHeader}>
                    <div className={styles.compact}>
                      <strong>{effectiveIncome.label}</strong>
                      <Text className={styles.amount}>{formatMoney(effectiveTotalCents)}</Text>
                      <Text className={styles.muted}>
                        One income source · {formatMoney(effectivePlan.totalCents)} base pay
                        {linkedRaises.length > 0
                          ? ` · ${linkedRaises.length} linked raise${linkedRaises.length === 1 ? '' : 's'}`
                          : ''}{' '}
                        · {incomeCadenceLabel(effectiveIncome)} · {stream.phases.length} routing
                        phase
                        {stream.phases.length === 1 ? '' : 's'}
                      </Text>
                    </div>
                    {effectiveIncome.incomeType !== 'raise-adjustment' && (
                      <Button size="small" onClick={() => scheduleIncomePhase(stream)}>
                        Schedule routing change
                      </Button>
                    )}
                  </div>
                  {stream.phases.map((plan, index) => {
                    const income = plan.first;
                    const phaseStart = income.incomeNominalDate ?? income.date;
                    const phaseTiming =
                      stream.phases.length === 1
                        ? 'Routing'
                        : compareDates(phaseStart, forecastStartDate) > 0
                          ? `Scheduled routing from ${phaseStart}`
                          : income.recurrenceEndDate &&
                              compareDates(income.recurrenceEndDate, forecastStartDate) < 0
                            ? `Previous routing from ${phaseStart}`
                            : `Current routing from ${phaseStart}`;
                    const parentPlan = income.parentIncomePlanId
                      ? incomePlans.find((candidate) => candidate.id === income.parentIncomePlanId)
                      : undefined;
                    return (
                      <div className={index === 0 ? styles.compact : styles.divider} key={plan.id}>
                        <div className={styles.recordHeader}>
                          <div className={styles.compact}>
                            <strong>{phaseTiming}</strong>
                            <Text className={styles.muted}>
                              Official payday {phaseStart}
                              {income.recurrenceEndDate
                                ? ` · effective through ${income.recurrenceEndDate}`
                                : ' · continues until changed'}
                            </Text>
                          </div>
                          <div className={styles.actions}>
                            {income.incomeType !== 'raise-adjustment' && (
                              <Button size="small" onClick={() => editIncomePlan(plan)}>
                                Edit paycheck
                              </Button>
                            )}
                            <Button size="small" onClick={() => void deleteIncomePlan(plan)}>
                              {stream.phases.length === 1 ? 'Delete plan' : 'Delete phase'}
                            </Button>
                          </div>
                        </div>
                        <div className={styles.compact}>
                          {plan.events.map((allocation) => {
                            const destination = records.accounts.find(
                              (account) => account.id === allocation.accountId,
                            );
                            const daysEarly = Math.max(
                              0,
                              -(allocation.incomeArrivalOffsetDays ?? 0),
                            );
                            return (
                              <div className={styles.row} key={allocation.id}>
                                <div className={styles.compact}>
                                  <strong>{destination?.name ?? 'Missing account'}</strong>
                                  <Text className={styles.muted}>
                                    {daysEarly === 0
                                      ? 'Arrives on official payday'
                                      : `Arrives ${daysEarly} calendar day${daysEarly === 1 ? '' : 's'} early`}
                                    {' · '}
                                    {allocation.incomeAllocationRule === 'remainder'
                                      ? 'whatever is left'
                                      : 'fixed deposit'}
                                  </Text>
                                </div>
                                <Text className={styles.amount}>
                                  {formatMoney(allocation.amountCents)}
                                </Text>
                              </div>
                            );
                          })}
                        </div>
                        <div className={styles.recordFacts}>
                          <div className={styles.recordFact}>
                            <Text className={styles.muted}>Type</Text>
                            <Text>{incomeTypeLabels[income.incomeType ?? 'other']}</Text>
                          </div>
                          <div className={styles.recordFact}>
                            <Text className={styles.muted}>Certainty</Text>
                            <Text>{income.certainty}</Text>
                          </div>
                          <div className={styles.recordFact}>
                            <Text className={styles.muted}>Phase total</Text>
                            <Text>{formatMoney(plan.totalCents)}</Text>
                          </div>
                          <div className={styles.recordFact}>
                            <Text className={styles.muted}>Destinations</Text>
                            <Text>{plan.events.length}</Text>
                          </div>
                        </div>
                        {parentPlan && (
                          <Text className={styles.muted}>
                            Linked to recurring base: {parentPlan.first.label}
                          </Text>
                        )}
                      </div>
                    );
                  })}
                  {(linkedRaises.length > 0 || linkedOneTimeIncome.length > 0) && (
                    <div className={styles.divider}>
                      <div className={styles.compact}>
                        <strong>Pay changes and one-time income</strong>
                        <Text className={styles.muted}>
                          These belong to this source. Permanent raises continue through later
                          routing phases and keep their own confidence level.
                        </Text>
                      </div>
                      {linkedRaises.map((raisePlan) => (
                        <div className={styles.row} key={raisePlan.id}>
                          <div className={styles.compact}>
                            <strong>{raisePlan.first.label}</strong>
                            <Text className={styles.muted}>
                              Permanent from{' '}
                              {raisePlan.first.incomeNominalDate ?? raisePlan.first.date} ·{' '}
                              {raisePlan.first.certainty} · {raisePlan.first.status}
                            </Text>
                          </div>
                          <div className={styles.actions}>
                            <Text className={styles.amount}>
                              +{formatMoney(raisePlan.totalCents)}
                            </Text>
                            <Button size="small" onClick={() => void deleteIncomePlan(raisePlan)}>
                              Delete raise
                            </Button>
                          </div>
                        </div>
                      ))}
                      {linkedOneTimeIncome.map((income) => (
                        <div className={styles.compact} key={income.id}>
                          <div className={styles.row}>
                            <div className={styles.compact}>
                              <strong>{income.label}</strong>
                              <Text className={styles.muted}>
                                One time on {income.date} · {income.certainty} · {income.status}
                              </Text>
                            </div>
                            <div className={styles.actions}>
                              <Text className={styles.amount}>
                                {formatMoney(income.amountCents)}
                              </Text>
                              <Button
                                size="small"
                                onClick={() =>
                                  setEditingIncomeId((current) =>
                                    current === income.id ? null : income.id,
                                  )
                                }
                              >
                                {editingIncomeId === income.id ? 'Close edit' : 'Edit'}
                              </Button>
                            </div>
                          </div>
                          {editingIncomeId === income.id && (
                            <ForecastEventGuidedEditor
                              event={income}
                              accounts={records.accounts}
                              cards={records.cards}
                              cardCycles={records.cardCycles}
                              loans={records.loans}
                              onSubmit={saveIncomeEdit}
                              onCancel={() => setEditingIncomeId(null)}
                              message={null}
                              error={null}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
            {standaloneIncomeEvents.map((income) => {
              const destination = records.accounts.find(
                (account) => account.id === income.accountId,
              );
              const parent = income.parentIncomeEventId
                ? incomeEvents.find((candidate) => candidate.id === income.parentIncomeEventId)
                : undefined;
              return (
                <Card className={styles.recordCard} key={income.id}>
                  <div className={styles.recordHeader}>
                    <div className={styles.compact}>
                      <strong>{income.label}</strong>
                      <Text className={styles.amount}>{formatMoney(income.amountCents)}</Text>
                    </div>
                    <Button
                      size="small"
                      onClick={() =>
                        setEditingIncomeId((current) => (current === income.id ? null : income.id))
                      }
                    >
                      {editingIncomeId === income.id ? 'Close edit' : 'Edit'}
                    </Button>
                  </div>
                  <div className={styles.recordFacts}>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Type</Text>
                      <Text>{incomeTypeLabels[income.incomeType ?? 'other']}</Text>
                    </div>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Cadence</Text>
                      <Text>{incomeCadenceLabel(income)}</Text>
                    </div>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Certainty</Text>
                      <Text>{income.certainty}</Text>
                    </div>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Status</Text>
                      <Text>{income.status}</Text>
                    </div>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Next arrival</Text>
                      <Text>{income.date}</Text>
                    </div>
                    <div className={styles.recordFact}>
                      <Text className={styles.muted}>Destination</Text>
                      <Text>{destination?.name ?? 'Missing account'}</Text>
                    </div>
                  </div>
                  {parent && (
                    <Text className={styles.muted}>Linked to recurring base: {parent.label}</Text>
                  )}
                  {editingIncomeId === income.id && (
                    <div className={styles.divider}>
                      <ForecastEventGuidedEditor
                        key={income.id}
                        event={income}
                        accounts={records.accounts}
                        cards={records.cards}
                        cardCycles={records.cardCycles}
                        loans={records.loans}
                        onSubmit={saveIncomeEdit}
                        onCancel={() => setEditingIncomeId(null)}
                        message={null}
                        error={null}
                      />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
};

export const BaselinePage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [transferCadence, setTransferCadence] = useState<EventRecurrenceChoice>('one-time');
  const transferInFlightRef = useRef(false);
  const [transferInFlight, setTransferInFlight] = useState(false);
  useEffect(() => {
    void loadRecords()
      .then(setRecords)
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading baseline plan" variant="list" />
    );
  const today = Temporal.Now.plainDateISO().toString();
  const effectiveCardCycles = resolveCardCyclesAsOf({
    cardCycles: records.cardCycles,
    asOfDate: today,
  });
  const baselineIncomePlans = summarizeIncomePlans(records.events);
  const baselineIncomeStreams = summarizeBaseIncomeStreams(baselineIncomePlans);
  const baselineGroupedIncomeEventIds = new Set(
    baselineIncomeStreams.flatMap((stream) =>
      incomeStreamMemberEvents(records.events, baselineIncomePlans, stream).map(
        (event) => event.id,
      ),
    ),
  );
  const cashTimelineItems = [
    ...baselineIncomeStreams.map((stream) => {
      const phase = effectiveIncomePhase(stream, today);
      return {
        kind: 'income-stream' as const,
        id: `income-stream:${stream.id}`,
        sortDate: phase.first.incomeNominalDate ?? phase.first.date,
        stream,
        phase,
      };
    }),
    ...records.events
      .filter((event) => !baselineGroupedIncomeEventIds.has(event.id))
      .map((event) => ({
        kind: 'event' as const,
        id: event.id,
        sortDate: event.date,
        event,
      })),
  ].sort((left, right) => compareDates(left.sortDate, right.sortDate));
  const validPrefillDate = (name: string, fallback: string): string => {
    const value = searchParams.get(name);
    if (!value) return fallback;
    try {
      return Temporal.PlainDate.from(value).toString();
    } catch {
      return fallback;
    }
  };
  const requestedSource = searchParams.get('source');
  const prefilledSourceId = records.accounts.some((account) => account.id === requestedSource)
    ? requestedSource!
    : (records.accounts[0]?.id ?? '');
  const requestedDestination = searchParams.get('destination');
  const fallbackDestination =
    records.accounts.find((account) => account.id !== prefilledSourceId)?.id ??
    records.accounts[0]?.id ??
    '';
  const prefilledDestinationId = records.accounts.some(
    (account) => account.id === requestedDestination && account.id !== prefilledSourceId,
  )
    ? requestedDestination!
    : fallbackDestination;
  const requestedAmountCents = searchParams.get('amountCents') ?? '';
  const prefilledAmount = /^\d+$/.test(requestedAmountCents)
    ? new Decimal(requestedAmountCents).div(100).toFixed(2)
    : '';
  const prefilledInitiation = validPrefillDate('initiation', today);
  const prefilledArrival = validPrefillDate('arrival', prefilledInitiation);
  const transferFormKey = [
    prefilledSourceId,
    prefilledDestinationId,
    prefilledAmount,
    prefilledInitiation,
    prefilledArrival,
  ].join('|');
  const createTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (transferInFlightRef.current) return;
    transferInFlightRef.current = true;
    setTransferInFlight(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setMessage(null);
    setError(null);
    try {
      const initiationDate = get(form, 'initiationDate');
      const recurrenceRule = makeTransferRecurrence(form, initiationDate);
      const recurrenceEndDate = get(form, 'transferRecurrenceEnd') || undefined;
      const response = await window.balanceBook.createInternalTransfer({
        sourceAccountId: get(form, 'sourceAccountId'),
        destinationAccountId: get(form, 'destinationAccountId'),
        amountCents: cents(form, 'amount'),
        initiationDate,
        arrivalDate: get(form, 'arrivalDate'),
        label: get(form, 'label'),
        recurrenceRule,
        recurrenceEndDate: recurrenceRule ? recurrenceEndDate : undefined,
        status: get(form, 'transferStatus') as 'planned' | 'scheduled' | 'confirmed',
        notes: get(form, 'transferNotes') || undefined,
      });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setMessage('Transfer debit and delayed credit created together.');
      formElement.reset();
      setTransferCadence('one-time');
      const remainingParams = new URLSearchParams(searchParams);
      ['source', 'destination', 'amountCents', 'initiation', 'arrival'].forEach((name) => {
        remainingParams.delete(name);
      });
      setSearchParams(remainingParams, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Transfer could not be created.');
    } finally {
      transferInFlightRef.current = false;
      setTransferInFlight(false);
    }
  };
  const saveEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const currentEvent = records.events.find((item) => item.id === editingEventId);
    if (!currentEvent) return;
    setMessage(null);
    setError(null);
    const response = await window.balanceBook.upsertRecord(
      makeForecastEventEditRequest(currentEvent, new FormData(event.currentTarget)),
    );
    if (response.ok) {
      setRecords(response.value);
      setMessage('Cash event updated; card-cycle treatment and forecast timing are now in effect.');
    } else setError(response.error);
  };
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Baseline plan</Title1>
        <Text>
          A rolling cash baseline for income, direct commitments, payables, loans, and card
          settlements—not a category spending limit.
        </Text>
      </div>
      <Card className={styles.panel}>
        <div className={styles.actions}>
          <Button appearance="primary" onClick={() => navigate('/income')}>
            Add income or plan a raise
          </Button>
          <Button onClick={() => navigate('/records?type=forecast-event')}>
            Add or edit other cash events
          </Button>
          <Button onClick={() => navigate('/cards')}>Edit card statements</Button>
          <Button onClick={() => navigate('/loans')}>Edit loan schedules</Button>
        </div>
        {message && (
          <div role="status" className={styles.positive}>
            {message}
          </div>
        )}
        {error && (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        )}
      </Card>
      {records.accounts.length >= 2 && (
        <Card className={styles.panel}>
          <Title2 as="h2">Plan an internal transfer</Title2>
          <Text>
            Transfers move liquidity between accounts and never count as consolidated income or
            expense. Balance Book will not execute the transfer.
          </Text>
          <form
            key={transferFormKey}
            className={styles.form}
            onSubmit={(event) => void createTransfer(event)}
          >
            <div className={styles.grid}>
              <Field label="From account">
                <Select name="sourceAccountId" defaultValue={prefilledSourceId}>
                  {records.accounts.map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To account">
                <Select name="destinationAccountId" defaultValue={prefilledDestinationId}>
                  {[...records.accounts].reverse().map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount">
                <Input name="amount" inputMode="decimal" defaultValue={prefilledAmount} required />
              </Field>
              <Field label="Initiation date">
                <Input
                  name="initiationDate"
                  type="date"
                  defaultValue={prefilledInitiation}
                  required
                />
              </Field>
              <Field label="Arrival date">
                <Input name="arrivalDate" type="date" defaultValue={prefilledArrival} required />
              </Field>
              <Field label="Label">
                <Input name="label" defaultValue="Account transfer" required />
              </Field>
              <Field label="Repeat">
                <Select
                  name="transferCadence"
                  value={transferCadence}
                  onChange={(_, data) => setTransferCadence(data.value as EventRecurrenceChoice)}
                >
                  <option value="one-time">One time</option>
                  <option value="weekly">Weekly or custom weeks</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="semimonthly">Twice monthly</option>
                  <option value="monthly">Monthly or custom months</option>
                </Select>
              </Field>
              {transferCadence === 'weekly' && (
                <Field label="Repeat every (weeks)">
                  <Input
                    name="transferWeeklyInterval"
                    type="number"
                    min="1"
                    max="52"
                    step="1"
                    defaultValue="1"
                    required
                  />
                </Field>
              )}
              {transferCadence === 'monthly' && (
                <Field label="Repeat every (months)">
                  <Input
                    name="transferMonthlyInterval"
                    type="number"
                    min="1"
                    max="24"
                    step="1"
                    defaultValue="1"
                    required
                  />
                </Field>
              )}
              {transferCadence === 'semimonthly' && (
                <>
                  <Field label="First day of month">
                    <Input
                      name="transferSemimonthlyDayOne"
                      type="number"
                      min="1"
                      max="31"
                      step="1"
                      defaultValue="1"
                      required
                    />
                  </Field>
                  <Field label="Second day of month">
                    <Input
                      name="transferSemimonthlyDayTwo"
                      type="number"
                      min="1"
                      max="31"
                      step="1"
                      defaultValue="15"
                      required
                    />
                  </Field>
                </>
              )}
              {transferCadence !== 'one-time' && (
                <Field label="Repeat through (optional)">
                  <Input name="transferRecurrenceEnd" type="date" />
                </Field>
              )}
              <Field label="Status">
                <Select name="transferStatus" defaultValue="planned">
                  <option value="planned">Planned</option>
                  <option value="scheduled">Scheduled with the bank</option>
                  <option value="confirmed">Confirmed</option>
                </Select>
              </Field>
              <Field label="Notes (optional)">
                <Textarea
                  name="transferNotes"
                  placeholder="Purpose, timing assumptions, or reminder"
                />
              </Field>
            </div>
            <Button appearance="primary" type="submit" disabled={transferInFlight}>
              {transferInFlight ? 'Adding transfer…' : 'Add planned transfer'}
            </Button>
          </form>
        </Card>
      )}
      <Card className={styles.panel}>
        <Title2 as="h2">Cash timeline</Title2>
        <Text>
          Each income source appears once. When a paycheck is split, its account deposits are shown
          together and remain one editable routing plan.
        </Text>
        <div className={styles.rows}>
          {cashTimelineItems.map((item) => {
            if (item.kind === 'income-stream') {
              const { stream, phase } = item;
              return (
                <div className={styles.row} key={item.id}>
                  <div className={styles.compact}>
                    <strong>{incomeStreamTitle(stream, phase)}</strong>
                    <Text>
                      One income source ·{' '}
                      {formatMoney(
                        effectiveIncomeStreamTotalCents(stream, baselineIncomePlans, today),
                      )}{' '}
                      current take-home ({formatMoney(phase.totalCents)} base) ·{' '}
                      {incomeCadenceLabel(phase.first)} · {stream.phases.length} routing phase
                      {stream.phases.length === 1 ? '' : 's'}
                    </Text>
                    <Text className={styles.muted}>
                      {incomePhaseTimingLabel(stream, phase, today)}:{' '}
                      {incomePhaseAllocationLabel(phase, records.accounts)}
                    </Text>
                  </div>
                  <Button onClick={() => navigate('/income')}>Manage paycheck</Button>
                </div>
              );
            }
            const { event } = item;
            const treatment = eventFinancialTreatmentLabel(event);
            return (
              <div className={styles.stack} key={event.id}>
                <div className={styles.row}>
                  <div>
                    <strong>{event.label}</strong>
                    <br />
                    <Text>
                      {event.date} · {event.kind} · {event.certainty} · {event.status}
                      {treatment ? ` · ${treatment}` : ''}
                    </Text>
                  </div>
                  <div className={styles.actions}>
                    <Text>
                      {formatMoney(
                        event.direction === 'outflow' ? -event.amountCents : event.amountCents,
                      )}
                    </Text>
                    <Button
                      aria-label={`Edit ${event.label}`}
                      onClick={() => {
                        setEditingEventId(event.id);
                        setMessage(null);
                        setError(null);
                      }}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
                {editingEventId === event.id && (
                  <ForecastEventGuidedEditor
                    key={event.id}
                    event={event}
                    accounts={records.accounts}
                    cards={records.cards}
                    cardCycles={records.cardCycles}
                    loans={records.loans}
                    message={message}
                    error={error}
                    onSubmit={(formEvent) => void saveEvent(formEvent)}
                    onCancel={() => {
                      setEditingEventId(null);
                      setMessage(null);
                      setError(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card className={styles.panel}>
        <Title2 as="h2">Card estimate lifecycle</Title2>
        {effectiveCardCycles.length === 0 ? (
          <Text>No card cycles recorded yet.</Text>
        ) : (
          effectiveCardCycles.map((cycle) => {
            const card = records.cards.find((candidate) => candidate.id === cycle.cardId);
            const projected = card
              ? projectedCycleObligation(card, cycle)
              : cycleDisplayAmount(cycle);
            return (
              <p key={cycle.id}>
                <strong>{cycle.state}</strong> due {cycle.dueOn} · baseline{' '}
                {formatMoney(cycle.defaultEstimateCents)} · entered/locked{' '}
                {formatMoney(cycleDisplayAmount(cycle))} · projected {formatMoney(projected)} ·{' '}
                variance {formatMoney(projected - cycle.defaultEstimateCents)}
              </p>
            );
          })
        )}
      </Card>
    </>
  );
};

export const CardsPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [asOfDate, setAsOfDate] = useState(Temporal.Now.plainDateISO().toString());
  const [editingCardId, setEditingCardId] = useState<string | 'new' | null>(null);
  const [editingCycleId, setEditingCycleId] = useState<string | 'new' | null>(null);
  const [cycleCardId, setCycleCardId] = useState<string | null>(null);
  const [schedulingPaymentCardId, setSchedulingPaymentCardId] = useState<string | null>(null);
  const [editingScheduledPaymentId, setEditingScheduledPaymentId] = useState<string | null>(null);
  const [recordingPaymentCycleId, setRecordingPaymentCycleId] = useState<string | null>(null);
  const [paymentPolicyChoice, setPaymentPolicyChoice] = useState<
    'full-statement' | 'minimum' | 'fixed' | 'manual'
  >('full-statement');
  const [cardStatusChoice, setCardStatusChoice] = useState<'active' | 'closed'>('active');
  const [cycleStateChoice, setCycleStateChoice] = useState<
    'future-estimated' | 'open' | 'closed-statement' | 'scheduled-payment' | 'paid'
  >('open');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardEditorRef = useEditorReveal<HTMLDivElement>(editingCardId);
  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loaded, forecast]) => {
        setRecords(loaded);
        if (forecast.ok) {
          setSnapshot(forecast.value);
          if (forecast.value.startDate) setAsOfDate(forecast.value.startDate);
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading credit cards" variant="list" />
    );

  const editCard =
    editingCardId && editingCardId !== 'new'
      ? records.cards.find((card) => card.id === editingCardId)
      : undefined;
  const editCycle =
    editingCycleId && editingCycleId !== 'new'
      ? records.cardCycles.find((cycle) => cycle.id === editingCycleId)
      : undefined;
  const startCardEdit = (cardId: string | 'new'): void => {
    const card = cardId === 'new' ? undefined : records.cards.find((item) => item.id === cardId);
    setPaymentPolicyChoice(card?.paymentPolicy ?? 'full-statement');
    setCardStatusChoice(card?.status ?? 'active');
    setEditingCardId(cardId);
  };
  const startCycleEdit = (cycleId: string | 'new'): void => {
    const cycle =
      cycleId === 'new' ? undefined : records.cardCycles.find((item) => item.id === cycleId);
    setCycleStateChoice(cycle?.state ?? 'open');
    setEditingCycleId(cycleId);
  };
  const displayedCardCycles = enrichCardCyclesWithActivities({
    cardCycles: resolveCardCyclesAsOf({ cardCycles: records.cardCycles, asOfDate }),
    cardActivities: records.events,
    cards: records.cards,
    asOfDate,
    endDate:
      records.cardCycles
        .map((cycle) => cycle.closesOn)
        .sort()
        .at(-1) ?? Temporal.Now.plainDateISO().toString(),
  });
  const debtByCard = new Map(
    records.cards.map((card) => [
      card.id,
      snapshot?.revolvingDebtByCard?.find((summary) => summary.cardId === card.id) ??
        summarizeRevolvingDebt({
          card,
          cycles: records.cardCycles,
          asOfDate,
          events: records.events,
        }),
    ]),
  );
  const totalCardBalanceCents = [...debtByCard.values()].reduce(
    (total, debt) => total + debt.currentBalanceCents,
    0,
  );
  const totalAmountDueCents = [...debtByCard.values()].reduce(
    (total, debt) => total + debt.amountCurrentlyDueCents,
    0,
  );
  const totalCarryCents = [...debtByCard.values()].reduce(
    (total, debt) => total + debt.carryingBalanceCents,
    0,
  );
  const aggregateUtilization = aggregateKnownLimitCardUtilization(
    records.cards.map((card) => ({
      currentBalanceCents: debtByCard.get(card.id)?.currentBalanceCents ?? 0,
      creditLimitCents: card.creditLimitCents,
    })),
  );
  const totalUtilizationPercent = aggregateUtilization.utilizationPercent ?? 0;

  const refreshCardSnapshot = async (): Promise<void> => {
    const forecast = await window.balanceBook.getForecast();
    if (!forecast.ok) {
      setError(forecast.error);
      return;
    }
    setSnapshot(forecast.value);
    if (forecast.value.startDate) setAsOfDate(forecast.value.startDate);
  };

  const saveCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = editCard
      ? (makeEditRequest('credit-card', editCard).payload as Record<string, unknown>)
      : {};
    const response = await window.balanceBook.upsertRecord({
      entityType: 'credit-card',
      payload: {
        ...existing,
        id: editCard?.id ?? crypto.randomUUID(),
        name: get(form, 'name'),
        issuer: get(form, 'issuer') || undefined,
        lastFour: get(form, 'lastFour') || undefined,
        fundingAccountId: get(form, 'accountId'),
        accountKind: get(form, 'accountKind') || editCard?.accountKind || 'credit-card',
        creditLimitCents: optionalCents(form, 'creditLimit'),
        reportedBalanceCents: optionalCents(form, 'reportedBalance'),
        reportedBalanceDate: get(form, 'reportedBalanceDate') || undefined,
        reportedCarryingBalanceCents: optionalCents(form, 'reportedCarryingBalance'),
        reportedCarryingBalanceDate: get(form, 'reportedCarryingBalanceDate') || undefined,
        defaultFutureStatementCents: cents(form, 'defaultEstimate'),
        estimatePolicy: get(form, 'estimatePolicy'),
        paymentPolicy: get(form, 'paymentPolicy'),
        fixedPaymentCents: optionalCents(form, 'fixedPayment'),
        minimumPaymentCents: optionalCents(form, 'minimumPayment'),
        aprBasisPoints: get(form, 'apr')
          ? new Decimal(get(form, 'apr')).mul(100).toDecimalPlaces(0).toNumber()
          : undefined,
        promotionEndDate: get(form, 'promotionEndDate') || undefined,
        paymentDayOfMonth: optionalInteger(form, 'paymentDay'),
        statementCloseDayOfMonth: optionalInteger(form, 'statementCloseDay'),
        status: get(form, 'cardStatus'),
        closedOn: get(form, 'closedOn') || undefined,
      },
    } as UpsertManagedEntityRequest);
    if (response.ok) {
      setRecords(response.value);
      setEditingCardId(null);
      setMessage(
        editCard ? 'Card terms updated.' : 'Credit card added. Add its current cycle next.',
      );
      setError(null);
      await refreshCardSnapshot();
    } else setError(response.error);
  };

  const saveCycle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await window.balanceBook.upsertRecord({
      entityType: 'card-cycle',
      payload: {
        ...(editCycle ?? {}),
        id: editCycle?.id ?? crypto.randomUUID(),
        cardId: editCycle?.cardId ?? cycleCardId ?? get(form, 'cardId'),
        opensOn: get(form, 'opensOn'),
        closesOn: get(form, 'closesOn'),
        dueOn: get(form, 'dueOn'),
        paymentOn: get(form, 'paymentOn') || undefined,
        state: get(form, 'cycleState'),
        defaultEstimateCents: cents(form, 'defaultEstimate'),
        actualActivityCents: cents(form, 'actualActivity'),
        plannedActivityCents: cents(form, 'plannedActivity'),
        lockedStatementCents: optionalCents(form, 'lockedStatement'),
        projectionOverrideCents: optionalCents(form, 'projectionOverride'),
        actualPaymentCents: optionalCents(form, 'actualPayment'),
      },
    } as UpsertManagedEntityRequest);
    if (response.ok) {
      setRecords(response.value);
      setEditingCycleId(null);
      setCycleCardId(null);
      setMessage(editCycle ? 'Statement cycle updated.' : 'Statement cycle added.');
      setError(null);
      await refreshCardSnapshot();
    } else setError(response.error);
  };

  const scheduleCardPayment = async (event: FormEvent<HTMLFormElement>, card: CreditCard) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const sourceCycleId = get(form, 'sourceCycleId');
    const existingPayment = editingScheduledPaymentId
      ? records.events.find((item) => item.id === editingScheduledPaymentId)
      : undefined;
    if (editingScheduledPaymentId && !existingPayment) {
      setError('That scheduled payment is no longer available. Refresh and try again.');
      return;
    }
    const response = await window.balanceBook.upsertRecord(
      scheduledCardPaymentRequest({
        existing: existingPayment,
        newId: crypto.randomUUID(),
        accountId: get(form, 'accountId'),
        date: get(form, 'date') as PlainDateString,
        amountCents: cents(form, 'amount'),
        label: get(form, 'label') || `${card.name} scheduled payment`,
        sourceCycleId: sourceCycleId || undefined,
        cardId: card.id,
      }),
    );
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRecords(response.value);
    setSchedulingPaymentCardId(null);
    setEditingScheduledPaymentId(null);
    setMessage(
      existingPayment
        ? `${card.name} payment updated. Its revised cash effect is now in the forecast.`
        : `${card.name} payment scheduled. Its dated cash effect is now in the forecast.`,
    );
    setError(null);
    formElement.reset();
    await refreshCardSnapshot();
  };

  const recordStatementPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cycle = records.cardCycles.find((item) => item.id === recordingPaymentCycleId);
    if (!cycle) {
      setError('The statement cycle could not be found.');
      return;
    }
    const response = await window.balanceBook.upsertRecord({
      entityType: 'card-cycle',
      payload: {
        ...cycle,
        state: 'paid',
        paymentOn: get(form, 'paymentOn'),
        actualPaymentCents: cents(form, 'actualPayment'),
      },
    } as UpsertManagedEntityRequest);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRecords(response.value);
    setRecordingPaymentCycleId(null);
    const paidCents = cents(form, 'actualPayment');
    const statementCents = cycle.lockedStatementCents ?? 0;
    setMessage(
      paidCents < statementCents
        ? `Partial payment recorded. ${formatMoney(statementCents - paidCents)} now carries forward.`
        : paidCents > statementCents
          ? `Statement paid with ${formatMoney(paidCents - statementCents)} extra applied to the card balance.`
          : 'Statement marked paid in full.',
    );
    setError(null);
    await refreshCardSnapshot();
  };

  const cancelScheduledCardPayment = async (payment: ForecastEvent): Promise<void> => {
    const response = await window.balanceBook.upsertRecord(
      makeEditRequest('forecast-event', { ...payment, status: 'cancelled' }),
    );
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRecords(response.value);
    if (editingScheduledPaymentId === payment.id) {
      setEditingScheduledPaymentId(null);
      setSchedulingPaymentCardId(null);
    }
    setMessage(`${payment.label} cancelled. Its cash effect was removed from the forecast.`);
    setError(null);
    await refreshCardSnapshot();
  };

  const reactivateCard = async (card: CreditCard): Promise<void> => {
    const request = makeEditRequest('credit-card', card);
    const payload = request.payload as Record<string, unknown>;
    payload.status = 'active';
    payload.closedOn = undefined;
    const response = await window.balanceBook.upsertRecord(request);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRecords(response.value);
    setMessage(`${card.name} reactivated. New purchases and Spending Power are available again.`);
    setError(null);
    await refreshCardSnapshot();
  };

  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Cards and revolving credit</Title1>
        <Text>See what is due, what is being spent now, and what the forecast will pay next.</Text>
      </div>
      <section className={styles.summaryStrip} aria-label="Credit card summary">
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Total card balances</Text>
          <Text className={styles.amount}>{formatMoney(totalCardBalanceCents)}</Text>
          <Text className={styles.muted}>{formatMoney(totalAmountDueCents)} currently due</Text>
        </Card>
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Utilization on known limits</Text>
          <Text className={styles.amount}>{totalUtilizationPercent.toFixed(1)}%</Text>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="Total credit utilization"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(100, totalUtilizationPercent))}
            aria-valuetext={`${totalUtilizationPercent.toFixed(1)}% utilization`}
          >
            <span
              className={styles.progressFill}
              style={{ width: `${Math.min(100, totalUtilizationPercent)}%` }}
            />
          </div>
          <Text className={styles.muted}>
            {aggregateUtilization.creditLimitCents > 0
              ? `${formatMoney(aggregateUtilization.currentBalanceCents)} of ${formatMoney(aggregateUtilization.creditLimitCents)} · ${aggregateUtilization.knownLimitCardCount} of ${aggregateUtilization.totalCardCount} cards`
              : 'Add limits to calculate utilization'}
          </Text>
        </Card>
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Balance carrying</Text>
          <Text className={styles.amount}>{formatMoney(totalCarryCents)}</Text>
          <Text className={totalCarryCents === 0 ? styles.positive : styles.warning}>
            {totalCarryCents === 0 ? 'Paid-in-full behavior' : 'Review partial payments'}
          </Text>
        </Card>
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Active cards</Text>
          <Text className={styles.amount}>
            {records.cards.filter((card) => card.status === 'active').length}
          </Text>
          <Text className={styles.muted}>{records.cards.length} total accounts</Text>
        </Card>
      </section>
      {(message || error) && (
        <Card className={styles.panel}>
          {message && (
            <div role="status" className={styles.positive}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          )}
        </Card>
      )}
      <Card className={styles.panel}>
        <div className={styles.actions}>
          <Button appearance="primary" onClick={() => startCardEdit('new')}>
            Add card or credit line
          </Button>
          <Button onClick={() => navigate('/records?type=credit-card')}>
            Advanced card records
          </Button>
        </div>
      </Card>
      {editingCardId && (
        <Card
          ref={cardEditorRef}
          className={`${styles.panel} balance-editor-reveal`}
          tabIndex={-1}
          aria-labelledby="card-editor-title"
        >
          <form
            key={editCard?.id ?? 'new-card'}
            className={styles.form}
            onSubmit={(event) => void saveCard(event)}
          >
            <div className={styles.sectionIntro}>
              <Title2 id="card-editor-title" as="h2">
                {editCard ? `Edit ${editCard.name}` : 'Add revolving credit'}
              </Title2>
              <Text>
                Card terms define when statement cash leaves the funding account. Maintain the
                individual statement cycles below.
              </Text>
            </div>
            <div className={styles.grid}>
              <Field label="Card name">
                <Input name="name" required defaultValue={editCard?.name} />
              </Field>
              <Field label="Account type">
                <Select name="accountKind" defaultValue={editCard?.accountKind ?? 'credit-card'}>
                  <option value="credit-card">Credit card</option>
                  <option value="charge-card">Charge card</option>
                  <option value="line-of-credit">Line of credit</option>
                </Select>
              </Field>
              <Field
                label="Account lifecycle"
                hint="Closing stops new purchases, future baselines, and Spending Power while preserving statements, debt, and payments."
              >
                <Select
                  name="cardStatus"
                  value={cardStatusChoice}
                  onChange={(event) =>
                    setCardStatusChoice(event.currentTarget.value as 'active' | 'closed')
                  }
                >
                  <option value="active">Active</option>
                  <option value="closed">Closed or retired</option>
                </Select>
              </Field>
              {cardStatusChoice === 'closed' && (
                <Field
                  label="Closed on"
                  hint="The final cycle that opened before this date remains payable. No cycle or purchase opens on this date or later."
                >
                  <Input
                    name="closedOn"
                    type="date"
                    required
                    defaultValue={editCard?.closedOn ?? asOfDate}
                  />
                </Field>
              )}
              <Field label="Issuer (optional)">
                <Input name="issuer" defaultValue={editCard?.issuer ?? ''} />
              </Field>
              <Field label="Last four digits (optional)">
                <Input
                  name="lastFour"
                  inputMode="numeric"
                  minLength={4}
                  maxLength={4}
                  pattern="[0-9]{4}"
                  defaultValue={editCard?.lastFour ?? ''}
                />
              </Field>
              <Field label="Payment account">
                <Select name="accountId" required defaultValue={editCard?.fundingAccountId}>
                  {records.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Typical future statement">
                <Input
                  name="defaultEstimate"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editCard ? (editCard.defaultFutureStatementCents / 100).toFixed(2) : '0.00'
                  }
                />
              </Field>
              <Field label="Open-cycle estimate policy">
                <Select
                  name="estimatePolicy"
                  defaultValue={editCard?.estimatePolicy ?? 'baseline-guardrail'}
                >
                  <option value="baseline-guardrail">Use at least the typical statement</option>
                  <option value="actual-reset">Use entered activity</option>
                </Select>
              </Field>
              <Field label="Payment policy">
                <Select
                  name="paymentPolicy"
                  defaultValue={editCard?.paymentPolicy ?? 'full-statement'}
                  onChange={(event) =>
                    setPaymentPolicyChoice(event.currentTarget.value as typeof paymentPolicyChoice)
                  }
                >
                  <option value="full-statement">Pay full statement</option>
                  <option value="minimum">Pay minimum</option>
                  <option value="fixed">Pay a fixed amount</option>
                  <option value="manual">Enter each payment manually</option>
                </Select>
              </Field>
              <Field
                label="Statement closes on day (optional)"
                hint="Needed for cycle assignment and dated Spending Power runway guidance. Leave blank when the source timing is unknown."
              >
                <Input
                  name="statementCloseDay"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue={
                    editCard?.statementCloseDayOfMonth === undefined
                      ? ''
                      : String(editCard.statementCloseDayOfMonth)
                  }
                />
              </Field>
              <Field
                label="Payment happens on day (optional)"
                hint="Use the day cash normally leaves the funding account. Leave blank rather than estimating."
              >
                <Input
                  name="paymentDay"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue={
                    editCard?.paymentDayOfMonth === undefined
                      ? ''
                      : String(editCard.paymentDayOfMonth)
                  }
                />
              </Field>
              <Field label="APR (optional)">
                <Input
                  name="apr"
                  inputMode="decimal"
                  defaultValue={
                    editCard?.aprBasisPoints === undefined
                      ? ''
                      : (editCard.aprBasisPoints / 100).toFixed(2)
                  }
                />
              </Field>
              <Field
                label="Credit limit (optional)"
                hint="Informational only. Available credit is never treated as cash or Spending Power."
              >
                <Input
                  name="creditLimit"
                  inputMode="decimal"
                  defaultValue={centsInput(editCard?.creditLimitCents)}
                />
              </Field>
              <Field
                label="Issuer-reported current balance (optional)"
                hint="Use the total shown by the issuer today. Statements and open-cycle activity remain visible separately."
              >
                <Input
                  name="reportedBalance"
                  inputMode="decimal"
                  defaultValue={centsInput(editCard?.reportedBalanceCents)}
                />
              </Field>
              <Field label="Current balance as of (required with balance)">
                <Input
                  name="reportedBalanceDate"
                  type="date"
                  defaultValue={editCard?.reportedBalanceDate ?? ''}
                />
              </Field>
              <Field
                label="Issuer-reported carrying balance (optional)"
                hint="Only debt left after a statement payment belongs here. Paid-in-full cards should be zero."
              >
                <Input
                  name="reportedCarryingBalance"
                  inputMode="decimal"
                  defaultValue={centsInput(editCard?.reportedCarryingBalanceCents)}
                />
              </Field>
              <Field label="Carrying balance as of (required with carrying balance)">
                <Input
                  name="reportedCarryingBalanceDate"
                  type="date"
                  defaultValue={editCard?.reportedCarryingBalanceDate ?? ''}
                />
              </Field>
              <Field
                label={
                  paymentPolicyChoice === 'minimum'
                    ? 'Minimum payment'
                    : 'Minimum payment (optional)'
                }
              >
                <Input
                  name="minimumPayment"
                  inputMode="decimal"
                  required={paymentPolicyChoice === 'minimum'}
                  defaultValue={
                    editCard?.minimumPaymentCents === undefined
                      ? ''
                      : (editCard.minimumPaymentCents / 100).toFixed(2)
                  }
                />
              </Field>
              <Field
                label={
                  paymentPolicyChoice === 'fixed' ? 'Fixed payment' : 'Fixed payment (optional)'
                }
              >
                <Input
                  name="fixedPayment"
                  inputMode="decimal"
                  required={paymentPolicyChoice === 'fixed'}
                  defaultValue={
                    editCard?.fixedPaymentCents === undefined
                      ? ''
                      : (editCard.fixedPaymentCents / 100).toFixed(2)
                  }
                />
              </Field>
              <Field label="Promotion ends (optional)">
                <Input
                  name="promotionEndDate"
                  type="date"
                  defaultValue={editCard?.promotionEndDate ?? ''}
                />
              </Field>
            </div>
            <div className={styles.actions}>
              <Button appearance="primary" type="submit">
                Save card
              </Button>
              <Button type="button" onClick={() => setEditingCardId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {editingCycleId && (
        <Card className={styles.panel}>
          <form
            key={editCycle?.id ?? `new-cycle-${cycleCardId ?? 'card'}`}
            className={styles.form}
            onSubmit={(event) => void saveCycle(event)}
          >
            <div className={styles.sectionIntro}>
              <Title2 as="h2">{editCycle ? 'Edit statement cycle' : 'Add statement cycle'}</Title2>
              <Text>
                A closed statement is the amount coming due. An open cycle is current spending and
                must not be added to that already-closed statement.
              </Text>
              <Text className={styles.muted}>
                Card-funded purchases entered in Financial Records are added to this cycle when the
                forecast and Spending Power are calculated. Enter an aggregate here only for
                activity that is not already recorded as individual purchases.
              </Text>
            </div>
            {!editCycle && !cycleCardId && (
              <Field label="Credit card">
                <Select name="cardId" required>
                  {records.cards.map((card) => (
                    <option key={card.id} value={card.id}>
                      {card.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className={styles.grid}>
              <Field label="Cycle opens">
                <Input name="opensOn" type="date" required defaultValue={editCycle?.opensOn} />
              </Field>
              <Field label="Cycle closes">
                <Input name="closesOn" type="date" required defaultValue={editCycle?.closesOn} />
              </Field>
              <Field label="Payment due">
                <Input name="dueOn" type="date" required defaultValue={editCycle?.dueOn} />
              </Field>
              <Field label="Scheduled or paid on (optional)">
                <Input name="paymentOn" type="date" defaultValue={editCycle?.paymentOn ?? ''} />
              </Field>
              <Field label="Cycle status">
                <Select
                  name="cycleState"
                  defaultValue={editCycle?.state ?? 'open'}
                  onChange={(event) =>
                    setCycleStateChoice(event.currentTarget.value as typeof cycleStateChoice)
                  }
                >
                  <option value="open">Open: current spending</option>
                  <option value="closed-statement">Closed: statement coming due</option>
                  <option value="scheduled-payment">Payment scheduled</option>
                  <option value="paid">Paid: statement history</option>
                  <option value="future-estimated">Future estimate</option>
                </Select>
              </Field>
              <Field label="Typical statement estimate">
                <Input
                  name="defaultEstimate"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editCycle ? (editCycle.defaultEstimateCents / 100).toFixed(2) : '0.00'
                  }
                />
              </Field>
              <Field label="Activity posted in this cycle">
                <Input
                  name="actualActivity"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editCycle ? (editCycle.actualActivityCents / 100).toFixed(2) : '0.00'
                  }
                />
              </Field>
              <Field label="Planned activity">
                <Input
                  name="plannedActivity"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editCycle ? (editCycle.plannedActivityCents / 100).toFixed(2) : '0.00'
                  }
                />
              </Field>
              <Field
                label={
                  cycleStateChoice === 'closed-statement' ||
                  cycleStateChoice === 'scheduled-payment' ||
                  cycleStateChoice === 'paid'
                    ? 'Locked statement balance'
                    : 'Locked statement balance (closed cycles)'
                }
              >
                <Input
                  name="lockedStatement"
                  inputMode="decimal"
                  required={
                    cycleStateChoice === 'closed-statement' ||
                    cycleStateChoice === 'scheduled-payment' ||
                    cycleStateChoice === 'paid'
                  }
                  defaultValue={
                    editCycle?.lockedStatementCents === undefined
                      ? ''
                      : (editCycle.lockedStatementCents / 100).toFixed(2)
                  }
                />
              </Field>
              <Field
                label="Projection override (optional)"
                hint="Sets the aggregate cycle projection; linked detailed purchases are added once."
              >
                <Input
                  name="projectionOverride"
                  inputMode="decimal"
                  defaultValue={
                    editCycle?.projectionOverrideCents === undefined
                      ? ''
                      : (editCycle.projectionOverrideCents / 100).toFixed(2)
                  }
                />
              </Field>
              {cycleStateChoice === 'paid' ? (
                <Field
                  label="Actual statement payment (optional)"
                  hint="Leave blank when the full locked statement was paid. Enter the exact amount for a partial payment."
                >
                  <Input
                    name="actualPayment"
                    inputMode="decimal"
                    defaultValue={centsInput(editCycle?.actualPaymentCents)}
                  />
                </Field>
              ) : null}
            </div>
            <div className={styles.actions}>
              <Button appearance="primary" type="submit">
                Save statement cycle
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setEditingCycleId(null);
                  setCycleCardId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {records.cards.length === 0 ? (
        <Card className={styles.panel}>
          <Title2 as="h2">No credit cards yet</Title2>
          <Text>Add a card, then enter the statement coming due and the current open cycle.</Text>
        </Card>
      ) : (
        records.cards.map((card) => {
          const account = records.accounts.find((item) => item.id === card.fundingAccountId);
          const hasCompleteCycleTiming =
            card.paymentDayOfMonth !== undefined && card.statementCloseDayOfMonth !== undefined;
          const cycles = displayedCardCycles
            .filter((cycle) => cycle.cardId === card.id)
            .sort((left, right) => right.closesOn.localeCompare(left.closesOn));
          const reward = records.rewardPrograms.find((item) => item.cardId === card.id);
          const openCycle = cycles.find((cycle) => cycle.state === 'open');
          const openCycleNeedsStatement =
            openCycle !== undefined && compareDates(openCycle.closesOn, asOfDate) < 0;
          const { comingDue, latestStatement } = selectCardStatementSummaryCycles(cycles);
          const staleEstimatedCycle = cycles
            .filter(
              (cycle) =>
                cycle.state === 'future-estimated' && compareDates(cycle.closesOn, asOfDate) < 0,
            )
            .sort((left, right) => right.closesOn.localeCompare(left.closesOn))[0];
          const futureCycle = cycles
            .filter(
              (cycle) =>
                cycle.state === 'future-estimated' && compareDates(cycle.closesOn, asOfDate) >= 0,
            )
            .sort((left, right) => left.opensOn.localeCompare(right.opensOn))[0];
          const history = cycles.filter((cycle) => cycle.state === 'paid');
          const linkedManualPayments = records.events
            .filter(
              (event) =>
                event.cardId === card.id &&
                event.kind === 'card-payment' &&
                event.paymentMethod === 'cash-account' &&
                event.direction === 'outflow' &&
                event.status !== 'cancelled' &&
                event.status !== 'skipped',
            )
            .sort((left, right) => left.date.localeCompare(right.date));
          const debt = debtByCard.get(card.id)!;
          const utilization = card.creditLimitCents
            ? cardUtilizationPresentation(debt.currentBalanceCents, card.creditLimitCents)
            : undefined;
          const editingScheduledPayment = editingScheduledPaymentId
            ? linkedManualPayments.find((payment) => payment.id === editingScheduledPaymentId)
            : undefined;
          return (
            <Card className={styles.panel} key={card.id}>
              <div className={styles.recordHeader}>
                <div className={styles.compact}>
                  <Title2 as="h2">{card.name}</Title2>
                  <Text className={styles.muted}>
                    {card.issuer ? `${card.issuer} · ` : ''}
                    {card.lastFour ? `ending ${card.lastFour} · ` : ''}
                    Paid from {account?.name ?? 'missing funding account'} ·{' '}
                    {card.accountKind.replaceAll('-', ' ')} · Autopay:{' '}
                    {card.paymentPolicy.replaceAll('-', ' ')}
                    {card.aprBasisPoints === undefined
                      ? ''
                      : ` · ${(card.aprBasisPoints / 100).toFixed(2)}% APR`}
                  </Text>
                </div>
                <div className={styles.actions}>
                  <Button onClick={() => startCardEdit(card.id)}>Edit card</Button>
                  {card.status === 'closed' ? (
                    <Button onClick={() => void reactivateCard(card)}>Reactivate</Button>
                  ) : (
                    <Button
                      onClick={() => {
                        startCardEdit(card.id);
                        setCardStatusChoice('closed');
                      }}
                    >
                      Retire card
                    </Button>
                  )}
                  <Button
                    appearance="primary"
                    onClick={() => {
                      setCycleCardId(card.id);
                      startCycleEdit('new');
                    }}
                  >
                    {card.status === 'closed'
                      ? 'Add final or historical statement'
                      : 'Add statement cycle'}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditingScheduledPaymentId(null);
                      setSchedulingPaymentCardId((current) =>
                        current === card.id ? null : card.id,
                      );
                    }}
                  >
                    Schedule payment
                  </Button>
                </div>
              </div>
              {utilization !== undefined && (
                <div className={styles.compact}>
                  <div className={styles.recordHeader}>
                    <Text className={styles.eyebrow}>Utilization</Text>
                    <Text>
                      <strong>{utilization.utilizationPercent.toFixed(1)}%</strong> ·{' '}
                      {formatMoney(debt.currentBalanceCents)} of{' '}
                      {formatMoney(card.creditLimitCents!)}
                    </Text>
                  </div>
                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-label={`${card.name} utilization`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(utilization.barPercent)}
                    aria-valuetext={`${utilization.utilizationPercent.toFixed(1)}% utilization`}
                  >
                    <span
                      className={styles.progressFill}
                      style={{ width: `${utilization.barPercent}%` }}
                    />
                  </div>
                </div>
              )}
              {schedulingPaymentCardId === card.id && (
                <form
                  key={editingScheduledPayment?.id ?? `new-payment:${card.id}`}
                  className={styles.inlineEditor}
                  onSubmit={(event) => void scheduleCardPayment(event, card)}
                >
                  <div className={styles.sectionIntro}>
                    <strong>
                      {editingScheduledPayment
                        ? 'Edit scheduled payment'
                        : 'Schedule a future payment'}
                    </strong>
                    <Text className={styles.muted}>
                      Add as many dated payments as needed. A payment linked to a statement replaces
                      that portion of its forecasted autopay; an unlinked payment is additional.
                    </Text>
                  </div>
                  <div className={styles.grid}>
                    <Field label="Payment date">
                      <Input
                        name="date"
                        type="date"
                        min={asOfDate}
                        defaultValue={editingScheduledPayment?.date}
                        required
                      />
                    </Field>
                    <Field label="Amount">
                      <Input
                        name="amount"
                        inputMode="decimal"
                        defaultValue={centsInput(editingScheduledPayment?.amountCents)}
                        required
                      />
                    </Field>
                    <Field label="Pay from">
                      <Select
                        name="accountId"
                        defaultValue={editingScheduledPayment?.accountId ?? card.fundingAccountId}
                        required
                      >
                        {records.accounts.map((cashAccount) => (
                          <option value={cashAccount.id} key={cashAccount.id}>
                            {cashAccount.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Statement (optional)"
                      hint="Link it when this payment is meant to cover a specific statement."
                    >
                      <Select
                        name="sourceCycleId"
                        defaultValue={editingScheduledPayment?.sourceRecordId ?? ''}
                      >
                        <option value="">Additional or not yet assigned</option>
                        {cycles
                          .filter(
                            (cycle) =>
                              cycle.state !== 'paid' ||
                              cycle.id === editingScheduledPayment?.sourceRecordId,
                          )
                          .sort((left, right) => left.dueOn.localeCompare(right.dueOn))
                          .map((cycle) => (
                            <option value={cycle.id} key={cycle.id}>
                              Due {cycle.dueOn} ·{' '}
                              {formatMoney(
                                cycle.lockedStatementCents ?? projectedCycleObligation(card, cycle),
                              )}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field label="Label (optional)">
                      <Input
                        name="label"
                        defaultValue={
                          editingScheduledPayment?.label ?? `${card.name} scheduled payment`
                        }
                      />
                    </Field>
                  </div>
                  <div className={styles.actions}>
                    <Button type="submit" appearance="primary">
                      {editingScheduledPayment ? 'Save payment changes' : 'Add payment to forecast'}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        setSchedulingPaymentCardId(null);
                        setEditingScheduledPaymentId(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
              {card.status === 'closed' && (
                <div role="status" className={styles.muted}>
                  Retired {card.closedOn}. New purchases, baselines, and Spending Power are off;
                  existing debt, statement history, and payoff cash remain tracked.
                </div>
              )}
              {staleEstimatedCycle && (
                <div role="alert" className={styles.error}>
                  The cycle that closed {staleEstimatedCycle.closesOn} still has only an estimate.
                  Its {formatMoney(projectedCycleObligation(card, staleEstimatedCycle))} baseline
                  remains in the cash forecast until you enter the locked statement; no actual was
                  invented.
                </div>
              )}
              <div className={styles.recordGrid}>
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Latest closed statement</Text>
                  <Text className={styles.amount}>
                    {latestStatement
                      ? latestStatement.lockedStatementCents === undefined
                        ? 'Amount not recorded'
                        : formatMoney(latestStatement.lockedStatementCents)
                      : 'Not entered'}
                  </Text>
                  <Text className={styles.muted}>
                    {latestStatement
                      ? latestStatement.state === 'paid' &&
                        latestStatement.actualPaymentCents !== undefined &&
                        latestStatement.lockedStatementCents !== undefined &&
                        latestStatement.actualPaymentCents < latestStatement.lockedStatementCents
                        ? `Partial payment ${formatMoney(latestStatement.actualPaymentCents)} recorded ${latestStatement.paymentOn ?? latestStatement.dueOn}`
                        : `${latestStatement.state === 'paid' ? 'Paid in full' : 'Due'} ${latestStatement.paymentOn ?? latestStatement.dueOn}`
                      : 'Add the most recently closed statement.'}
                  </Text>
                  {comingDue && (
                    <div className={styles.actions}>
                      <Button onClick={() => setRecordingPaymentCycleId(comingDue.id)}>
                        Mark statement paid
                      </Button>
                      <Button onClick={() => startCycleEdit(comingDue.id)}>Edit statement</Button>
                    </div>
                  )}
                </Card>
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Amount currently due</Text>
                  <Text className={styles.amount}>{formatMoney(debt.amountCurrentlyDueCents)}</Text>
                  <Text className={styles.muted}>
                    {debt.overdue
                      ? 'Past its recorded due date; review the payment status.'
                      : debt.amountCurrentlyDueCents > 0
                        ? 'Statement debt that has not yet been recorded as paid.'
                        : 'No statement amount currently due.'}
                  </Text>
                </Card>
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Current cycle spending recorded</Text>
                  <Text className={styles.amount}>
                    {openCycle ? formatMoney(openCycle.actualActivityCents) : 'Not entered'}
                  </Text>
                  <Text className={styles.muted}>
                    {openCycle
                      ? `${formatMoney(openCycle.plannedActivityCents)} additional planned or detailed · ${openCycleNeedsStatement ? `closed ${openCycle.closesOn}; enter the locked statement` : `closes ${openCycle.closesOn}`}`
                      : 'Add the cycle that is still open.'}
                  </Text>
                  {openCycleNeedsStatement && (
                    <Text className={styles.error}>
                      This cycle is past its close date but has no locked statement yet. Its entered
                      activity remains visible; no statement amount was invented.
                    </Text>
                  )}
                  {openCycle && (
                    <Button onClick={() => startCycleEdit(openCycle.id)}>
                      Update current spending
                    </Button>
                  )}
                </Card>
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Total current balance</Text>
                  <Text className={styles.amount}>{formatMoney(debt.currentBalanceCents)}</Text>
                  <Text className={styles.muted}>
                    {debt.source === 'reported'
                      ? `Issuer-reported${card.reportedBalanceDate ? ` as of ${card.reportedBalanceDate}` : ''}.`
                      : 'Derived from the unpaid statement plus posted open-cycle activity.'}
                  </Text>
                  {debt.reportedBalanceHasUnresolvedSameCycleActivity && (
                    <Text className={styles.warning}>
                      Refresh the issuer balance: this dated snapshot overlaps an undated aggregate
                      cycle total, so only later dated purchases can be rolled forward exactly.
                    </Text>
                  )}
                </Card>
                {debt.availableCreditCents !== undefined && (
                  <Card className={styles.recordCard}>
                    <Text className={styles.eyebrow}>Available credit</Text>
                    <Text className={styles.amount}>{formatMoney(debt.availableCreditCents)}</Text>
                    <Text className={styles.muted}>
                      Issuer capacity after the current balance. This is not cash and does not
                      increase safe-to-spend.
                    </Text>
                  </Card>
                )}
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Balance carrying</Text>
                  <Text className={styles.amount}>{formatMoney(debt.carryingBalanceCents)}</Text>
                  <Text className={debt.carryingBalanceCents > 0 ? styles.error : styles.positive}>
                    {debt.carryingBalanceCents === 0
                      ? 'Paid in full — statement history remains visible.'
                      : 'Unpaid past a due date or explicitly reported as carried.'}
                  </Text>
                  {debt.projectedCarryingBalanceCents !== debt.carryingBalanceCents && (
                    <Text className={styles.muted}>
                      Projected after the next payment:{' '}
                      {formatMoney(debt.projectedCarryingBalanceCents)}
                    </Text>
                  )}
                </Card>
                <Card className={styles.recordCard}>
                  <Text className={styles.eyebrow}>Next modeled statement</Text>
                  <Text className={styles.amount}>
                    {!futureCycle && !hasCompleteCycleTiming
                      ? 'Timing incomplete'
                      : formatMoney(
                          futureCycle
                            ? projectedCycleObligation(card, futureCycle)
                            : card.defaultFutureStatementCents,
                        )}
                  </Text>
                  <Text className={styles.muted}>
                    {futureCycle
                      ? `Due ${futureCycle.dueOn}`
                      : hasCompleteCycleTiming
                        ? `Uses ${card.estimatePolicy.replaceAll('-', ' ')} until a cycle is entered.`
                        : 'No dates were inferred. Add the real close and payment timing when known.'}
                  </Text>
                  {futureCycle && (
                    <Button onClick={() => startCycleEdit(futureCycle.id)}>Edit estimate</Button>
                  )}
                </Card>
              </div>
              {recordingPaymentCycleId &&
                cycles.some((cycle) => cycle.id === recordingPaymentCycleId) &&
                (() => {
                  const paymentCycle = cycles.find(
                    (cycle) => cycle.id === recordingPaymentCycleId,
                  )!;
                  return (
                    <form className={styles.inlineEditor} onSubmit={recordStatementPayment}>
                      <div className={styles.sectionIntro}>
                        <strong>Record statement payment</strong>
                        <Text className={styles.muted}>
                          Forecasts continue to assume the configured autopay until you record what
                          actually happened. Paying less than the statement creates card carry.
                        </Text>
                      </div>
                      <div className={styles.grid}>
                        <Field label="Paid on">
                          <Input
                            name="paymentOn"
                            type="date"
                            min={paymentCycle.closesOn}
                            max={asOfDate}
                            defaultValue={asOfDate}
                            required
                          />
                        </Field>
                        <Field label="Amount paid">
                          <Input
                            name="actualPayment"
                            inputMode="decimal"
                            defaultValue={centsInput(paymentCycle.lockedStatementCents)}
                            required
                          />
                        </Field>
                      </div>
                      <div className={styles.actions}>
                        <Button type="submit" appearance="primary">
                          Mark statement paid
                        </Button>
                        <Button type="button" onClick={() => setRecordingPaymentCycleId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  );
                })()}
              {linkedManualPayments.length > 0 && (
                <div className={styles.divider}>
                  <div className={styles.sectionIntro}>
                    <strong>Manual payment schedule</strong>
                    <Text className={styles.muted}>
                      These are dated cash records linked to this card. They are not treated as
                      statement balances or added again by the card-cycle engine.
                    </Text>
                  </div>
                  <div className={styles.rows}>
                    {linkedManualPayments.map((payment) => (
                      <div className={styles.row} key={payment.id}>
                        <div>
                          <strong>{payment.label}</strong>
                          <br />
                          <Text>
                            {payment.date} · {payment.status}
                          </Text>
                        </div>
                        <div className={styles.actions}>
                          <Text>{formatMoney(payment.amountCents)}</Text>
                          {payment.status !== 'paid' &&
                            compareDates(payment.date, asOfDate) >= 0 && (
                              <>
                                <Button
                                  type="button"
                                  onClick={() => {
                                    setEditingScheduledPaymentId(payment.id);
                                    setSchedulingPaymentCardId(card.id);
                                    setMessage(null);
                                    setError(null);
                                  }}
                                >
                                  Edit payment
                                </Button>
                                <Button
                                  type="button"
                                  onClick={() => void cancelScheduledCardPayment(payment)}
                                >
                                  Cancel payment
                                </Button>
                              </>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <details className={styles.divider}>
                <summary>Older statement history ({history.length})</summary>
                {history.length === 0 ? (
                  <p>
                    <Text>No paid statements have been recorded.</Text>
                  </p>
                ) : (
                  <div className={styles.rows}>
                    {history.map((cycle) => (
                      <div className={styles.row} key={cycle.id}>
                        <div>
                          <strong>{cycle.closesOn}</strong>
                          <br />
                          <Text>
                            Paid {cycle.paymentOn ?? cycle.dueOn} · due {cycle.dueOn}
                          </Text>
                        </div>
                        <div className={styles.actions}>
                          <Text>
                            {cycle.lockedStatementCents === undefined
                              ? 'Amount not recorded'
                              : formatMoney(cycle.lockedStatementCents)}
                          </Text>
                          <Button onClick={() => startCycleEdit(cycle.id)}>Edit</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </details>
              {reward && (
                <Text className={styles.muted}>
                  Rewards tracked separately: {(reward.baseRateBasisPoints / 100).toFixed(2)}%{' '}
                  {reward.rewardType} · {reward.treatment}
                </Text>
              )}
            </Card>
          );
        })
      )}
    </>
  );
};

export const LoansPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [asOfDate, setAsOfDate] = useState(Temporal.Now.plainDateISO().toString());
  const [editingLoanId, setEditingLoanId] = useState<string | 'new' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loanEditorRef = useEditorReveal<HTMLDivElement>(editingLoanId);
  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loaded, forecast]) => {
        if (!forecast.ok) throw new Error(forecast.error);
        if (!forecast.value.startDate) {
          throw new Error('The forecast did not provide a financial as-of date');
        }
        setAsOfDate(forecast.value.startDate);
        setRecords(loaded);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading loans" variant="list" />
    );
  const today = asOfDate;
  const editingLoan =
    editingLoanId && editingLoanId !== 'new'
      ? records.loans.find((loan) => loan.id === editingLoanId)
      : undefined;
  const committedRefinancePlans = records.committedRefinancePlans.filter(
    (plan) => plan.status === 'committed',
  );
  const originPlanByLoanId = new Map(
    committedRefinancePlans.map((plan) => [plan.replacementLoan.id, plan] as const),
  );
  const retirementPlanByLoanId = new Map(
    committedRefinancePlans.flatMap((plan) =>
      plan.payoffs.map((payoff) => [payoff.sourceLoanId, plan] as const),
    ),
  );
  const cancelledReplacementIds = new Set(
    records.committedRefinancePlans
      .filter((plan) => plan.status === 'cancelled')
      .map((plan) => plan.replacementLoan.id),
  );
  const refinanceCandidateIds = new Set(
    refinanceLoanCandidates({
      loans: records.loans,
      plans: records.committedRefinancePlans,
      loanPaymentEvents: records.events,
      asOfDate: today,
    }).map((candidate) => candidate.loan.id),
  );
  const effectiveLoanById = new Map(
    activeLoansForDate({
      accounts: records.accounts,
      loans: records.loans,
      plans: records.committedRefinancePlans,
      loanPaymentEvents: records.events,
      date: today,
    }).map((loan) => [loan.id, loan] as const),
  );
  const effectiveLoanIds = new Set(effectiveLoanById.keys());
  const activeLoanSummaries = records.loans
    .filter((loan) => effectiveLoanIds.has(loan.id))
    .map((loan) =>
      effectiveLoanPageMetrics(loan, effectiveLoanById.get(loan.id), today, records.events),
    );
  const activeLoanBalanceCents = activeLoanSummaries.reduce(
    (total, summary) => total + summary.modeled.totalCents,
    0,
  );
  const activeLoanPaymentsCents = activeLoanSummaries.reduce(
    (total, summary) => total + summary.recordedPaymentCents,
    0,
  );
  const editingLoanIsRefinanceManaged = Boolean(
    editingLoan &&
    (originPlanByLoanId.has(editingLoan.id) || retirementPlanByLoanId.has(editingLoan.id)),
  );
  const editingInferredFields = new Set<LoanInferredField>(editingLoan?.inferredFields ?? []);
  const editableLoanDefault = (field: LoanInferredField, formattedValue: string): string =>
    editingInferredFields.has(field) ? '' : formattedValue;
  const calculatedLoanPlaceholder = (
    field: LoanInferredField,
    formattedValue: string,
  ): string | undefined =>
    editingInferredFields.has(field) && formattedValue
      ? `Calculated: ${formattedValue}`
      : undefined;
  const saveLoan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const recalculateInferredFields = form.get('recalculateInferredFields') === 'on';
    const preservedCalculatedFields = new Set<LoanInferredField>();
    const resolveField = <T,>(
      field: LoanInferredField,
      submitted: T | undefined,
      stored: T | undefined,
    ): T | undefined => {
      const resolution = resolveLoanEditField({
        field,
        submitted,
        stored,
        inferredFields: editingInferredFields,
        recalculate: recalculateInferredFields,
      });
      if (resolution.preservedCalculatedValue) preservedCalculatedFields.add(field);
      return resolution.value;
    };
    const setup = solveInstallmentLoanSetup({
      asOfDate: today,
      principalCents: resolveField(
        'principalCents',
        optionalCents(form, 'principal'),
        editingLoan?.principalCents,
      ),
      balanceDate: resolveField(
        'balanceDate',
        get(form, 'balanceDate') || undefined,
        editingLoan?.balanceDate,
      ),
      accruedInterestCents: resolveField(
        'accruedInterestCents',
        optionalCents(form, 'accruedInterest'),
        editingLoan?.accruedInterestCents,
      ),
      annualRateBasisPoints: resolveField(
        'annualRateBasisPoints',
        optionalBasisPoints(form, 'rate'),
        editingLoan?.annualRateBasisPoints,
      ),
      accrualConvention: resolveField(
        'accrualConvention',
        (get(form, 'accrualConvention') as Loan['accrualConvention']) || undefined,
        editingLoan?.accrualConvention,
      ),
      paymentCents: resolveField(
        'paymentCents',
        optionalCents(form, 'payment'),
        editingLoan?.paymentCents,
      ),
      cashPaymentCents: resolveField(
        'cashPaymentCents',
        optionalCents(form, 'cashPayment'),
        editingLoan?.cashPaymentCents,
      ),
      nextPaymentDate: resolveField(
        'nextPaymentDate',
        get(form, 'nextPaymentDate') || undefined,
        editingLoan?.nextPaymentDate,
      ),
      maturityDate: resolveField(
        'maturityDate',
        get(form, 'maturityDate') || undefined,
        editingLoan?.maturityDate,
      ),
      originalPrincipalCents: resolveField(
        'originalPrincipalCents',
        optionalCents(form, 'originalPrincipal'),
        editingLoan?.originalPrincipalCents,
      ),
      originalDate: resolveField(
        'originalDate',
        get(form, 'originalDate') || undefined,
        editingLoan?.originalDate,
      ),
      originalTermMonths: resolveField(
        'originalTermMonths',
        optionalInteger(form, 'originalTermMonths'),
        editingLoan?.originalTermMonths,
      ),
      amortizationStructure:
        (get(form, 'amortizationStructure') as Loan['amortizationStructure']) || 'fully-amortizing',
      expectedBalloonCents: resolveField(
        'expectedBalloonCents',
        optionalCents(form, 'expectedBalloon'),
        editingLoan?.expectedBalloonCents,
      ),
      paymentFrequency: resolveField(
        'paymentFrequency',
        (get(form, 'paymentFrequency') as 'monthly' | 'biweekly') || undefined,
        editingLoan?.paymentFrequency,
      ),
    });
    if (setup.status === 'incomplete') {
      const easiest = setup.missingAlternatives[0];
      setError(
        easiest
          ? `${easiest.label}: add ${easiest.missingFields.map(loanSetupFieldLabel).join(', ')}.`
          : 'Add enough loan facts to calculate a current balance, APR, payment, and schedule.',
      );
      return;
    }
    if (setup.status === 'inconsistent') {
      setError(
        [
          ...(preservedCalculatedFields.size > 0
            ? [
                'These edits conflict with previously calculated values. Replace the conflicting values or choose Recalculate calculated fields.',
              ]
            : []),
          ...setup.diagnostics.inputErrors,
          ...setup.diagnostics.contradictions,
          ...setup.diagnostics.reconciliations
            .filter((check) => check.outcome === 'conflict')
            .map((check) => check.message),
        ]
          .filter((message, index, messages) => messages.indexOf(message) === index)
          .join(' ') || 'The entered loan facts do not describe one consistent installment loan.',
      );
      return;
    }
    const resolved = setup.resolved;
    if (
      resolved.principalCents === undefined ||
      resolved.annualRateBasisPoints === undefined ||
      resolved.paymentCents === undefined ||
      resolved.nextPaymentDate === undefined
    ) {
      setError('The loan schedule could not be resolved safely. Add another lender-provided fact.');
      return;
    }
    const inferredFields = new Set([...setup.inferredFields, ...preservedCalculatedFields]);
    const existing = editingLoan
      ? (makeEditRequest('loan', editingLoan).payload as Record<string, unknown>)
      : {};
    const response = await window.balanceBook.upsertRecord({
      entityType: 'loan',
      payload: {
        ...existing,
        id: editingLoan?.id ?? crypto.randomUUID(),
        name: get(form, 'name'),
        lender: get(form, 'lender') || undefined,
        loanType: get(form, 'loanType') || undefined,
        principalCents: resolved.principalCents,
        accruedInterestCents: resolved.accruedInterestCents,
        balanceDate: resolved.balanceDate,
        annualRateBasisPoints: resolved.annualRateBasisPoints,
        accrualConvention: resolved.accrualConvention,
        paymentCents: resolved.paymentCents,
        cashPaymentCents: resolved.cashPaymentCents,
        nextPaymentDate: resolved.nextPaymentDate,
        maturityDate: resolved.maturityDate,
        originalPrincipalCents: resolved.originalPrincipalCents,
        originalDate: resolved.originalDate,
        originalTermMonths: resolved.originalTermMonths,
        amortizationStructure: resolved.amortizationStructure,
        expectedBalloonCents: resolved.expectedBalloonCents,
        inferredFields: [...inferredFields],
        fundingAccountId: get(form, 'fundingAccountId'),
        excludeFromEconomicNetWorthDoubleCount:
          form.get('excludeFromEconomicNetWorthDoubleCount') === 'on',
        paymentFrequency: resolved.paymentFrequency,
        includeInCashForecast: editingLoanIsRefinanceManaged
          ? editingLoan?.includeInCashForecast !== false
          : form.get('includeInCashForecast') === 'on',
        status: editingLoanIsRefinanceManaged
          ? (editingLoan?.status ?? 'active')
          : get(form, 'status'),
      },
    } as UpsertManagedEntityRequest);
    if (response.ok) {
      setRecords(response.value);
      setEditingLoanId(null);
      setMessage(
        inferredFields.size > 0
          ? `${editingLoan ? 'Loan updated' : 'Loan added'}. Calculated ${[...inferredFields]
              .map(loanSetupFieldLabel)
              .join(', ')}; you can replace any estimate with a lender value later.`
          : editingLoan
            ? 'Loan updated.'
            : 'Loan added.',
      );
      setError(null);
    } else setError(response.error);
  };
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Loans</Title1>
        <Text>
          Track payoff progress at a glance. Open a loan only when you need its full assumptions or
          amortization ledger.
        </Text>
      </div>
      <section className={styles.summaryStrip} aria-label="Loan portfolio summary">
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Remaining loan debt</Text>
          <Text className={styles.value}>{formatMoney(activeLoanBalanceCents)}</Text>
        </Card>
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Regular payments</Text>
          <Text className={styles.amount}>{formatMoney(activeLoanPaymentsCents)}</Text>
          <Text className={styles.muted}>Across {activeLoanSummaries.length} active loans</Text>
        </Card>
        <Card className={styles.summaryTile}>
          <Text className={styles.eyebrow}>Modeled daily interest</Text>
          <Text className={styles.amount}>
            {formatMoney(
              activeLoanSummaries.reduce((total, summary) => total + summary.dailyInterestCents, 0),
            )}
          </Text>
        </Card>
      </section>
      {(message || error) && (
        <Card className={styles.panel}>
          {message && (
            <div role="status" className={styles.positive}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          )}
        </Card>
      )}
      <Card className={styles.panel}>
        <Button appearance="primary" onClick={() => setEditingLoanId('new')}>
          Add loan
        </Button>
      </Card>
      {editingLoanId && (
        <Card
          ref={loanEditorRef}
          className={`${styles.panel} balance-editor-reveal`}
          tabIndex={-1}
          aria-labelledby="loan-editor-title"
        >
          <form
            key={editingLoan?.id ?? 'new-loan'}
            className={styles.form}
            onSubmit={(event) => void saveLoan(event)}
          >
            <Title2 id="loan-editor-title" as="h2">
              {editingLoan ? `Edit ${editingLoan.name}` : 'Add a loan'}
            </Title2>
            <Text className={styles.muted}>
              You do not need every field. A current balance, APR, and payment is enough for an
              ongoing payoff; original amount, date, and term can calculate missing schedule facts.
              Choose balloon or bullet only when the contract leaves a lump sum at maturity.
              Contradictory values are never silently accepted. On an existing loan, a blank
              calculated field keeps its prior dated value unless you explicitly recalculate it.
            </Text>
            <div className={styles.grid}>
              <Field label="Loan name">
                <Input name="name" required defaultValue={editingLoan?.name} />
              </Field>
              <Field label="Lender (optional)">
                <Input name="lender" defaultValue={editingLoan?.lender ?? ''} />
              </Field>
              <Field label="Loan type (optional)">
                <Input
                  name="loanType"
                  placeholder="Auto, personal, mortgage, retirement plan…"
                  defaultValue={editingLoan?.loanType ?? ''}
                />
              </Field>
              <Field
                label="Current principal (optional)"
                hint="Leave blank if you want it calculated from the original schedule."
              >
                <Input
                  name="principal"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'principalCents',
                    centsInput(editingLoan?.principalCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'principalCents',
                    centsInput(editingLoan?.principalCents),
                  )}
                />
              </Field>
              <Field
                label="Accrued interest (optional)"
                hint="Leave blank to assume zero at the balance date."
              >
                <Input
                  name="accruedInterest"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'accruedInterestCents',
                    centsInput(editingLoan?.accruedInterestCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'accruedInterestCents',
                    centsInput(editingLoan?.accruedInterestCents),
                  )}
                />
              </Field>
              <Field
                label="Balance as of (optional)"
                hint="Leave blank to use the dashboard financial date."
              >
                <Input
                  name="balanceDate"
                  type="date"
                  defaultValue={editableLoanDefault('balanceDate', editingLoan?.balanceDate ?? '')}
                />
              </Field>
              <Field label="Annual rate (optional)">
                <Input
                  name="rate"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'annualRateBasisPoints',
                    editingLoan ? (editingLoan.annualRateBasisPoints / 100).toFixed(2) : '',
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'annualRateBasisPoints',
                    editingLoan ? (editingLoan.annualRateBasisPoints / 100).toFixed(2) : '',
                  )}
                />
              </Field>
              <Field
                label="Accrual method (optional)"
                hint="Leave unknown to use Actual/365 and mark it as calculated."
              >
                <Select
                  name="accrualConvention"
                  defaultValue={editableLoanDefault(
                    'accrualConvention',
                    editingLoan?.accrualConvention ?? '',
                  )}
                >
                  <option value="">Not sure — use Actual/365</option>
                  <option value="actual-365">Actual/365</option>
                  <option value="actual-360">Actual/360</option>
                  <option value="monthly">Monthly approximation</option>
                </Select>
              </Field>
              <Field
                label="Amount applied to debt (optional)"
                hint="This is principal plus interest, excluding escrow, insurance, or fees."
              >
                <Input
                  name="payment"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'paymentCents',
                    centsInput(editingLoan?.paymentCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'paymentCents',
                    centsInput(editingLoan?.paymentCents),
                  )}
                />
              </Field>
              <Field
                label="Total cash payment (optional)"
                hint="Use this when the bank draft includes escrow, insurance, or fees. Leave blank when it equals the amount applied to debt."
              >
                <Input
                  name="cashPayment"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'cashPaymentCents',
                    centsInput(editingLoan?.cashPaymentCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'cashPaymentCents',
                    centsInput(editingLoan?.cashPaymentCents),
                  )}
                />
              </Field>
              <Field
                label="Next payment date (optional)"
                hint="Calculated from a known origination date when possible."
              >
                <Input
                  name="nextPaymentDate"
                  type="date"
                  defaultValue={editableLoanDefault(
                    'nextPaymentDate',
                    editingLoan?.nextPaymentDate ?? '',
                  )}
                />
              </Field>
              <Field
                label="Contractual maturity / final scheduled payment (optional)"
                hint="For a balloon loan, this is the date the remaining lump sum is due. It is not an estimated early payoff date."
              >
                <Input
                  name="maturityDate"
                  type="date"
                  defaultValue={editableLoanDefault(
                    'maturityDate',
                    editingLoan?.maturityDate ?? '',
                  )}
                />
              </Field>
              <Field
                label="Payoff structure"
                hint="Most consumer loans are fully amortizing. Choose balloon or bullet only when a residual is contractually due at maturity."
              >
                <Select
                  name="amortizationStructure"
                  defaultValue={editingLoan?.amortizationStructure ?? 'fully-amortizing'}
                >
                  <option value="fully-amortizing">Fully amortizing</option>
                  <option value="balloon">Balloon or bullet</option>
                </Select>
              </Field>
              <Field
                label="Expected balloon at maturity (optional)"
                hint="Leave blank to calculate the maturity lump sum from the regular payment and contract dates."
              >
                <Input
                  name="expectedBalloon"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'expectedBalloonCents',
                    centsInput(editingLoan?.expectedBalloonCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'expectedBalloonCents',
                    centsInput(editingLoan?.expectedBalloonCents),
                  )}
                />
              </Field>
              <Field label="Original loan amount (optional)">
                <Input
                  name="originalPrincipal"
                  inputMode="decimal"
                  defaultValue={editableLoanDefault(
                    'originalPrincipalCents',
                    centsInput(editingLoan?.originalPrincipalCents),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'originalPrincipalCents',
                    centsInput(editingLoan?.originalPrincipalCents),
                  )}
                />
              </Field>
              <Field label="Origination date (optional)">
                <Input
                  name="originalDate"
                  type="date"
                  defaultValue={editableLoanDefault(
                    'originalDate',
                    editingLoan?.originalDate ?? '',
                  )}
                />
              </Field>
              <Field label="Original term in months (optional)">
                <Input
                  name="originalTermMonths"
                  type="number"
                  min="1"
                  max="1200"
                  defaultValue={editableLoanDefault(
                    'originalTermMonths',
                    editingLoan?.originalTermMonths === undefined
                      ? ''
                      : String(editingLoan.originalTermMonths),
                  )}
                  placeholder={calculatedLoanPlaceholder(
                    'originalTermMonths',
                    editingLoan?.originalTermMonths === undefined
                      ? ''
                      : String(editingLoan.originalTermMonths),
                  )}
                />
              </Field>
              <Field label="Payment account">
                <Select
                  name="fundingAccountId"
                  required
                  defaultValue={editingLoan?.fundingAccountId}
                >
                  {records.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Payment frequency (optional)"
                hint="Leave unknown to use monthly and mark it as calculated."
              >
                <Select
                  name="paymentFrequency"
                  defaultValue={editableLoanDefault(
                    'paymentFrequency',
                    editingLoan?.paymentFrequency ?? '',
                  )}
                >
                  <option value="">Not sure — use monthly</option>
                  <option value="monthly">Monthly</option>
                  <option value="biweekly">Every two weeks</option>
                </Select>
              </Field>
              {editingLoanIsRefinanceManaged ? (
                <Field label="Loan lifecycle">
                  <Text>
                    Managed by committed refinance timing. Change or cancel the plan from the
                    Refinance planner.
                  </Text>
                </Field>
              ) : (
                <Field label="Loan status">
                  <Select name="status" defaultValue={editingLoan?.status ?? 'active'}>
                    <option value="active">Active</option>
                    <option value="paid-off">Paid off</option>
                  </Select>
                </Field>
              )}
            </div>
            {editingLoan && editingInferredFields.size > 0 && (
              <Checkbox
                name="recalculateInferredFields"
                label="Recalculate calculated fields from the edited lender facts"
              />
            )}
            <Checkbox
              name="includeInCashForecast"
              defaultChecked={editingLoan?.includeInCashForecast !== false}
              disabled={editingLoanIsRefinanceManaged}
              label={
                editingLoanIsRefinanceManaged
                  ? 'Cash timing is managed by the committed refinance plan'
                  : 'Include scheduled payments in the cash forecast'
              }
            />
            <Checkbox
              name="excludeFromEconomicNetWorthDoubleCount"
              defaultChecked={editingLoan?.excludeFromEconomicNetWorthDoubleCount ?? false}
              label="Exclude a second subtraction from economic net worth"
            />
            <div className={styles.actions}>
              <Button appearance="primary" type="submit">
                Calculate and save loan
              </Button>
              <Button type="button" onClick={() => setEditingLoanId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {records.loans.length === 0 ? (
        <Card className={styles.panel}>No loans recorded yet.</Card>
      ) : (
        records.loans.map((loan) => {
          const originPlan = originPlanByLoanId.get(loan.id);
          const retirementPlan = retirementPlanByLoanId.get(loan.id);
          const futureReplacement = Boolean(
            originPlan && compareDates(today, originPlan.closingDate) < 0,
          );
          const retiredByRefinance = Boolean(
            retirementPlan && compareDates(today, retirementPlan.payoffDate) >= 0,
          );
          const effectiveMetrics = effectiveLoanPageMetrics(
            loan,
            effectiveLoanById.get(loan.id),
            today,
            records.events,
          );
          const { modeled, payoff, dailyInterestCents } = effectiveMetrics;
          const amortizationRows = effectiveLoanById.has(loan.id)
            ? loanAmortizationLedger(effectiveLoanById.get(loan.id)!, today, records.events)
            : [];
          const originalPrincipalCents = Math.max(
            loan.originalPrincipalCents ?? loan.principalCents,
            modeled.totalCents,
          );
          const paidOffPercent =
            originalPrincipalCents > 0
              ? Math.max(0, Math.min(100, (1 - modeled.totalCents / originalPrincipalCents) * 100))
              : 100;
          const remainingPayments = amortizationRows.filter(
            (row) => row.type !== 'additional-principal',
          ).length;
          const lifecycle = cancelledReplacementIds.has(loan.id)
            ? 'Cancelled replacement loan'
            : retirementPlan && compareDates(today, retirementPlan.payoffDate) >= 0
              ? `Paid off by ${retirementPlan.name} on ${retirementPlan.payoffDate}`
              : originPlan && compareDates(today, originPlan.closingDate) < 0
                ? `Scheduled to start with ${originPlan.name} on ${originPlan.closingDate}`
                : originPlan && compareDates(today, originPlan.payoffDate) < 0
                  ? `Funded by ${originPlan.name}; source payoff pending until ${originPlan.payoffDate}`
                  : retirementPlan
                    ? `Active until ${retirementPlan.name} pays it off on ${retirementPlan.payoffDate}`
                    : originPlan
                      ? `Active replacement from ${originPlan.name}`
                      : !effectiveLoanIds.has(loan.id)
                        ? `Completed by its recorded schedule${loan.maturityDate ? ` on ${loan.maturityDate}` : ''}`
                        : loan.status === 'paid-off'
                          ? 'Paid off'
                          : 'Active';
          const lifecycleIsLocked =
            cancelledReplacementIds.has(loan.id) ||
            Boolean(originPlan && compareDates(today, originPlan.payoffDate) < 0) ||
            Boolean(retirementPlan);
          const loanCard = (
            <Card className={styles.panel} key={loan.id}>
              <div className={styles.recordHeader}>
                <Title2 as="h2">{loan.name}</Title2>
                <div className={styles.actions}>
                  {!lifecycleIsLocked && (
                    <Button onClick={() => setEditingLoanId(loan.id)}>Edit loan</Button>
                  )}
                  {lifecycleIsLocked && (originPlan || retirementPlan) && (
                    <Button onClick={() => navigate('/refinance')}>Review refinance history</Button>
                  )}
                  {refinanceCandidateIds.has(loan.id) && (
                    <Button
                      onClick={() => navigate(`/refinance?loan=${encodeURIComponent(loan.id)}`)}
                    >
                      Plan a refinance
                    </Button>
                  )}
                </div>
              </div>
              <div className={styles.payoffHero}>
                <div className={styles.stack}>
                  <div className={styles.recordHeader}>
                    <div className={styles.compact}>
                      <Text className={styles.eyebrow}>Payoff progress</Text>
                      <Text className={styles.value}>{paidOffPercent.toFixed(0)}%</Text>
                    </div>
                    <div className={styles.compact}>
                      <Text className={styles.eyebrow}>Remaining balance</Text>
                      <Text className={styles.amount}>{formatMoney(modeled.totalCents)}</Text>
                    </div>
                  </div>
                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-label={`${loan.name} payoff progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(paidOffPercent)}
                  >
                    <span
                      className={`${styles.progressFill} ${styles.progressFillPositive}`}
                      style={{ width: `${paidOffPercent}%` }}
                    />
                  </div>
                  <Text className={styles.muted}>
                    {remainingPayments} modeled payment{remainingPayments === 1 ? '' : 's'} left ·{' '}
                    {payoff?.paidOffDate ? `target ${payoff.paidOffDate}` : lifecycle}
                  </Text>
                </div>
                <div className={styles.compact}>
                  <Text className={styles.eyebrow}>Next payment</Text>
                  <Text className={styles.amount}>
                    {formatMoney(effectiveMetrics.recordedPaymentCents)}
                  </Text>
                  <Text className={styles.muted}>
                    {effectiveMetrics.nextPaymentDate ?? 'No active payment'}
                  </Text>
                </div>
              </div>
              <details className={styles.disclosure}>
                <summary>Loan details and assumptions</summary>
                <div>
                  <div className={styles.grid}>
                    <Text>
                      Lender and type:{' '}
                      {[loan.lender, loan.loanType].filter(Boolean).join(' · ') || 'Not entered'}
                    </Text>
                    <Text>Recorded lender principal: {formatMoney(loan.principalCents)}</Text>
                    <Text>
                      Effective modeled balance ({today}): {formatMoney(modeled.totalCents)}
                    </Text>
                    <Text>Contract rate: {(loan.annualRateBasisPoints / 100).toFixed(2)}%</Text>
                    <Text>
                      {effectiveMetrics.active
                        ? 'Active payment'
                        : futureReplacement
                          ? 'Future payment terms'
                          : 'Historical payment'}
                      : {formatMoney(effectiveMetrics.recordedPaymentCents)}
                    </Text>
                    <Text>
                      Next payment:{' '}
                      {effectiveMetrics.nextPaymentDate ??
                        (futureReplacement
                          ? `Starts ${originPlan!.firstPaymentDate}`
                          : retiredByRefinance
                            ? `None — retired ${retirementPlan!.payoffDate}`
                            : 'None — loan is not active')}
                    </Text>
                    <Text>
                      Payoff structure:{' '}
                      {loan.amortizationStructure === 'balloon'
                        ? 'Balloon or bullet'
                        : 'Fully amortizing'}
                    </Text>
                    <Text>Contractual maturity: {loan.maturityDate ?? 'Not entered'}</Text>
                    {loan.amortizationStructure === 'balloon' && (
                      <Text>
                        Expected balloon beyond the regular payment:{' '}
                        {loan.expectedBalloonCents === undefined
                          ? 'Calculated from the schedule'
                          : formatMoney(loan.expectedBalloonCents)}
                      </Text>
                    )}
                    <Text>
                      Original loan:{' '}
                      {loan.originalPrincipalCents === undefined
                        ? 'Not entered'
                        : `${formatMoney(loan.originalPrincipalCents)}${loan.originalDate ? ` on ${loan.originalDate}` : ''}`}
                    </Text>
                    <Text>
                      Original term:{' '}
                      {loan.originalTermMonths === undefined
                        ? 'Not entered'
                        : `${loan.originalTermMonths} months`}
                    </Text>
                    <Text>
                      Cash draft: {formatMoney(loan.cashPaymentCents ?? loan.paymentCents)}
                      {(loan.cashPaymentCents ?? loan.paymentCents) === loan.paymentCents
                        ? ' (all applied to debt)'
                        : ` (${formatMoney(loan.paymentCents)} applied to debt)`}
                    </Text>
                    {loan.inferredFields && loan.inferredFields.length > 0 && (
                      <Text>
                        Calculated setup fields:{' '}
                        {loan.inferredFields.map(loanSetupFieldLabel).join(', ')}
                      </Text>
                    )}
                    <Text>Lifecycle: {lifecycle}</Text>
                    <Text>
                      Cash schedule:{' '}
                      {!effectiveMetrics.active
                        ? futureReplacement
                          ? `Begins on ${originPlan!.firstPaymentDate}`
                          : retiredByRefinance
                            ? `Stopped on ${retirementPlan!.payoffDate}`
                            : 'No active scheduled payments'
                        : loan.includeInCashForecast === false
                          ? 'Excluded (already deducted or paid off)'
                          : `${loan.paymentFrequency ?? 'monthly'} from funding account`}
                    </Text>
                    <Text>
                      Daily accrual ({loan.accrualConvention}): {formatMoney(dailyInterestCents)}
                    </Text>
                    <Text>
                      Modeled payoff timing:{' '}
                      {!payoff
                        ? futureReplacement
                          ? `Begins when the loan closes on ${originPlan!.closingDate}`
                          : 'No remaining active payoff'
                        : !payoff.costKnown || !payoff.paidOffDate
                          ? 'Not amortizing on the current terms'
                          : `${payoff.paidOffDate}${
                              payoff.remainingTermMonths === null
                                ? ''
                                : ` (${payoff.remainingTermMonths} months)`
                            }`}
                    </Text>
                    <Text>
                      Remaining modeled interest:{' '}
                      {!payoff
                        ? futureReplacement
                          ? 'Not accruing before closing'
                          : formatMoney(0)
                        : payoff.remainingInterestCents === null
                          ? 'Not finite'
                          : formatMoney(payoff.remainingInterestCents)}
                    </Text>
                    {payoff && payoff.maturityPaymentCents > loan.paymentCents && (
                      <Text
                        className={
                          loan.amortizationStructure === 'fully-amortizing'
                            ? styles.error
                            : undefined
                        }
                      >
                        {loan.amortizationStructure === 'balloon'
                          ? 'Modeled contractual maturity payment'
                          : 'Unexpected maturity balloon'}
                        : {formatMoney(payoff.maturityPaymentCents)}
                      </Text>
                    )}
                  </div>
                </div>
              </details>
              {effectiveMetrics.active && (
                <details className={styles.disclosure}>
                  <summary>Upcoming amortization ledger ({amortizationRows.length} rows)</summary>
                  <div>
                    <div className={styles.sectionIntro}>
                      <Text className={styles.muted}>
                        Every row uses the same dated interest, regular-payment, and extra-principal
                        mechanics as the current balance, cash forecast, and refinance payoff.
                        {loan.cashPaymentCents !== undefined &&
                        loan.cashPaymentCents !== loan.paymentCents
                          ? ` Cash draft includes ${formatMoney(loan.cashPaymentCents - loan.paymentCents)} per regular payment that is not applied to debt.`
                          : ''}
                        {payoff && !payoff.costKnown && !loan.maturityDate
                          ? ' Because the current terms do not reach payoff, this table shows the next 36 months.'
                          : ''}
                      </Text>
                    </div>
                    {amortizationRows.length === 0 ? (
                      <Text>No future debt allocations remain on the current schedule.</Text>
                    ) : (
                      <div className={styles.comparisonScroll}>
                        <table className={styles.comparisonTable}>
                          <thead>
                            <tr>
                              <th scope="col">Date</th>
                              <th scope="col">Allocation</th>
                              <th scope="col">Cash draft</th>
                              <th scope="col">Interest</th>
                              <th scope="col">Principal</th>
                              <th scope="col">Remaining debt</th>
                            </tr>
                          </thead>
                          <tbody>
                            {amortizationRows.map((row) => (
                              <tr key={row.id}>
                                <td data-label="Date">{row.date}</td>
                                <td data-label="Allocation">
                                  {row.label}
                                  <br />
                                  <Text className={styles.muted}>
                                    {row.type === 'additional-principal'
                                      ? 'Extra principal'
                                      : 'Scheduled payment'}
                                  </Text>
                                </td>
                                <td data-label="Cash draft">{formatMoney(row.cashDraftCents)}</td>
                                <td data-label="Interest">{formatMoney(row.interestPaidCents)}</td>
                                <td data-label="Principal">
                                  {formatMoney(row.principalPaidCents)}
                                </td>
                                <td data-label="Remaining debt">
                                  {formatMoney(row.remainingDebtCents)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </Card>
          );
          if (effectiveMetrics.active) return loanCard;
          return (
            <details className={styles.inactiveLoanDisclosure} key={loan.id}>
              <summary className={styles.inactiveLoanSummary}>
                <span className={styles.inactiveLoanSummaryMeta}>
                  <strong>{loan.name}</strong>
                  <Text size={200}>{lifecycle}</Text>
                </span>
                <span className={styles.inactiveLoanSummaryMeta}>
                  <Text size={200}>
                    {futureReplacement ? 'Future balance' : 'Last modeled balance'}
                  </Text>
                  <strong>{formatMoney(modeled.totalCents)}</strong>
                </span>
              </summary>
              {loanCard}
            </details>
          );
        })
      )}
    </>
  );
};

export const ReceivablesPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [asOfDate, setAsOfDate] = useState(Temporal.Now.plainDateISO().toString());
  const [editingReceivableId, setEditingReceivableId] = useState<string | 'new' | null>(null);
  const [receiptTimingMode, setReceiptTimingMode] = useState<
    'once' | 'recurring' | 'bill-relative'
  >('once');
  const [receiptFrequency, setReceiptFrequency] = useState<RecurrenceRule['frequency']>('once');
  const [expectedReceiptDate, setExpectedReceiptDate] = useState(
    defaultReceivableReceiptDate(asOfDate),
  );
  const [settlementAnchorEventId, setSettlementAnchorEventId] = useState('');
  const [settlementOffsetDirection, setSettlementOffsetDirection] = useState<'before' | 'after'>(
    'before',
  );
  const [settlementOffsetDayCount, setSettlementOffsetDayCount] = useState(2);
  const [includeInCashForecast, setIncludeInCashForecast] = useState(false);
  const [settlementReceivableId, setSettlementReceivableId] = useState('');
  const receivableActionRef = useRef<'save' | 'settle' | null>(null);
  const [receivableAction, setReceivableAction] = useState<'save' | 'settle' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receivableEditorRef = useEditorReveal<HTMLDivElement>(editingReceivableId);
  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loaded, forecast]) => {
        setRecords(loaded);
        if (forecast.ok && forecast.value.startDate) setAsOfDate(forecast.value.startDate);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading money owed to you" variant="list" />
    );
  const today = asOfDate;
  const editingReceivable =
    editingReceivableId && editingReceivableId !== 'new'
      ? records.receivables.find((receivable) => receivable.id === editingReceivableId)
      : undefined;
  const recurringBillAnchors = records.events
    .filter(
      (forecastEvent) =>
        forecastEvent.direction === 'outflow' &&
        forecastEvent.recurrenceRule !== undefined &&
        forecastEvent.recurrenceRule.frequency !== 'once' &&
        !forecastEvent.hypothetical &&
        forecastEvent.status !== 'cancelled' &&
        forecastEvent.status !== 'skipped',
    )
    .sort((left, right) => left.label.localeCompare(right.label));
  const updateExpectedDateFromBill = (
    anchorEventId: string,
    direction: 'before' | 'after',
    dayCount: number,
  ) => {
    const anchorEvent = recurringBillAnchors.find((candidate) => candidate.id === anchorEventId);
    if (!anchorEvent || !Number.isInteger(dayCount) || dayCount < 0 || dayCount > 366) return;
    try {
      const nextExpectedDate = anchoredReceivableDateForEdit({
        existing: editingReceivable,
        anchorEvent: anchorEvent,
        settlementOffsetDays: direction === 'before' ? -dayCount : dayCount,
        onOrAfter: today,
      });
      setExpectedReceiptDate(nextExpectedDate);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to calculate the first receipt.');
    }
  };
  const changeReceiptTimingMode = (mode: 'once' | 'recurring' | 'bill-relative') => {
    setReceiptTimingMode(mode);
    if (mode === 'recurring' && receiptFrequency === 'once') setReceiptFrequency('monthly');
    if (mode !== 'bill-relative') return;
    const nextAnchorId = settlementAnchorEventId || recurringBillAnchors[0]?.id || '';
    setSettlementAnchorEventId(nextAnchorId);
    updateExpectedDateFromBill(nextAnchorId, settlementOffsetDirection, settlementOffsetDayCount);
  };
  const beginReceivableEdit = (receivableId: string | 'new') => {
    const receivable = records.receivables.find((candidate) => candidate.id === receivableId);
    setReceiptTimingMode(
      receivable?.settlementAnchorEventId
        ? 'bill-relative'
        : receivable?.recurrenceRule
          ? 'recurring'
          : 'once',
    );
    setReceiptFrequency(receivable?.recurrenceRule?.frequency ?? 'once');
    setExpectedReceiptDate(receivable?.expectedDate ?? defaultReceivableReceiptDate(today));
    setSettlementAnchorEventId(receivable?.settlementAnchorEventId ?? '');
    setSettlementOffsetDirection((receivable?.settlementOffsetDays ?? -2) < 0 ? 'before' : 'after');
    setSettlementOffsetDayCount(Math.abs(receivable?.settlementOffsetDays ?? -2));
    setIncludeInCashForecast(receivable ? receivable.includeInCashForecast !== false : false);
    setEditingReceivableId(receivableId);
  };
  const receivableReplayStartDate =
    records.accounts.map((account) => account.balanceAsOf).sort()[0] ?? today;
  const currentReceivableDay =
    records.receivables.length === 0
      ? undefined
      : projectRollingReceivableBalances({
          receivables: records.receivables,
          settlementEvents: records.events,
          replayStartDate: receivableReplayStartDate,
          startDate: today,
          endDate: today,
          mode: 'expected',
          includeConfirmedReceivablesConservatively:
            records.policy?.includeConfirmedReceivablesConservatively ?? true,
        })[0];
  const currentOwedById = new Map(
    (currentReceivableDay?.receivables ?? []).map((receivable) => [
      receivable.receivableId,
      receivable.endingOutstandingCents,
    ]),
  );
  const openReceivables = records.receivables.filter(
    (receivable) => (currentOwedById.get(receivable.id) ?? receivable.remainingAmountCents) > 0,
  );
  const recurringReceivables = records.receivables.filter(
    (receivable) => hasRecurringReceivableSchedule(receivable) && receivable.recurringAmountCents,
  );
  const accruingReceivables = records.receivables.filter(
    (receivable) => receivable.accrualRecurrenceRule && receivable.accrualAmountCents,
  );
  const activeRecurringReceivables = recurringReceivables.filter((receivable) =>
    isRecurringRunRateActive(receivable.recurrenceEndDate, today),
  );
  const activeAccruingReceivables = accruingReceivables.filter((receivable) =>
    isRecurringRunRateActive(receivable.recurrenceEndDate, today),
  );
  const settlementHistory = records.events
    .filter((event) => event.kind === 'receivable-settlement')
    .sort((left, right) => right.date.localeCompare(left.date));
  const totalOwedNow =
    currentReceivableDay?.endingOutstandingCents ??
    openReceivables.reduce((total, receivable) => total + receivable.remainingAmountCents, 0);
  const settleableReceivables = records.receivables.filter(
    (receivable) =>
      (currentOwedById.get(receivable.id) ?? receivable.remainingAmountCents) > 0 ||
      (hasRecurringReceivableSchedule(receivable) && (receivable.recurringAmountCents ?? 0) > 0),
  );
  const settlementReceivable =
    settleableReceivables.find((receivable) => receivable.id === settlementReceivableId) ??
    settleableReceivables[0];
  const receiptDatesThrough = (
    receivable: ManagedRecordsDto['receivables'][number],
    endDate: PlainDateString,
  ): PlainDateString[] => {
    try {
      return receivableSettlementDates({ receivable, events: records.events, endDate });
    } catch {
      return [];
    }
  };
  const nextPlannedReceiptFor = (
    receivable: ManagedRecordsDto['receivables'][number],
  ): ForecastEvent | undefined => {
    try {
      const scheduleEvents = records.events.filter(
        (event) =>
          event.kind === 'receivable-settlement' || event.id === receivable.settlementAnchorEventId,
      );
      return materializeForecastEvents({
        accounts: records.accounts,
        events: scheduleEvents,
        cards: [],
        cardCycles: [],
        loans: [],
        receivables: [receivable],
        startDate: today,
        endDate: addDays(today, 800),
        plannedReceivableStartDate: today,
      })
        .filter(
          (event) =>
            event.kind === 'receivable-settlement' &&
            event.status === 'planned' &&
            event.certainty !== 'uncertain' &&
            event.sourceRecordId === receivable.id &&
            event.id === `receivable-settlement-${receivable.id}@${event.date}`,
        )
        .sort((left, right) => left.date.localeCompare(right.date))[0];
    } catch {
      return undefined;
    }
  };
  const plannedOwedReductionFor = (
    receivable: ManagedRecordsDto['receivables'][number],
    receiptDate: PlainDateString,
  ): number | undefined => {
    try {
      const projectionStartDate = [
        receivableReplayStartDate,
        receivable.accrualDate,
        ...records.events
          .filter((event) => event.kind === 'receivable-settlement')
          .map((event) => event.date),
      ]
        .filter((date): date is PlainDateString => date !== undefined)
        .reduce((earliest, date) => (compareDates(date, earliest) < 0 ? date : earliest), today);
      const common = {
        receivables: [receivable],
        settlementEvents: records.events,
        startDate: projectionStartDate,
        endDate: receiptDate,
        currentBalancesAsOfDate: today,
        mode: 'expected' as const,
        includeConfirmedReceivablesConservatively:
          records.policy?.includeConfirmedReceivablesConservatively ?? true,
      };
      const withPlannedReceipt = projectReceivableBalances({
        ...common,
        plannedSettlementStartDate: today,
      }).at(-1);
      const withoutPlannedReceipt = projectReceivableBalances({
        ...common,
        plannedSettlementStartDate: addDays(receiptDate, 1),
      }).at(-1);
      if (!withPlannedReceipt || !withoutPlannedReceipt) return undefined;
      return Math.max(
        0,
        withoutPlannedReceipt.endingOutstandingCents - withPlannedReceipt.endingOutstandingCents,
      );
    } catch {
      return undefined;
    }
  };
  const settlementOccurrences =
    settlementReceivable && hasRecurringReceivableSchedule(settlementReceivable)
      ? receiptDatesThrough(
          settlementReceivable,
          compareDates(settlementReceivable.expectedDate, addDays(today, 800)) > 0
            ? settlementReceivable.expectedDate
            : addDays(today, 800),
        )
      : [];
  const defaultSettlementOccurrence = defaultReceivableSettlementOccurrence({
    receivable: settlementReceivable,
    events: records.events,
    settlementDate: today,
    fallbackOccurrences: settlementOccurrences,
  });
  const monthlyRecurring = monthlyEquivalentRunRateCents(
    activeRecurringReceivables.flatMap((receivable) => {
      const recurrenceRule =
        receivable.recurrenceRule ??
        records.events.find((event) => event.id === receivable.settlementAnchorEventId)
          ?.recurrenceRule;
      return recurrenceRule && receivable.recurringAmountCents !== undefined
        ? [{ amountCents: receivable.recurringAmountCents, recurrenceRule }]
        : [];
    }),
  );
  const monthlyAccrual = monthlyEquivalentRunRateCents(
    activeAccruingReceivables.flatMap((receivable) =>
      receivable.accrualRecurrenceRule && receivable.accrualAmountCents !== undefined
        ? [
            {
              amountCents: receivable.accrualAmountCents,
              recurrenceRule: receivable.accrualRecurrenceRule,
            },
          ]
        : [],
    ),
  );
  const paymentInstrumentName = (value?: string): string => {
    if (!value) return 'Not linked';
    const [kind, id] = value.split(':', 2);
    if (kind === 'cash-account') {
      return records.accounts.find((account) => account.id === id)?.name ?? value;
    }
    if (kind === 'credit-card') {
      return records.cards.find((card) => card.id === id)?.name ?? value;
    }
    return value;
  };
  const relatedExpenseName = (eventId?: string): string =>
    records.events.find((forecastEvent) => forecastEvent.id === eventId)?.label ?? 'Not linked';

  const saveReceivable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receivableActionRef.current) return;
    receivableActionRef.current = 'save';
    setReceivableAction('save');
    setError(null);
    try {
      const form = new FormData(event.currentTarget);
      const expectedDate = get(form, 'expectedDate');
      const timingMode = get(form, 'receiptTimingMode');
      const frequency = timingMode === 'recurring' ? get(form, 'recurrenceFrequency') : 'once';
      const repeats = timingMode !== 'once';
      const recurringAmountCents = optionalCents(form, 'recurringAmount');
      const anchorEventId =
        timingMode === 'bill-relative' ? get(form, 'settlementAnchorEventId') : '';
      const offsetDayCount = Number(get(form, 'settlementOffsetDayCount'));
      const settlementOffsetDays =
        timingMode === 'bill-relative'
          ? get(form, 'settlementOffsetDirection') === 'before'
            ? -offsetDayCount
            : offsetDayCount
          : undefined;
      const accrualFrequency = get(form, 'accrualFrequency');
      const accrualDate = get(form, 'accrualDate');
      if (repeats && (!recurringAmountCents || recurringAmountCents <= 0)) {
        setError('Enter the amount expected for each repeating receipt.');
        return;
      }
      if (timingMode === 'bill-relative' && !anchorEventId) {
        setError('Choose the recurring bill that controls this receipt date.');
        return;
      }
      if (
        timingMode === 'bill-relative' &&
        (!Number.isInteger(offsetDayCount) || offsetDayCount < 0 || offsetDayCount > 366)
      ) {
        setError('Enter a whole number of days from 0 through 366 for bill-relative timing.');
        return;
      }
      if (accrualFrequency !== 'none' && !accrualDate) {
        setError('Enter the first balance increase date for the owed-balance schedule.');
        return;
      }
      const existing = editingReceivable
        ? (makeEditRequest('receivable', editingReceivable).payload as Record<string, unknown>)
        : {};
      const recurrenceRule =
        timingMode === 'recurring'
          ? receivableRecurrenceRuleForEdit({
              frequency: frequency as RecurrenceRule['frequency'],
              expectedDate,
              existing: editingReceivable?.recurrenceRule,
            })
          : undefined;
      const accrualRecurrenceRule = receivableAccrualRecurrenceRuleForEdit({
        frequency: accrualFrequency as RecurrenceRule['frequency'] | 'none',
        accrualDate,
        existing: editingReceivable?.accrualRecurrenceRule,
      });
      const response = await window.balanceBook.upsertRecord({
        entityType: 'receivable',
        payload: {
          ...existing,
          id: editingReceivable?.id ?? crypto.randomUUID(),
          source: get(form, 'source'),
          description: get(form, 'description'),
          originalAmountCents: cents(form, 'originalAmount'),
          remainingAmountCents: cents(form, 'remainingAmount'),
          expectedDate,
          settlementDateConfirmed: form.get('settlementDateConfirmed') === 'on',
          settlementAnchorEventId: anchorEventId || undefined,
          settlementOffsetDays,
          destinationAccountId: get(form, 'destinationAccountId'),
          certainty: get(form, 'certainty'),
          grossExpenseCents: optionalCents(form, 'grossExpense'),
          userEconomicShareCents: optionalCents(form, 'userEconomicShare'),
          relatedExpenseId: get(form, 'relatedExpenseId') || undefined,
          paymentInstrument: get(form, 'paymentInstrument') || undefined,
          recurringAmountCents: repeats ? recurringAmountCents : undefined,
          recurrenceRule,
          recurrenceEndDate: repeats ? get(form, 'recurrenceEndDate') || undefined : undefined,
          accrualAmountCents: optionalCents(form, 'accrualAmount'),
          accrualDate: accrualDate || undefined,
          accrualRecurrenceRule,
          includeInCashForecast: form.get('includeInCashForecast') === 'on',
          notes: get(form, 'notes') || undefined,
        },
      } as UpsertManagedEntityRequest);
      if (response.ok) {
        setRecords(response.value);
        setEditingReceivableId(null);
        setMessage(editingReceivable ? 'Money-owed record updated.' : 'Money-owed record added.');
      } else setError(response.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Money owed could not be saved.');
    } finally {
      receivableActionRef.current = null;
      setReceivableAction(null);
    }
  };

  const settle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receivableActionRef.current) return;
    receivableActionRef.current = 'settle';
    setReceivableAction('settle');
    const formElement = event.currentTarget;
    setError(null);
    try {
      const form = new FormData(formElement);
      const response = await window.balanceBook.recordReceivableSettlement({
        receivableId: get(form, 'receivableId'),
        amountCents: cents(form, 'amount'),
        date: get(form, 'date'),
        occurrenceDate: get(form, 'occurrenceDate') || undefined,
        destinationAccountId: get(form, 'destinationAccountId'),
      });
      if (response.ok) {
        setRecords(response.value);
        setMessage('Funds released once to the selected account and removed from Money Owed.');
        formElement.reset();
      } else setError(response.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Received cash could not be recorded.');
    } finally {
      receivableActionRef.current = null;
      setReceivableAction(null);
    }
  };
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Money owed to you</Title1>
        <Text>
          Keep today&apos;s Settle Up balance separate from future recurring amounts. A recurring
          amount becomes owed on its scheduled date; it becomes cash only when you release it to a
          checking account.
        </Text>
      </div>
      {(message || error) && (
        <Card className={styles.panel}>
          {message && (
            <div role="status" className={styles.positive}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          )}
        </Card>
      )}
      <section className={styles.metrics}>
        <Card className={styles.metric}>
          <Text>Owed right now</Text>
          <Text className={styles.value}>{formatMoney(totalOwedNow)}</Text>
          <Text className={styles.muted}>Open, unsettled balances only</Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Average monthly future receivables</Text>
          <Text className={styles.value}>{formatMoney(monthlyRecurring)}</Text>
          <Text className={styles.muted}>
            Becomes owed on future schedule dates; not owed today
          </Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Average monthly owed-balance growth</Text>
          <Text className={styles.value}>{formatMoney(monthlyAccrual)}</Text>
          <Text className={styles.muted}>
            Monthly equivalent of new shared costs that become owed
          </Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Recorded settlements</Text>
          <Text className={styles.value}>{settlementHistory.length}</Text>
          <Text className={styles.muted}>Linked cash receipts in history</Text>
        </Card>
      </section>
      <Card className={styles.panel}>
        <div className={styles.actions}>
          <Button appearance="primary" onClick={() => beginReceivableEdit('new')}>
            Add money owed or recurring receipt
          </Button>
          <Button onClick={() => navigate('/records?type=receivable')}>
            Advanced receivable records
          </Button>
        </div>
      </Card>
      {editingReceivableId && (
        <Card
          ref={receivableEditorRef}
          className={`${styles.panel} balance-editor-reveal`}
          tabIndex={-1}
          aria-labelledby="receivable-editor-title"
        >
          <form
            key={editingReceivable?.id ?? 'new-receivable'}
            className={styles.form}
            onSubmit={(event) => void saveReceivable(event)}
          >
            <div className={styles.sectionIntro}>
              <Title2 id="receivable-editor-title" as="h2">
                {editingReceivable ? 'Edit money-owed record' : 'Add money owed to you'}
              </Title2>
              <Text>
                Enter today&apos;s Settle Up balance separately from future recurring amounts. For a
                recurring amount with nothing owed today, leave both current amounts at $0 and set
                when each future amount becomes owed.
              </Text>
            </div>
            <div className={styles.grid}>
              <Field label="Who owes you">
                <Input name="source" required defaultValue={editingReceivable?.source} />
              </Field>
              <Field label="What it is for">
                <Input name="description" required defaultValue={editingReceivable?.description} />
              </Field>
              <Field label="Original amount owed now">
                <Input
                  name="originalAmount"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editingReceivable
                      ? (editingReceivable.originalAmountCents / 100).toFixed(2)
                      : '0.00'
                  }
                />
              </Field>
              <Field
                label="Still owed now"
                hint="This is the current balance. Any balance-growth dates through today are treated as already included; only later growth is added."
              >
                <Input
                  name="remainingAmount"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editingReceivable
                      ? (editingReceivable.remainingAmountCents / 100).toFixed(2)
                      : '0.00'
                  }
                />
              </Field>
            </div>
            <div className={mergeClasses(styles.formSection, styles.receiptSection)}>
              <div className={styles.compact}>
                <strong>When the amount becomes owed</strong>
                <Text className={styles.muted}>
                  Each occurrence increases future Money Owed on this date. It does not touch a
                  checking account until you release that occurrence after the cash arrives.
                </Text>
              </div>
              <div className={styles.grid}>
                <Field
                  label="Timing method"
                  hint="Choose exactly one method so the same expected receipt is never scheduled twice."
                >
                  <Select
                    name="receiptTimingMode"
                    value={receiptTimingMode}
                    onChange={(_, data) =>
                      changeReceiptTimingMode(data.value as 'once' | 'recurring' | 'bill-relative')
                    }
                  >
                    <option value="once">One expected date</option>
                    <option value="recurring">Repeat on a schedule</option>
                    <option value="bill-relative" disabled={recurringBillAnchors.length === 0}>
                      Relative to a recurring bill
                    </option>
                  </Select>
                </Field>
                {receiptTimingMode === 'recurring' && (
                  <Field label="How often it repeats">
                    <Select
                      name="recurrenceFrequency"
                      value={receiptFrequency}
                      onChange={(_, data) => {
                        setReceiptFrequency(data.value as RecurrenceRule['frequency']);
                      }}
                    >
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Every two weeks</option>
                      <option value="monthly">Monthly</option>
                      {editingReceivable?.recurrenceRule?.frequency === 'semimonthly' && (
                        <option value="semimonthly">
                          Twice monthly (preserve existing schedule)
                        </option>
                      )}
                    </Select>
                  </Field>
                )}
                {receiptTimingMode === 'bill-relative' && (
                  <>
                    <Field
                      label="Recurring bill"
                      hint="Each receipt follows this bill's real schedule, even when the due date shifts by month."
                    >
                      <Select
                        name="settlementAnchorEventId"
                        required
                        value={settlementAnchorEventId}
                        onChange={(_, data) => {
                          setSettlementAnchorEventId(data.value);
                          updateExpectedDateFromBill(
                            data.value,
                            settlementOffsetDirection,
                            settlementOffsetDayCount,
                          );
                        }}
                      >
                        <option value="">Choose a recurring bill</option>
                        {recurringBillAnchors.map((forecastEvent) => (
                          <option key={forecastEvent.id} value={forecastEvent.id}>
                            {forecastEvent.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Number of calendar days">
                      <Input
                        name="settlementOffsetDayCount"
                        type="number"
                        min={0}
                        max={366}
                        step={1}
                        required
                        value={String(settlementOffsetDayCount)}
                        onChange={(_, data) => {
                          const nextDayCount = Math.max(0, Math.min(366, Number(data.value) || 0));
                          setSettlementOffsetDayCount(nextDayCount);
                          updateExpectedDateFromBill(
                            settlementAnchorEventId,
                            settlementOffsetDirection,
                            nextDayCount,
                          );
                        }}
                      />
                    </Field>
                    <Field label="Before or after the bill">
                      <Select
                        name="settlementOffsetDirection"
                        value={settlementOffsetDirection}
                        onChange={(_, data) => {
                          const nextDirection = data.value as 'before' | 'after';
                          setSettlementOffsetDirection(nextDirection);
                          updateExpectedDateFromBill(
                            settlementAnchorEventId,
                            nextDirection,
                            settlementOffsetDayCount,
                          );
                        }}
                      >
                        <option value="before">Before the bill is due</option>
                        <option value="after">After the bill is due</option>
                      </Select>
                    </Field>
                  </>
                )}
                <Field
                  label={
                    receiptTimingMode === 'bill-relative'
                      ? 'First calculated owed date'
                      : receiptTimingMode === 'once'
                        ? 'Expected owed or release date'
                        : 'First date it becomes owed'
                  }
                  hint={
                    receiptTimingMode === 'bill-relative'
                      ? 'Calculated from the bill schedule above; later receipts keep the same before-or-after rule.'
                      : editingReceivable
                        ? includeInCashForecast
                          ? 'Changing this date moves the expected cash and matching Money Owed timing in the forecast.'
                          : 'Changing this date moves when the amount accrues in Money Owed. Checking cash moves only after you release it.'
                        : 'New receipts default to the first day of next month; change it whenever you know a better date.'
                  }
                >
                  <Input
                    name="expectedDate"
                    type="date"
                    required
                    readOnly={receiptTimingMode === 'bill-relative'}
                    value={expectedReceiptDate}
                    onChange={(_, data) => {
                      setExpectedReceiptDate(data.value);
                    }}
                  />
                </Field>
                <Field
                  label="Default release account"
                  hint="You can choose a different checking account each time you release funds."
                >
                  <Select
                    name="destinationAccountId"
                    required
                    defaultValue={editingReceivable?.destinationAccountId ?? ''}
                  >
                    <option value="">Choose a deposit account</option>
                    {records.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Confidence in this receipt">
                  <Select
                    name="certainty"
                    defaultValue={editingReceivable?.certainty ?? 'expected'}
                  >
                    <option value="confirmed">Confirmed</option>
                    <option value="expected">Expected</option>
                    <option value="uncertain">Uncertain</option>
                  </Select>
                </Field>
                {receiptTimingMode !== 'once' && (
                  <>
                    <Field
                      label="Amount that becomes owed each time"
                      hint="It appears only in future Money Owed until that occurrence date arrives."
                    >
                      <Input
                        name="recurringAmount"
                        inputMode="decimal"
                        required
                        defaultValue={centsInput(
                          editingReceivable?.recurringAmountCents ??
                            editingReceivable?.originalAmountCents,
                        )}
                      />
                    </Field>
                    <Field label="Repeating receipts end (optional)">
                      <Input
                        name="recurrenceEndDate"
                        type="date"
                        defaultValue={editingReceivable?.recurrenceEndDate ?? ''}
                      />
                    </Field>
                  </>
                )}
              </div>
              <Checkbox
                name="settlementDateConfirmed"
                defaultChecked={
                  editingReceivable ? editingReceivable.settlementDateConfirmed !== false : false
                }
                label="I know the date (show it as confirmed)"
              />
              <Checkbox
                name="includeInCashForecast"
                checked={includeInCashForecast}
                onChange={(_, data) => setIncludeInCashForecast(Boolean(data.checked))}
                label="Automatically release each occurrence into checking on its schedule"
              />
              <Text className={styles.muted}>
                Leave automatic release off for Settle Up-style reimbursements. The forecast will
                still include future Money Owed, and you will choose the destination when cash
                actually arrives.
              </Text>
            </div>
            <div className={styles.formSection}>
              <strong>Optional shared-expense economics</strong>
              <Text className={styles.muted}>
                Keep the full purchase burden separate from your own final share. These values
                explain the receivable but never create extra cash.
              </Text>
              <div className={styles.grid}>
                <Field label="Related expense or purchase (optional)">
                  <Select
                    name="relatedExpenseId"
                    defaultValue={editingReceivable?.relatedExpenseId ?? ''}
                  >
                    <option value="">Not linked</option>
                    {records.events
                      .filter((forecastEvent) => forecastEvent.direction === 'outflow')
                      .map((forecastEvent) => (
                        <option key={forecastEvent.id} value={forecastEvent.id}>
                          {forecastEvent.date} · {forecastEvent.label} ·{' '}
                          {formatMoney(forecastEvent.amountCents)}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Payment instrument (optional)">
                  <Select
                    name="paymentInstrument"
                    defaultValue={editingReceivable?.paymentInstrument ?? ''}
                  >
                    <option value="">Not linked</option>
                    {records.accounts.map((account) => (
                      <option key={`cash-${account.id}`} value={`cash-account:${account.id}`}>
                        Cash account · {account.name}
                      </option>
                    ))}
                    {records.cards.map((card) => (
                      <option key={`card-${card.id}`} value={`credit-card:${card.id}`}>
                        Credit card · {card.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Full shared expense (optional)">
                  <Input
                    name="grossExpense"
                    inputMode="decimal"
                    defaultValue={
                      editingReceivable?.grossExpenseCents === undefined
                        ? ''
                        : (editingReceivable.grossExpenseCents / 100).toFixed(2)
                    }
                  />
                </Field>
                <Field label="Your final share (optional)">
                  <Input
                    name="userEconomicShare"
                    inputMode="decimal"
                    defaultValue={
                      editingReceivable?.userEconomicShareCents === undefined
                        ? ''
                        : (editingReceivable.userEconomicShareCents / 100).toFixed(2)
                    }
                  />
                </Field>
              </div>
            </div>
            <div className={styles.formSection}>
              <strong>Optional owed-balance growth</strong>
              <Text className={styles.muted}>
                Use this only when a new shared cost periodically becomes owed to you. It changes
                the receivable balance; it does not create cash.
              </Text>
              <div className={styles.grid}>
                <Field label="Balance increases by">
                  <Input
                    name="accrualAmount"
                    inputMode="decimal"
                    defaultValue={
                      editingReceivable?.accrualAmountCents === undefined
                        ? ''
                        : (editingReceivable.accrualAmountCents / 100).toFixed(2)
                    }
                  />
                </Field>
                <Field
                  label="First balance increase date"
                  hint="When a current balance is entered, past increases are assumed to be reflected in it."
                >
                  <Input
                    name="accrualDate"
                    type="date"
                    defaultValue={editingReceivable?.accrualDate ?? ''}
                  />
                </Field>
                <Field label="Balance increase repeats">
                  <Select
                    name="accrualFrequency"
                    defaultValue={editingReceivable?.accrualRecurrenceRule?.frequency ?? 'none'}
                  >
                    <option value="none">Does not automatically increase</option>
                    <option value="once">One-time balance increase</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every two weeks</option>
                    <option value="monthly">Monthly</option>
                    {editingReceivable?.accrualRecurrenceRule?.frequency === 'semimonthly' && (
                      <option value="semimonthly">
                        Twice monthly (preserve existing schedule)
                      </option>
                    )}
                  </Select>
                </Field>
              </div>
            </div>
            <Field label="Notes (optional)">
              <Textarea name="notes" defaultValue={editingReceivable?.notes ?? ''} />
            </Field>
            <div className={styles.actions}>
              <Button appearance="primary" type="submit" disabled={receivableAction !== null}>
                {receivableAction === 'save' ? 'Saving…' : 'Save money-owed record'}
              </Button>
              <Button type="button" onClick={() => setEditingReceivableId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {settleableReceivables.length > 0 && (
        <Card className={styles.panel}>
          <div className={styles.sectionIntro}>
            <Title2 as="h2">Record money received</Title2>
            <Text>
              Release an owed amount only when cash actually arrives, then choose the checking
              account that received it. The owed balance falls and cash rises exactly once.
            </Text>
          </div>
          <form className={styles.form} onSubmit={(event) => void settle(event)}>
            <div className={styles.grid}>
              <Field label="Balance or recurring receipt">
                <Select
                  name="receivableId"
                  value={settlementReceivable?.id ?? ''}
                  onChange={(_, data) => setSettlementReceivableId(data.value)}
                >
                  {settleableReceivables.map((receivable) => (
                    <option value={receivable.id} key={receivable.id}>
                      {receivable.source}: {receivable.description} ·{' '}
                      {(currentOwedById.get(receivable.id) ?? receivable.remainingAmountCents) > 0
                        ? `${formatMoney(currentOwedById.get(receivable.id) ?? receivable.remainingAmountCents)} owed now`
                        : `${formatMoney(receivable.recurringAmountCents ?? 0)} each occurrence`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount received">
                <Input name="amount" inputMode="decimal" required />
              </Field>
              <Field label="Date received">
                <Input name="date" type="date" defaultValue={today} max={today} required />
              </Field>
              <Field label="Release into">
                <Select
                  name="destinationAccountId"
                  key={`${settlementReceivable?.id ?? 'none'}-destination`}
                  defaultValue={
                    settlementReceivable?.destinationAccountId ?? records.accounts[0]?.id ?? ''
                  }
                  required
                >
                  {records.accounts.map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {settlementReceivable && hasRecurringReceivableSchedule(settlementReceivable) && (
                <Field
                  label="Installment this receipt settles"
                  hint="Choose the scheduled installment explicitly when cash arrives early, late, or in partial amounts."
                >
                  <Select
                    key={settlementReceivable.id}
                    name="occurrenceDate"
                    defaultValue={defaultSettlementOccurrence}
                    required
                  >
                    {settlementOccurrences.map((date) => (
                      <option key={date} value={date}>
                        Scheduled for {date}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <Button appearance="primary" type="submit" disabled={receivableAction !== null}>
              {receivableAction === 'settle' ? 'Releasing…' : 'Release to checking'}
            </Button>
          </form>
        </Card>
      )}
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Open balances</Title2>
          <Text>Only these amounts count as money currently owed to you.</Text>
        </div>
        {openReceivables.length === 0 ? (
          <Text>No unsettled balances.</Text>
        ) : (
          <div className={styles.recordGrid}>
            {openReceivables.map((receivable) => {
              const destination = records.accounts.find(
                (account) => account.id === receivable.destinationAccountId,
              );
              const currentOutstanding =
                currentOwedById.get(receivable.id) ?? receivable.remainingAmountCents;
              const plannedCashReceipt = nextPlannedReceiptFor(receivable);
              const plannedOwedReductionCents = plannedCashReceipt
                ? plannedOwedReductionFor(receivable, plannedCashReceipt.date)
                : undefined;
              const nextScheduledReceipt = hasRecurringReceivableSchedule(receivable)
                ? receiptDatesThrough(receivable, addDays(today, 800)).find(
                    (date) => compareDates(date, today) >= 0,
                  )
                : receivable.expectedDate;
              const overdue =
                receivable.settlementDateConfirmed !== false &&
                !hasRecurringReceivableSchedule(receivable) &&
                receivable.expectedDate < today;
              return (
                <Card className={styles.recordCard} key={receivable.id}>
                  <div className={styles.compact}>
                    <Text className={styles.eyebrow}>
                      {overdue ? 'Overdue open balance' : 'Open balance'}
                    </Text>
                    <strong>{receivable.description}</strong>
                    <Text className={styles.amount}>{formatMoney(currentOutstanding)}</Text>
                  </div>
                  <div className={styles.recordFacts}>
                    <div className={styles.recordFact}>
                      <Text size={200} className={styles.muted}>
                        Originally owed
                      </Text>
                      <strong>{formatMoney(receivable.originalAmountCents)}</strong>
                    </div>
                    <div className={styles.recordFact}>
                      <Text size={200} className={styles.muted}>
                        From
                      </Text>
                      <strong>{receivable.source}</strong>
                    </div>
                    <div className={styles.recordFact}>
                      <Text size={200} className={styles.muted}>
                        Expected timing
                      </Text>
                      <strong>
                        {receivableExpectedTimingText({
                          expectedDate: receivable.expectedDate,
                          nextScheduledReceipt,
                          settlementDateConfirmed: receivable.settlementDateConfirmed,
                        })}
                      </strong>
                    </div>
                    <div className={styles.recordFact}>
                      <Text size={200} className={styles.muted}>
                        Deposit to
                      </Text>
                      <strong>{destination?.name ?? 'Missing account'}</strong>
                    </div>
                  </div>
                  {plannedCashReceipt && plannedOwedReductionCents !== undefined ? (
                    <Text className={styles.positive}>
                      {scheduledReceivableEffectText({
                        date: plannedCashReceipt.date,
                        accountName: destination?.name ?? 'Missing account',
                        cashAmountCents: plannedCashReceipt.amountCents,
                        owedReductionCents: plannedOwedReductionCents,
                      })}
                    </Text>
                  ) : plannedCashReceipt ? (
                    <Text className={styles.positive}>
                      {`Scheduled cash on ${plannedCashReceipt.date}: +${formatMoney(
                        plannedCashReceipt.amountCents,
                      )} to ${destination?.name ?? 'Missing account'}. The matching Money Owed effect is unavailable.`}
                    </Text>
                  ) : (
                    <Text className={styles.muted}>
                      {receivable.includeInCashForecast === false
                        ? 'Held in Money Owed until you release the amount to a checking account.'
                        : 'No automatic cash release could be generated; review its date, destination, and confidence.'}
                    </Text>
                  )}
                  <Text className={styles.muted}>Confidence: {receivable.certainty}</Text>
                  {(receivable.relatedExpenseId || receivable.paymentInstrument) && (
                    <Text className={styles.muted}>
                      Related expense: {relatedExpenseName(receivable.relatedExpenseId)} · Payment
                      instrument: {paymentInstrumentName(receivable.paymentInstrument)}
                    </Text>
                  )}
                  {(receivable.grossExpenseCents !== undefined ||
                    receivable.userEconomicShareCents !== undefined) && (
                    <Text className={styles.muted}>
                      Shared-expense context: full expense{' '}
                      {receivable.grossExpenseCents === undefined
                        ? 'not entered'
                        : formatMoney(receivable.grossExpenseCents)}{' '}
                      · your final share{' '}
                      {receivable.userEconomicShareCents === undefined
                        ? 'not entered'
                        : formatMoney(receivable.userEconomicShareCents)}
                      . These explain the reimbursement and do not create extra cash.
                    </Text>
                  )}
                  <Button onClick={() => beginReceivableEdit(receivable.id)}>
                    Edit open balance
                  </Button>
                </Card>
              );
            })}
          </div>
        )}
      </Card>
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Recurring future receivables</Title2>
          <Text>
            These simple schedules are not part of today&apos;s Settle Up balance. Each occurrence
            becomes Money Owed on its date, then waits for you to release it to checking.
          </Text>
        </div>
        {recurringReceivables.length === 0 ? (
          <Text>No recurring future receivables.</Text>
        ) : (
          <div className={styles.recordGrid}>
            {recurringReceivables.map((receivable) => {
              const destination = records.accounts.find(
                (account) => account.id === receivable.destinationAccountId,
              );
              const nextScheduledReceipt = receiptDatesThrough(
                receivable,
                addDays(today, 800),
              ).find((date) => compareDates(date, today) >= 0);
              const anchorEvent = records.events.find(
                (event) => event.id === receivable.settlementAnchorEventId,
              );
              const offsetDays = receivable.settlementOffsetDays ?? 0;
              const timingLabel = anchorEvent
                ? billRelativeReceiptTimingLabel(offsetDays, anchorEvent.label)
                : (receivable.recurrenceRule?.frequency ?? 'repeating');
              return (
                <Card className={styles.recordCard} key={receivable.id}>
                  <Text className={styles.eyebrow}>Recurring schedule</Text>
                  <strong>{receivable.description}</strong>
                  <Text className={styles.amount}>
                    {formatMoney(receivable.recurringAmountCents ?? 0)} per receipt
                  </Text>
                  <Text>{timingLabel}</Text>
                  <Text className={styles.muted}>
                    Next {nextScheduledReceipt ?? 'No future occurrence'} ·{' '}
                    {destination?.name ?? 'missing account'} ·{' '}
                    {receivable.includeInCashForecast === false
                      ? 'held as Money Owed until released'
                      : `${receivable.certainty} automatic cash release`}
                  </Text>
                  {(receivable.relatedExpenseId || receivable.paymentInstrument) && (
                    <Text className={styles.muted}>
                      Related expense: {relatedExpenseName(receivable.relatedExpenseId)} · Payment
                      instrument: {paymentInstrumentName(receivable.paymentInstrument)}
                    </Text>
                  )}
                  {(receivable.grossExpenseCents !== undefined ||
                    receivable.userEconomicShareCents !== undefined) && (
                    <Text className={styles.muted}>
                      Full shared expense{' '}
                      {receivable.grossExpenseCents === undefined
                        ? 'not entered'
                        : formatMoney(receivable.grossExpenseCents)}{' '}
                      · your share{' '}
                      {receivable.userEconomicShareCents === undefined
                        ? 'not entered'
                        : formatMoney(receivable.userEconomicShareCents)}
                    </Text>
                  )}
                  <Button onClick={() => beginReceivableEdit(receivable.id)}>
                    Edit recurring receivable
                  </Button>
                </Card>
              );
            })}
          </div>
        )}
      </Card>
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Future owed-balance changes</Title2>
          <Text>
            These schedules explain when a shared cost becomes newly owed. They change the
            receivable balance only and never add cash by themselves.
          </Text>
        </div>
        {accruingReceivables.length === 0 ? (
          <Text>No automatic owed-balance increases.</Text>
        ) : (
          <div className={styles.recordGrid}>
            {accruingReceivables.map((receivable) => (
              <Card className={styles.recordCard} key={receivable.id}>
                <Text className={styles.eyebrow}>Balance growth schedule</Text>
                <strong>{receivable.description}</strong>
                <Text className={styles.amount}>
                  +{formatMoney(receivable.accrualAmountCents ?? 0)}{' '}
                  {receivable.accrualRecurrenceRule?.frequency}
                </Text>
                <Text className={styles.muted}>
                  First increase {receivable.accrualDate ?? 'date missing'} · affects money owed,
                  not cash
                </Text>
                <Button onClick={() => beginReceivableEdit(receivable.id)}>
                  Edit balance schedule
                </Button>
              </Card>
            ))}
          </div>
        )}
      </Card>
      <Card className={styles.panel}>
        <details>
          <summary>Settlement history ({settlementHistory.length})</summary>
          {settlementHistory.length === 0 ? (
            <p>
              <Text>No linked settlements recorded.</Text>
            </p>
          ) : (
            <div className={styles.rows}>
              {settlementHistory.map((settlement) => {
                const destination = records.accounts.find(
                  (account) => account.id === settlement.accountId,
                );
                return (
                  <div className={styles.row} key={settlement.id}>
                    <div>
                      <strong>{settlement.label}</strong>
                      <br />
                      <Text>
                        {settlement.date} · {settlement.status} · deposited to{' '}
                        {destination?.name ?? 'missing account'}
                        {settlement.receivableOccurrenceDate
                          ? ` · installment scheduled ${settlement.receivableOccurrenceDate}`
                          : ''}
                      </Text>
                    </div>
                    <Text>{formatMoney(settlement.amountCents)}</Text>
                  </div>
                );
              })}
            </div>
          )}
        </details>
      </Card>
    </>
  );
};

export const NetWorthPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | 'new' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assetEditorRef = useEditorReveal<HTMLDivElement>(editingAssetId);
  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loadedRecords, forecast]) => {
        setRecords(loadedRecords);
        if (!forecast.ok) throw new Error(forecast.error);
        setSnapshot(forecast.value);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);
  const asOfDate = snapshot?.startDate ?? Temporal.Now.plainDateISO().toString();
  const effectiveAssets = useMemo(
    () =>
      records
        ? effectiveAssetsForDate({
            assets: records.assets,
            plans: records.committedRefinancePlans,
            date: asOfDate,
          })
        : [],
    [asOfDate, records],
  );
  const effectiveLoans = useMemo(
    () =>
      records
        ? activeLoansForDate({
            accounts: records.accounts,
            loans: records.loans,
            plans: records.committedRefinancePlans,
            loanPaymentEvents: records.events,
            date: asOfDate,
          })
        : [],
    [asOfDate, records],
  );
  const locallyRecordedRevolvingDebtCents = useMemo(
    () =>
      records
        ? records.cards.reduce(
            (total, card) =>
              total +
              summarizeRevolvingDebt({
                card,
                cycles: records.cardCycles,
                asOfDate,
                events: records.events,
              }).currentBalanceCents,
            0,
          )
        : 0,
    [asOfDate, records],
  );
  // The snapshot uses the exact same materialized event set as current cash,
  // including generated same-day payments. Keep both sides of net worth on one
  // timeline; the local value is only a loading/backward-compatibility fallback.
  const revolvingDebtCents = snapshot?.totalRevolvingDebtCents ?? locallyRecordedRevolvingDebtCents;
  const result = useMemo(
    () =>
      records
        ? (() => {
            return calculateNetWorth({
              cashAccounts: records.accounts,
              assets: effectiveAssets,
              receivables: records.receivables,
              loans: effectiveLoans,
              revolvingDebtCents,
              liquidCashCentsOverride: snapshot?.currentConsolidatedCashCents,
              allCashCentsOverride: snapshot?.currentAllCashCents,
              receivablesCentsOverride: snapshot?.currentReceivableCents,
              restrictedRefinanceSettlementCents: pendingRefinanceSettlementCentsForDate({
                plans: records.committedRefinancePlans,
                date: asOfDate,
              }),
              economicRestrictedRefinanceSettlementCents:
                pendingRefinanceEconomicSettlementCentsForDate({
                  plans: records.committedRefinancePlans,
                  loans: records.loans,
                  date: asOfDate,
                }),
            });
          })()
        : null,
    [asOfDate, effectiveAssets, effectiveLoans, records, revolvingDebtCents, snapshot],
  );
  if (!result || !records || !snapshot)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Calculating net worth" variant="dashboard" />
    );
  const editingAsset =
    editingAssetId && editingAssetId !== 'new'
      ? effectiveAssets.find((asset) => asset.id === editingAssetId)
      : undefined;
  const persistedEditingAsset = editingAsset
    ? records.assets.find((asset) => asset.id === editingAsset.id)
    : undefined;
  const saveAsset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = persistedEditingAsset
      ? (makeEditRequest('asset', persistedEditingAsset).payload as Record<string, unknown>)
      : {};
    const enteredLinkedLiabilityId = get(form, 'linkedLiabilityId') || undefined;
    const linkedLiabilityId =
      persistedEditingAsset && enteredLinkedLiabilityId === editingAsset?.linkedLiabilityId
        ? persistedEditingAsset.linkedLiabilityId
        : enteredLinkedLiabilityId;
    const response = await window.balanceBook.upsertRecord({
      entityType: 'asset',
      payload: {
        ...existing,
        id: editingAsset?.id ?? crypto.randomUUID(),
        name: get(form, 'name'),
        type: get(form, 'assetType'),
        valueCents: cents(form, 'value'),
        valuationDate: get(form, 'valuationDate'),
        contributionAmountCents: optionalCents(form, 'contributionAmount'),
        contributionRateBasisPoints: optionalBasisPoints(form, 'contributionRate'),
        employerMatchBasisPoints: optionalBasisPoints(form, 'employerMatch'),
        restrictionStatus: get(form, 'restrictionStatus') || undefined,
        linkedLiabilityId,
        includedInNetWorth: form.get('includedInNetWorth') === 'on',
        includedInLiquidity: form.get('includedInLiquidity') === 'on',
      },
    } as UpsertManagedEntityRequest);
    if (response.ok) {
      setRecords(response.value);
      setEditingAssetId(null);
      setMessage(editingAsset ? 'Asset updated.' : 'Asset added to net worth.');
      setError(null);
    } else setError(response.error);
  };
  const removeAsset = async (assetId: string) => {
    if (!window.confirm('Delete this asset?')) return;
    const response = await window.balanceBook.deleteRecord({
      entityType: 'asset',
      entityId: assetId,
      confirmed: true,
    });
    if (response.ok) {
      setRecords(response.value);
      setMessage('Asset deleted.');
      setError(null);
    } else setError(response.error);
  };
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Net worth</Title1>
        <Text>
          Add investments, vehicles, property, and other assets here. Cash is managed through cash
          accounts; noncash assets improve net worth but are not spending money by default.
        </Text>
      </div>
      {(message || error) && (
        <Card className={styles.panel}>
          {message && (
            <div role="status" className={styles.positive}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" className={styles.error}>
              {error}
            </div>
          )}
        </Card>
      )}
      <section className={styles.metrics}>
        <Card className={styles.metric}>
          <Text>Liquid net position</Text>
          <Text className={styles.value}>{formatMoney(result.liquidNetPositionCents)}</Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Contractual net worth</Text>
          <Text className={styles.value}>{formatMoney(result.contractualNetWorthCents)}</Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Economic net worth</Text>
          <Text className={styles.value}>{formatMoney(result.economicNetWorthCents)}</Text>
        </Card>
        <Card className={styles.metric}>
          <Text>Contractual liabilities</Text>
          <Text className={styles.value}>{formatMoney(result.contractualLiabilitiesCents)}</Text>
          <Text className={styles.muted}>
            Installment{' '}
            {formatMoney(
              effectiveLoans.reduce(
                (total, loan) => total + loan.principalCents + loan.accruedInterestCents,
                0,
              ),
            )}{' '}
            · revolving {formatMoney(revolvingDebtCents)}
          </Text>
        </Card>
      </section>
      {(snapshot.restrictedRefinanceSettlementCents ?? 0) > 0 && (
        <Card className={styles.panel}>
          <Title2 as="h2">Lender payoff is still settling</Title2>
          <Text>
            {formatMoney(snapshot.restrictedRefinanceSettlementCents ?? 0)} is restricted with the
            lenders between refinance closing and payoff. It offsets the temporary overlap in old
            and new loan liabilities, but it is not spendable cash.
          </Text>
        </Card>
      )}
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">What the totals mean</Title2>
          <Text>
            Liquid position uses cash and only assets explicitly marked liquid. Contractual net
            worth then adds included assets and open receivables and subtracts loan obligations.
            Economic net worth applies each loan's double-count treatment.
          </Text>
        </div>
        <div className={styles.actions}>
          <Button appearance="primary" onClick={() => setEditingAssetId('new')}>
            Add asset or investment
          </Button>
          <Button onClick={() => navigate('/records?type=cash-account')}>
            Edit cash accounts and liabilities
          </Button>
        </div>
      </Card>
      {editingAssetId && (
        <Card
          ref={assetEditorRef}
          className={`${styles.panel} balance-editor-reveal`}
          tabIndex={-1}
          aria-labelledby="asset-editor-title"
        >
          <form
            key={editingAsset?.id ?? 'new-asset'}
            className={styles.form}
            onSubmit={(event) => void saveAsset(event)}
          >
            <Title2 id="asset-editor-title" as="h2">
              {editingAsset ? `Edit ${editingAsset.name}` : 'Add an asset'}
            </Title2>
            <div className={styles.grid}>
              <Field label="Asset name">
                <Input name="name" required defaultValue={editingAsset?.name} />
              </Field>
              <Field label="Asset type">
                <Select name="assetType" defaultValue={editingAsset?.type ?? 'investment'}>
                  <option value="investment">Investment</option>
                  <option value="tangible">Vehicle, property, or tangible asset</option>
                  <option value="other">Other asset</option>
                </Select>
              </Field>
              <Field label="Current value">
                <Input
                  name="value"
                  inputMode="decimal"
                  required
                  defaultValue={editingAsset ? (editingAsset.valueCents / 100).toFixed(2) : '0.00'}
                />
              </Field>
              <Field label="Value as of">
                <Input
                  name="valuationDate"
                  type="date"
                  required
                  defaultValue={
                    editingAsset?.valuationDate ?? Temporal.Now.plainDateISO().toString()
                  }
                />
              </Field>
              <Field label="Contribution amount (optional)">
                <Input
                  name="contributionAmount"
                  inputMode="decimal"
                  defaultValue={centsInput(editingAsset?.contributionAmountCents)}
                />
              </Field>
              <Field label="Contribution rate % (optional)">
                <Input
                  name="contributionRate"
                  inputMode="decimal"
                  defaultValue={
                    editingAsset?.contributionRateBasisPoints === undefined
                      ? ''
                      : (editingAsset.contributionRateBasisPoints / 100).toFixed(2)
                  }
                />
              </Field>
              <Field label="Employer match % (optional)">
                <Input
                  name="employerMatch"
                  inputMode="decimal"
                  defaultValue={
                    editingAsset?.employerMatchBasisPoints === undefined
                      ? ''
                      : (editingAsset.employerMatchBasisPoints / 100).toFixed(2)
                  }
                />
              </Field>
              <Field label="Access restriction (optional)">
                <Select
                  name="restrictionStatus"
                  defaultValue={editingAsset?.restrictionStatus ?? ''}
                >
                  <option value="">Not entered</option>
                  <option value="unrestricted">Unrestricted</option>
                  <option value="partially-restricted">Partially restricted</option>
                  <option value="restricted">Restricted</option>
                  <option value="unknown">Unknown</option>
                </Select>
              </Field>
              <Field label="Linked liability (optional)">
                <Select
                  name="linkedLiabilityId"
                  defaultValue={editingAsset?.linkedLiabilityId ?? ''}
                >
                  <option value="">None</option>
                  {effectiveLoans.map((loan) => (
                    <option key={loan.id} value={loan.id}>
                      {loan.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Checkbox
              name="includedInNetWorth"
              defaultChecked={editingAsset?.includedInNetWorth ?? true}
              label="Include this asset in net worth"
            />
            <Checkbox
              name="includedInLiquidity"
              defaultChecked={editingAsset?.includedInLiquidity ?? false}
              label="Treat as immediately available liquidity (uncommon; do not use for ordinary investments)"
            />
            <div className={styles.actions}>
              <Button appearance="primary" type="submit">
                Save asset
              </Button>
              <Button type="button" onClick={() => setEditingAssetId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Cash accounts</Title2>
          <Text>
            Cash belongs to the cash forecast and is shown separately from noncash assets.
          </Text>
        </div>
        <div className={styles.recordGrid}>
          {records.accounts.map((account) => {
            const cashBalance = netWorthCashBalance(account, snapshot.cashAccounts);
            return (
              <Card className={styles.recordCard} key={account.id}>
                <Text className={styles.eyebrow}>{account.type}</Text>
                <strong>{account.name}</strong>
                <Text className={styles.amount}>{formatMoney(cashBalance.balanceCents)}</Text>
                <Text className={styles.muted}>
                  {!cashBalance.modeled
                    ? `Source balance as of ${account.balanceAsOf}`
                    : `Modeled current balance${snapshot.startDate ? ` on ${snapshot.startDate}` : ''}`}
                </Text>
                {cashBalance.modeled && (
                  <Text className={styles.muted}>
                    Source balance: {formatMoney(account.openingBalanceCents)} as of{' '}
                    {account.balanceAsOf}
                  </Text>
                )}
                {account.availableBalanceCents !== undefined && (
                  <Text className={styles.muted}>
                    Available balance: {formatMoney(account.availableBalanceCents)} (informational)
                  </Text>
                )}
                {account.notes && <Text className={styles.muted}>{account.notes}</Text>}
                <Button onClick={() => navigate('/records?type=cash-account')}>
                  Edit cash account
                </Button>
              </Card>
            );
          })}
        </div>
      </Card>
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Noncash assets and investments</Title2>
          <Text>
            Keep values current and dated. These affect net worth; they affect liquidity only when
            explicitly marked immediately available.
          </Text>
        </div>
        {effectiveAssets.length === 0 ? (
          <Text>No noncash assets have been added.</Text>
        ) : (
          <div className={styles.recordGrid}>
            {effectiveAssets.map((asset) => (
              <Card className={styles.recordCard} key={asset.id}>
                <Text className={styles.eyebrow}>{asset.type}</Text>
                <strong>{asset.name}</strong>
                <Text className={styles.amount}>{formatMoney(asset.valueCents)}</Text>
                <Text className={styles.muted}>
                  Value as of {asset.valuationDate} ·{' '}
                  {asset.includedInNetWorth ? 'included in net worth' : 'tracked only'} ·{' '}
                  {asset.includedInLiquidity ? 'included in liquidity' : 'noncash'}
                </Text>
                {(asset.contributionAmountCents !== undefined ||
                  asset.contributionRateBasisPoints !== undefined ||
                  asset.employerMatchBasisPoints !== undefined) && (
                  <Text className={styles.muted}>
                    Contributions:{' '}
                    {asset.contributionAmountCents === undefined
                      ? 'amount not entered'
                      : formatMoney(asset.contributionAmountCents)}
                    {asset.contributionRateBasisPoints === undefined
                      ? ''
                      : ` · ${(asset.contributionRateBasisPoints / 100).toFixed(2)}%`}
                    {asset.employerMatchBasisPoints === undefined
                      ? ''
                      : ` · ${(asset.employerMatchBasisPoints / 100).toFixed(2)}% employer match`}
                  </Text>
                )}
                <Text className={styles.muted}>
                  Access: {asset.restrictionStatus?.replaceAll('-', ' ') ?? 'not entered'} · Linked
                  liability:{' '}
                  {effectiveLoans.find((loan) => loan.id === asset.linkedLiabilityId)?.name ??
                    records.loans.find((loan) => loan.id === asset.linkedLiabilityId)?.name ??
                    'none'}
                </Text>
                <div className={styles.actions}>
                  <Button onClick={() => setEditingAssetId(asset.id)}>Edit asset</Button>
                  <Button onClick={() => void removeAsset(asset.id)}>Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
      <Card className={styles.panel}>
        <Title2 as="h2">Included record counts</Title2>
        <p>
          {records.accounts.length} cash accounts · {records.assets.length} assets ·{' '}
          {records.receivables.length} receivables · {records.loans.length} loans
        </p>
      </Card>
    </>
  );
};

export { RefinancePlannerPage as RefinancePage } from './RefinancePlannerPage';

export const ReconciliationPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const navigate = useNavigate();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [forecastBalance, setForecastBalance] = useState('');
  const [forecastBalanceOverridden, setForecastBalanceOverridden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([loadRecords(), window.balanceBook.getForecast()])
      .then(([loadedRecords, forecast]) => {
        setRecords(loadedRecords);
        const initialAccountId = loadedRecords.accounts[0]?.id ?? '';
        setSelectedAccountId(initialAccountId);
        if (forecast.ok) {
          setSnapshot(forecast.value);
          const initialDate = forecast.value.startDate || Temporal.Now.plainDateISO().toString();
          setSelectedDate(initialDate);
          const initialExpectedBalance = expectedAccountBalanceOn(
            forecast.value,
            initialAccountId,
            initialDate,
          );
          setForecastBalance(
            initialExpectedBalance === undefined ? '' : centsInput(initialExpectedBalance),
          );
        } else {
          setSelectedDate(Temporal.Now.plainDateISO().toString());
          setError(forecast.error);
        }
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (!records)
    return error ? (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    ) : (
      <LoadingSkeleton label="Loading reconciliation" variant="form" />
    );
  const expectedBalance = expectedAccountBalanceOn(snapshot, selectedAccountId, selectedDate);
  const reconciliationIncomePlans = summarizeIncomePlans(records.events);
  const reconciliationIncomeStreams = summarizeBaseIncomeStreams(reconciliationIncomePlans);
  const reconciliationAsOfDate = snapshot?.startDate ?? selectedDate;
  const currentIncomePhases = reconciliationIncomeStreams.map((stream) => ({
    stream,
    phase: effectiveIncomePhase(stream, reconciliationAsOfDate),
  }));
  const reconciliationGroupedIncomeEventIds = new Set(
    reconciliationIncomeStreams.flatMap((stream) =>
      incomeStreamMemberEvents(records.events, reconciliationIncomePlans, stream).map(
        (event) => event.id,
      ),
    ),
  );
  const updateEventStatus = async (event: ForecastEvent, status: ForecastEvent['status']) => {
    setError(null);
    setMessage(null);
    try {
      const response = await window.balanceBook.upsertRecord(
        makeEditRequest('forecast-event', {
          ...event,
          status,
          certainty: status === 'confirmed' || status === 'paid' ? 'confirmed' : event.certainty,
        }),
      );
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      const refreshedForecast = await window.balanceBook.getForecast();
      if (!refreshedForecast.ok) throw new Error(refreshedForecast.error);
      setSnapshot(refreshedForecast.value);
      if (!forecastBalanceOverridden && selectedAccountId && selectedDate) {
        const refreshedExpectedBalance = expectedAccountBalanceOn(
          refreshedForecast.value,
          selectedAccountId,
          selectedDate,
        );
        setForecastBalance(
          refreshedExpectedBalance === undefined ? '' : centsInput(refreshedExpectedBalance),
        );
      }
      setMessage('Event status and the displayed forecast are now up to date.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Event status could not be updated.');
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const forecast = cents(form, 'forecast');
    const actual = cents(form, 'actual');
    setError(null);
    setMessage(null);
    const response = await window.balanceBook.upsertRecord({
      entityType: 'reconciliation',
      payload: {
        id: crypto.randomUUID(),
        accountId: get(form, 'accountId'),
        date: get(form, 'date'),
        forecastBalanceCents: forecast,
        actualBalanceCents: actual,
        varianceCents: actual - forecast,
        resolution: get(form, 'resolution') as 'unresolved' | 'explained' | 'adjusted',
        note: get(form, 'note') || undefined,
      },
    });
    if (response.ok) {
      setRecords(response.value);
      setMessage(
        'Balance check saved. It preserves the comparison but does not move cash or rewrite the forecast.',
      );
    } else setError(response.error);
  };
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Reconciliation</Title1>
        <Text>
          A compact source-of-truth check for today. Use the manual balance check only when a bank
          or issuer disagrees with the model.
        </Text>
      </div>
      <section className={styles.summaryStrip} aria-label="Current reconciliation facts">
        {records.accounts.map((account) => {
          const modeled = snapshot?.cashAccounts?.find((item) => item.id === account.id);
          return (
            <Card className={styles.summaryTile} key={`cash:${account.id}`}>
              <Text className={styles.eyebrow}>Checking · {account.name}</Text>
              <Text className={styles.amount}>
                {formatMoney(modeled?.balanceCents ?? account.openingBalanceCents)}
              </Text>
              <Text className={styles.muted}>As of {reconciliationAsOfDate}</Text>
            </Card>
          );
        })}
        {records.cards.map((card) => {
          const debt = snapshot?.revolvingDebtByCard?.find((item) => item.cardId === card.id);
          const latestStatement = latestClosedStatementForReconciliation({
            cardId: card.id,
            asOfDate: reconciliationAsOfDate,
            cycles: records.cardCycles,
            modeled: debt,
          });
          return (
            <Card className={styles.summaryTile} key={`card:${card.id}`}>
              <Text className={styles.eyebrow}>Card · {card.name}</Text>
              <Text className={styles.amount}>
                {debt ? formatMoney(debt.currentBalanceCents) : 'Refresh needed'}
              </Text>
              <Text className={styles.muted}>Current balance</Text>
              <Text className={styles.muted}>
                Current due: {debt ? formatMoney(debt.amountCurrentlyDueCents) : 'No model'}
              </Text>
              <Text className={styles.muted}>
                {latestStatement
                  ? `Latest closed statement: ${formatMoney(latestStatement.amountCents)} · ${formatPlainDate(latestStatement.date)}`
                  : 'No closed statement recorded'}
              </Text>
            </Card>
          );
        })}
        {currentIncomePhases.flatMap(({ stream, phase }) =>
          phase.events.map((incomeEvent) => (
            <Card className={styles.summaryTile} key={`pay:${stream.id}:${incomeEvent.accountId}`}>
              <Text className={styles.eyebrow}>
                Paycheck ·{' '}
                {records.accounts.find((account) => account.id === incomeEvent.accountId)?.name ??
                  'Unknown account'}
              </Text>
              <Text className={styles.amount}>{formatMoney(incomeEvent.amountCents)}</Text>
              <Text className={styles.muted}>
                {Math.max(0, -(incomeEvent.incomeArrivalOffsetDays ?? 0))} day(s) early
              </Text>
            </Card>
          )),
        )}
      </section>
      <Card className={styles.panel}>
        <div className={styles.recordHeader}>
          <div className={styles.compact}>
            <Title2 as="h2">Manual tools</Title2>
            <Text className={styles.muted}>
              Rare corrections stay separate from the normal account, card, and income controls.
            </Text>
          </div>
          <Button
            appearance="primary"
            onClick={() => navigate('/records?type=forecast-event&mode=add')}
          >
            Add future entry
          </Button>
        </div>
      </Card>
      <details className={styles.disclosure}>
        <summary>Compare an actual balance</summary>
        <div>
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            {message && (
              <div role="status" className={styles.positive}>
                {message}
              </div>
            )}
            {error && (
              <div role="alert" className={styles.error}>
                {error}
              </div>
            )}
            <div className={styles.grid}>
              <Field label="Account">
                <Select
                  name="accountId"
                  value={selectedAccountId}
                  onChange={(_, data) => {
                    setSelectedAccountId(data.value);
                    setForecastBalanceOverridden(false);
                    const nextExpectedBalance = expectedAccountBalanceOn(
                      snapshot,
                      data.value,
                      selectedDate,
                    );
                    setForecastBalance(
                      nextExpectedBalance === undefined ? '' : centsInput(nextExpectedBalance),
                    );
                  }}
                  required
                >
                  {records.accounts.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date">
                <Input
                  name="date"
                  type="date"
                  value={selectedDate}
                  onChange={(_, data) => {
                    setSelectedDate(data.value);
                    setForecastBalanceOverridden(false);
                    const nextExpectedBalance = expectedAccountBalanceOn(
                      snapshot,
                      selectedAccountId,
                      data.value,
                    );
                    setForecastBalance(
                      nextExpectedBalance === undefined ? '' : centsInput(nextExpectedBalance),
                    );
                  }}
                  required
                />
              </Field>
              <Field
                label="Expected modeled balance"
                hint="Prefilled from the expected forecast for this account and date. You can override it to preserve the exact number you compared."
              >
                <Input
                  name="forecast"
                  inputMode="decimal"
                  value={forecastBalance}
                  onChange={(_, data) => {
                    setForecastBalance(data.value);
                    setForecastBalanceOverridden(true);
                  }}
                  required
                />
              </Field>
              <Field label="Actual balance">
                <Input name="actual" inputMode="decimal" required />
              </Field>
              <Field label="Resolution">
                <Select name="resolution">
                  <option value="unresolved">Unresolved</option>
                  <option value="explained">Explained</option>
                  <option value="adjusted">Marked adjusted elsewhere (record only)</option>
                </Select>
              </Field>
            </div>
            {expectedBalance === undefined && (
              <Text className={styles.warning}>
                This date/account is outside the available forecast. Enter the modeled balance you
                compared, or choose a date inside the current forecast horizon.
              </Text>
            )}
            <Field label="Note (optional)">
              <Textarea name="note" />
            </Field>
            <Button appearance="primary" type="submit">
              Save reconciliation
            </Button>
          </form>
        </div>
      </details>
      <details className={styles.disclosure}>
        <summary>Balance-check history ({records.reconciliations.length})</summary>
        <div>
          {records.reconciliations.length === 0 ? (
            <Text>No balance checks recorded yet.</Text>
          ) : (
            records.reconciliations.map((item) => (
              <p key={item.id}>
                <strong>{item.date}</strong> · variance {formatMoney(item.varianceCents)} ·{' '}
                {reconciliationResolutionLabel(item.resolution)}
              </p>
            ))
          )}
        </div>
      </details>
      <details className={styles.disclosure}>
        <summary>Resolve individual forecast events</summary>
        <div>
          <Text>
            Mark what actually happened while preserving the original event. Routed paychecks stay
            together on the Income page.
          </Text>
          <div className={styles.rows}>
            {reconciliationIncomeStreams.map((stream) => {
              const phase = effectiveIncomePhase(stream, selectedDate);
              return (
                <div className={styles.row} key={`income-stream:${stream.id}`}>
                  <div className={styles.compact}>
                    <strong>{incomeStreamTitle(stream, phase)}</strong>
                    <Text>
                      One income source ·{' '}
                      {formatMoney(
                        effectiveIncomeStreamTotalCents(
                          stream,
                          reconciliationIncomePlans,
                          selectedDate,
                        ),
                      )}{' '}
                      current take-home ({formatMoney(phase.totalCents)} base) ·{' '}
                      {incomePhaseAllocationLabel(phase, records.accounts)}
                    </Text>
                    <Text className={styles.muted}>
                      Status and routing apply to the linked paycheck plan, not one account leg.
                    </Text>
                  </div>
                  <Button onClick={() => navigate('/income')}>Manage paycheck</Button>
                </div>
              );
            })}
            {records.events
              .filter((event) => !reconciliationGroupedIncomeEventIds.has(event.id))
              .map((event) => (
                <div className={styles.row} key={event.id}>
                  <div>
                    <strong>{event.label}</strong>
                    <br />
                    <Text>
                      {event.date} · {formatMoney(event.amountCents)} · {event.status}
                    </Text>
                  </div>
                  <Select
                    aria-label={`Status for ${event.label}`}
                    value={event.status}
                    onChange={(_, data) =>
                      void updateEventStatus(event, data.value as ForecastEvent['status'])
                    }
                  >
                    <option value="planned">Planned</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="confirmed">Received/confirmed</option>
                    <option value="paid">Paid</option>
                    <option value="skipped">Skipped</option>
                    <option value="cancelled">Cancelled</option>
                  </Select>
                </div>
              ))}
          </div>
        </div>
      </details>
    </>
  );
};

export type DataAction = 'backup' | 'restore' | 'export' | 'import' | 'reset';

export const dataActionProgressMessage = (action: DataAction): string =>
  ({
    backup: 'Creating and verifying your encrypted portable backup...',
    restore: 'Validating and restoring your encrypted portable backup...',
    export: 'Preparing your JSON and CSV exports...',
    import: 'Validating and importing the selected JSON export...',
    reset: 'Resetting the active profile financial data...',
  })[action];

export const DataPage = (): React.JSX.Element => {
  const styles = useCoreStyles();
  const [records, setRecords] = useState<ManagedRecordsDto>();
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [backupPasswordConfirmation, setBackupPasswordConfirmation] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeDataActionRef = useRef<DataAction | null>(null);
  const [activeDataAction, setActiveDataAction] = useState<DataAction | null>(null);
  useEffect(() => {
    void window.balanceBook
      .listRecords()
      .then((result) => {
        if (result.ok) setRecords(result.value);
        else setPolicyError(result.error);
        setPolicyLoaded(true);
      })
      .catch((caught: unknown) => {
        setPolicyError(caught instanceof Error ? caught.message : 'Settings could not be loaded.');
        setPolicyLoaded(true);
      });
  }, []);
  const policy = records?.policy;
  const liquidAccounts = (records?.accounts ?? []).filter((account) => account.includedInLiquidity);
  const accountHardFloorTotalCents = liquidAccounts.reduce(
    (total, account) => total + (account.hardFloorCents ?? 0),
    0,
  );
  const hasPreferredAccountFloor = liquidAccounts.some(
    (account) => account.preferredFloorCents !== undefined,
  );
  const accountPreferredFloorTotalCents = hasPreferredAccountFloor
    ? liquidAccounts.reduce(
        (total, account) => total + (account.preferredFloorCents ?? account.hardFloorCents ?? 0),
        0,
      )
    : undefined;
  const effectiveHardFloorCents = Math.max(
    policy?.hardConsolidatedFloorCents ?? 0,
    accountHardFloorTotalCents,
  );
  const preferredCandidates = [
    policy?.preferredConsolidatedFloorCents,
    accountPreferredFloorTotalCents,
  ].filter((value): value is number => value !== undefined);
  const effectivePreferredFloorCents =
    preferredCandidates.length === 0
      ? undefined
      : Math.max(effectiveHardFloorCents, ...preferredCandidates);
  const updatePolicy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPolicyMessage(null);
    setPolicyError(null);
    const form = new FormData(event.currentTarget);
    const preferred = get(form, 'preferredFloor').trim();
    const result = await window.balanceBook.updateCashPolicy({
      hardConsolidatedFloorCents: cents(form, 'hardFloor'),
      preferredConsolidatedFloorCents: preferred ? dollarsToCents(preferred) : undefined,
      horizonDays: Number(get(form, 'horizonDays')),
      includeConfirmedReceivablesConservatively:
        form.get('includeConfirmedReceivablesConservatively') === 'on',
    });
    if (result.ok) {
      setRecords(result.value);
      setPolicyMessage('Forecast guardrails updated. The dashboard has been recalculated.');
    } else setPolicyError(result.error);
  };
  const updateAccountProtection = async (
    account: ManagedRecordsDto['accounts'][number],
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setAccountMessage(null);
    setAccountError(null);
    const form = new FormData(event.currentTarget);
    const hardFloorCents = optionalCents(form, 'accountHardFloor');
    const preferredFloorCents = optionalCents(form, 'accountPreferredFloor');
    if (preferredFloorCents !== undefined && preferredFloorCents < (hardFloorCents ?? 0)) {
      setAccountError(`${account.name}: preferred buffer cannot be below its minimum.`);
      return;
    }
    const result = await window.balanceBook.upsertRecord({
      entityType: 'cash-account',
      payload: {
        id: account.id,
        name: account.name,
        type: account.type,
        openingBalanceCents: account.openingBalanceCents,
        availableBalanceCents: account.availableBalanceCents,
        balanceAsOf: account.balanceAsOf,
        notes: account.notes,
        hardFloorCents,
        preferredFloorCents,
        transferDelayDays: Math.trunc(number(form, 'accountTransferDelay')),
        includedInLiquidity: form.get('accountIncludedInLiquidity') === 'on',
        canFundOtherAccounts: form.get('accountCanFund') === 'on',
        showOnOverview: form.get('accountShowOnOverview') === 'on',
      },
    });
    if (result.ok) {
      setRecords(result.value);
      setAccountMessage(
        `${account.name} protection updated. Global minimum and funding guidance were recalculated.`,
      );
    } else setAccountError(result.error);
  };
  const performDataAction = async (action: DataAction, operation: () => Promise<void>) => {
    if (activeDataActionRef.current !== null) return;
    activeDataActionRef.current = action;
    setActiveDataAction(action);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Data action failed');
    } finally {
      activeDataActionRef.current = null;
      setActiveDataAction(null);
    }
  };
  const run = async (action: Exclude<DataAction, 'reset'>) => {
    await performDataAction(action, async () => {
      const result =
        action === 'backup'
          ? await window.balanceBook.createBackup({ password })
          : action === 'restore'
            ? await window.balanceBook.restoreBackup({ password, confirmReplace: true })
            : action === 'import'
              ? await window.balanceBook.importJson({ confirmReplace: true })
              : await window.balanceBook.exportData();
      if (!result.ok) throw new Error(result.error);
      if (result.value.canceled) {
        setMessage('Canceled. No files changed.');
        return;
      }
      if (action === 'restore') {
        const refreshed = await window.balanceBook.listRecords();
        if (!refreshed.ok) throw new Error(refreshed.error);
        setRecords(refreshed.value);
        setConfirmReplace(false);
        setMessage(
          'Portable profile restored. Your local sign-in password stayed unchanged; forecasts now use the restored records.',
        );
      } else if (action === 'backup') {
        setMessage(
          'Encrypted portable profile created and read-back verified. Keep its separate backup password in your password manager.',
        );
      } else {
        setMessage(`${result.value.itemCount} item(s) written or restored.`);
      }
      if (action === 'import') setConfirmReplace(false);
      setPassword('');
      setBackupPasswordConfirmation('');
    });
  };
  const reset = async () => {
    await performDataAction('reset', async () => {
      const result = await window.balanceBook.resetUserData({
        confirmation: 'DELETE ACTIVE PROFILE DATA',
      });
      if (!result.ok) throw new Error(result.error);
      window.location.hash = '#/setup';
    });
  };
  const dataActionBusy = activeDataAction !== null;
  return (
    <>
      <div className={styles.header}>
        <Title1 as="h1">Settings</Title1>
        <Text>
          Balance Book {window.balanceBook.appVersion} is local-first, has no bank connection,
          telemetry, cloud dependency, or automatic financial action. Forecasts are models, not
          guarantees.
        </Text>
      </div>
      <Card className={styles.panel}>
        <Title2 as="h2">Forecast guardrails</Title2>
        <Text>
          Account minimums below automatically build your global protected floor. Use these
          consolidated values only when you want an additional whole-portfolio reserve. Changing
          either layer recalculates Overview, Cash Forecast, and Spending Power without changing any
          transaction.
        </Text>
        {!policyLoaded ? (
          <LoadingSkeleton label="Loading forecast guardrails" variant="inline-form" />
        ) : !records && policyError ? (
          <div role="alert" className={styles.error}>
            {policyError}
          </div>
        ) : policy ? (
          <form key={JSON.stringify(policy)} className={styles.form} onSubmit={updatePolicy}>
            {policyMessage && (
              <div role="status" className={styles.positive}>
                {policyMessage}
              </div>
            )}
            {policyError && (
              <div role="alert" className={styles.error}>
                {policyError}
              </div>
            )}
            <div className={styles.grid}>
              <Field
                label="Consolidated minimum override"
                hint="The app uses whichever is higher: this override or the sum of included account minimums."
              >
                <Input
                  name="hardFloor"
                  inputMode="decimal"
                  required
                  defaultValue={(policy.hardConsolidatedFloorCents / 100).toFixed(2)}
                />
              </Field>
              <Field
                label="Consolidated preferred override (optional)"
                hint="A portfolio-wide comfort buffer above the protected minimum."
              >
                <Input
                  name="preferredFloor"
                  inputMode="decimal"
                  defaultValue={
                    policy.preferredConsolidatedFloorCents === undefined
                      ? ''
                      : (policy.preferredConsolidatedFloorCents / 100).toFixed(2)
                  }
                />
              </Field>
              <Field label="Forecast horizon in days">
                <Input
                  name="horizonDays"
                  type="number"
                  min="1"
                  max="730"
                  required
                  defaultValue={String(policy.horizonDays)}
                />
              </Field>
            </div>
            <Checkbox
              name="includeConfirmedReceivablesConservatively"
              defaultChecked={policy.includeConfirmedReceivablesConservatively}
              label="Include confirmed money-received schedules in the conservative cash forecast"
            />
            <Button appearance="primary" type="submit">
              Save forecast guardrails
            </Button>
          </form>
        ) : (
          <Text>Complete first forecast setup before editing guardrails.</Text>
        )}
      </Card>
      <Card className={styles.panel}>
        <div className={styles.sectionIntro}>
          <Title2 as="h2">Account protection and transfer timing</Title2>
          <Text>
            Set the balance each account must stay above. Included account minimums automatically
            populate the global protected floor; preferred buffers drive the earlier warning line.
            Transfer lead time tells funding guidance how soon money must leave a source account.
          </Text>
        </div>
        {accountMessage && (
          <div role="status" className={styles.positive}>
            {accountMessage}
          </div>
        )}
        {accountError && (
          <div role="alert" className={styles.error}>
            {accountError}
          </div>
        )}
        {records ? (
          <>
            <section className={styles.metrics} aria-label="Effective cash protection">
              <Card className={styles.metric}>
                <Text className={styles.eyebrow}>Included account minimums</Text>
                <Text className={styles.value}>{formatMoney(accountHardFloorTotalCents)}</Text>
                <Text>{liquidAccounts.length} liquid account(s)</Text>
              </Card>
              <Card className={styles.metric}>
                <Text className={styles.eyebrow}>Consolidated override</Text>
                <Text className={styles.value}>
                  {formatMoney(policy?.hardConsolidatedFloorCents ?? 0)}
                </Text>
                <Text>The higher layer wins</Text>
              </Card>
              <Card className={styles.metric}>
                <Text className={styles.eyebrow}>Effective global minimum</Text>
                <Text className={styles.value}>{formatMoney(effectiveHardFloorCents)}</Text>
                <Text>
                  Preferred warning{' '}
                  {effectivePreferredFloorCents === undefined
                    ? 'not set'
                    : formatMoney(effectivePreferredFloorCents)}
                </Text>
              </Card>
            </section>
            <div className={styles.recordGrid}>
              {records.accounts.map((account) => (
                <form
                  key={`${account.id}:${account.hardFloorCents ?? ''}:${account.preferredFloorCents ?? ''}:${account.transferDelayDays}:${account.includedInLiquidity}:${account.canFundOtherAccounts}:${account.showOnOverview}`}
                  aria-label={`${account.name} protection settings`}
                  className={styles.formSection}
                  onSubmit={(event) => void updateAccountProtection(account, event)}
                >
                  <div className={styles.compact}>
                    <strong>{account.name}</strong>
                    <Text className={styles.muted}>
                      {formatMoney(account.openingBalanceCents)} as of {account.balanceAsOf}
                    </Text>
                  </div>
                  <div className={styles.grid}>
                    <Field
                      label="Account minimum"
                      hint="The balance this account should never cross."
                    >
                      <Input
                        name="accountHardFloor"
                        inputMode="decimal"
                        min="0"
                        defaultValue={centsInput(account.hardFloorCents)}
                        placeholder="0.00"
                      />
                    </Field>
                    <Field
                      label="Preferred buffer"
                      hint="Optional earlier warning; cannot be below the minimum."
                    >
                      <Input
                        name="accountPreferredFloor"
                        inputMode="decimal"
                        min="0"
                        defaultValue={centsInput(account.preferredFloorCents)}
                        placeholder="Optional"
                      />
                    </Field>
                    <Field
                      label="Transfer lead time (days)"
                      hint="Calendar days required before money can arrive elsewhere."
                    >
                      <Input
                        name="accountTransferDelay"
                        type="number"
                        min="0"
                        max="30"
                        step="1"
                        required
                        defaultValue={String(account.transferDelayDays)}
                      />
                    </Field>
                  </div>
                  <div className={styles.stack}>
                    <Checkbox
                      name="accountIncludedInLiquidity"
                      defaultChecked={account.includedInLiquidity}
                      label="Include in liquid cash and the global minimum"
                    />
                    <Checkbox
                      name="accountCanFund"
                      defaultChecked={account.canFundOtherAccounts}
                      label="Allow transfer recommendations to use this account"
                    />
                    <Checkbox
                      name="accountShowOnOverview"
                      defaultChecked={account.showOnOverview}
                      label="Show this account in the Overview cash-account list"
                    />
                    <Text size={200} className={styles.muted}>
                      Display only. Hidden accounts still affect forecasts, card runway, protected
                      minimums, and any funding warning that needs your attention.
                    </Text>
                  </div>
                  <Button appearance="primary" type="submit">
                    Save {account.name}
                  </Button>
                </form>
              ))}
            </div>
          </>
        ) : policyLoaded ? (
          <Text>Account protection could not be loaded. Reopen Settings to retry.</Text>
        ) : (
          <LoadingSkeleton label="Loading account protection" variant="inline-form" />
        )}
      </Card>
      <Card className={styles.panel}>
        <Title2 as="h2">Privacy boundary</Title2>
        <Text>
          The local password separates profiles inside the app. It does not protect data from a
          Windows administrator. The live database stays in the private app-data directory; manual
          portable backups are encrypted.
        </Text>
        <div className={styles.actions}>
          <Button onClick={() => (window.location.hash = '#/setup')}>Review setup</Button>
          <Button onClick={() => (window.location.hash = '#/records')}>
            Workbook import review and records
          </Button>
        </div>
      </Card>
      <fieldset
        className={styles.dataActionArea}
        disabled={dataActionBusy}
        aria-busy={dataActionBusy}
        aria-label="Backup, restore, export, import, and reset actions"
      >
        {activeDataAction && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={styles.dataActionStatus}
          >
            {dataActionProgressMessage(activeDataAction)}
          </div>
        )}
        {error && (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        )}
        {message && (
          <div role="status" className={styles.positive}>
            {message}
          </div>
        )}
        <Card className={styles.panel}>
          <Title2 as="h2">Backup, restore, and export</Title2>
          <div className={styles.form}>
            <Text>
              A portable backup contains this profile's financial records, setup draft, preferences,
              audit history, and workbook lineage. It never contains the local sign-in password. On
              a new computer, create a new local password first, then restore with the separate
              backup password.
            </Text>
            <Field label="Backup password (separate from sign-in)">
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(_, data) => setPassword(data.value)}
              />
            </Field>
            <Field
              label="Confirm backup password"
              validationMessage={
                backupPasswordConfirmation && password !== backupPasswordConfirmation
                  ? 'Backup passwords do not match'
                  : undefined
              }
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={backupPasswordConfirmation}
                onChange={(_, data) => setBackupPasswordConfirmation(data.value)}
              />
            </Field>
            <div className={styles.actions}>
              <Button
                appearance="primary"
                disabled={password.length < 12 || password !== backupPasswordConfirmation}
                onClick={() => void run('backup')}
              >
                Create encrypted backup
              </Button>
              <Button onClick={() => void run('export')}>Export JSON and CSV</Button>
            </div>
            <Title2 as="h2">Restore</Title2>
            <Text>
              Restore validates the entire encrypted profile before a single transaction replaces
              the active profile. A local pre-restore recovery backup is created automatically. Your
              account name and local sign-in password do not change.
            </Text>
            <Checkbox
              checked={confirmReplace}
              onChange={(_, data) => setConfirmReplace(Boolean(data.checked))}
              label="I understand this replaces the active profile's records"
            />
            <Button
              disabled={password.length < 12 || !confirmReplace}
              onClick={() => void run('restore')}
            >
              Choose encrypted backup to restore
            </Button>
            <Button disabled={!confirmReplace} onClick={() => void run('import')}>
              Choose JSON export to import
            </Button>
          </div>
        </Card>
        <Card className={styles.panel}>
          <Title2 as="h2">Reset active profile financial data</Title2>
          <Text>
            This guarded audit action permanently removes this profile's financial records and
            import lineage. The profile and password remain available for a fresh setup.
          </Text>
          <Field label="Type DELETE ACTIVE PROFILE DATA to continue">
            <Input
              value={resetConfirmation}
              onChange={(_, data) => setResetConfirmation(data.value)}
            />
          </Field>
          <Button
            disabled={resetConfirmation !== 'DELETE ACTIVE PROFILE DATA'}
            onClick={() => void reset()}
          >
            Reset active profile data
          </Button>
        </Card>
      </fieldset>
    </>
  );
};
