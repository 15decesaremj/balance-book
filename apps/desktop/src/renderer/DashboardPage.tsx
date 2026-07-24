import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Tab,
  TabList,
  Text,
  Textarea,
  Title1,
  Title2,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Temporal } from '@js-temporal/polyfill';
import { defaultProfilePreferences } from '@balance-book/domain';
import { useNavigate, useSearchParams } from 'react-router';
import type {
  AuditHistoryEntryDto,
  ForecastSnapshotDto,
  ManagedRecordsDto,
  ScenarioResponseDto,
  SessionDto,
  UpsertManagedEntityRequest,
} from '../shared/contracts';
import {
  advisorReason,
  advisorResultIsFundable,
  advisorResultIsIncomeDependent,
  advisorResultIsSafe,
  advisorResultStatus,
  advisorStatusLabel,
  advisorVerdictLabel,
  cardSpendingPowerUnavailableReason,
  rankAdvisorResults,
  type CardAdvisorResult,
} from './dashboard-insights';
import { dollarsToCents, formatMoney, formatPlainDate as displayDate } from './utils';
import { LoadingSkeleton } from './LoadingSkeleton';
import { announceCanonicalDataChanged } from './financial-events';
import { buildAccountPositionReadModel, buildCardPositionReadModel } from './financial-read-models';
import {
  compensatingForecastEventRequest,
  overviewBalanceUpdateRequest,
  overviewCardBalanceUpdateRequest,
  overviewCardTransactionRequest,
  overviewCashTransactionRequest,
  overviewStatementBalanceUpdateRequest,
  statementBalanceEditIsUnusual,
} from './overview-mutations';

export {
  overviewBalanceUpdateRequest,
  overviewCardBalanceUpdateRequest,
  overviewCardTransactionRequest,
  overviewCashTransactionRequest,
  overviewStatementBalanceUpdateRequest,
  statementBalanceEditIsUnusual,
} from './overview-mutations';

type ForecastMode = 'conservative' | 'expected';
type SeriesId = 'position' | 'cash' | 'net-worth' | `account:${string}`;
type DailyPoint = NonNullable<ForecastSnapshotDto['dailyCash']>[number];
type CardPowerRow = NonNullable<ForecastSnapshotDto['cardSpendingPower']>[number];
type RevolvingDebtRow = NonNullable<ForecastSnapshotDto['revolvingDebtByCard']>[number];
type FundingNeed = NonNullable<ForecastSnapshotDto['transferNeeds']>[number];
export type OverviewCardSort =
  | 'period-asc'
  | 'period-desc'
  | 'name-asc'
  | 'name-desc'
  | 'available-desc'
  | 'available-asc'
  | 'balance-desc'
  | 'balance-asc'
  | 'statement-desc'
  | 'statement-asc';
type CashAdvisorResult = {
  accountId: string;
  accountName: string;
  scenario: ScenarioResponseDto;
};
type CardBalanceEditKind = 'current' | 'statement';
type CardBalanceEditor = {
  cardId: string;
  cardName: string;
  kind: CardBalanceEditKind;
  amount: string;
  balanceAsOf: string;
  cycleId?: string;
  dueOn?: string;
};
type QuickTransactionEditor = {
  direction: 'inflow' | 'outflow';
  amount: string;
  label: string;
  date: string;
  notes: string;
};
type OverviewExpenseEditor = {
  paymentSource: string;
  amount: string;
  label: string;
  date: string;
  notes: string;
  owedTreatment: 'none' | 'reimbursable' | 'shared';
  owedBy: string;
};

const compareOptional = <T,>(
  left: T | undefined,
  right: T | undefined,
  compare: (left: T, right: T) => number,
): number => {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return compare(left, right);
};

export const sortOverviewCards = (
  cards: CardPowerRow[],
  debts: RevolvingDebtRow[],
  sort: OverviewCardSort,
): CardPowerRow[] => {
  const debtByCardId = new Map(debts.map((debt) => [debt.cardId, debt] as const));
  const numberOrder = (left: number, right: number): number => left - right;
  const textOrder = (left: string, right: string): number => left.localeCompare(right);
  return [...cards].sort((left, right) => {
    const leftDebt = debtByCardId.get(left.cardId);
    const rightDebt = debtByCardId.get(right.cardId);
    let order = 0;
    switch (sort) {
      case 'period-asc':
        order = compareOptional(left.currentCycleClosesOn, right.currentCycleClosesOn, textOrder);
        break;
      case 'period-desc':
        order = compareOptional(left.currentCycleClosesOn, right.currentCycleClosesOn, (a, b) =>
          textOrder(b, a),
        );
        break;
      case 'name-asc':
        order = textOrder(left.cardName, right.cardName);
        break;
      case 'name-desc':
        order = textOrder(right.cardName, left.cardName);
        break;
      case 'available-desc':
        order = compareOptional(
          left.spendingPowerStatus === 'determinate' ||
            left.spendingPowerStatus === 'conditional-existing-shortfall'
            ? left.spendingPowerCents
            : undefined,
          right.spendingPowerStatus === 'determinate' ||
            right.spendingPowerStatus === 'conditional-existing-shortfall'
            ? right.spendingPowerCents
            : undefined,
          (a, b) => numberOrder(b, a),
        );
        break;
      case 'available-asc':
        order = compareOptional(
          left.spendingPowerStatus === 'determinate' ||
            left.spendingPowerStatus === 'conditional-existing-shortfall'
            ? left.spendingPowerCents
            : undefined,
          right.spendingPowerStatus === 'determinate' ||
            right.spendingPowerStatus === 'conditional-existing-shortfall'
            ? right.spendingPowerCents
            : undefined,
          numberOrder,
        );
        break;
      case 'balance-desc':
        order = compareOptional(
          leftDebt?.currentBalanceCents,
          rightDebt?.currentBalanceCents,
          (a, b) => numberOrder(b, a),
        );
        break;
      case 'balance-asc':
        order = compareOptional(
          leftDebt?.currentBalanceCents,
          rightDebt?.currentBalanceCents,
          numberOrder,
        );
        break;
      case 'statement-desc':
        order = compareOptional(
          leftDebt?.latestStatementDate ? leftDebt.latestStatementCents : undefined,
          rightDebt?.latestStatementDate ? rightDebt.latestStatementCents : undefined,
          (a, b) => numberOrder(b, a),
        );
        break;
      case 'statement-asc':
        order = compareOptional(
          leftDebt?.latestStatementDate ? leftDebt.latestStatementCents : undefined,
          rightDebt?.latestStatementDate ? rightDebt.latestStatementCents : undefined,
          numberOrder,
        );
        break;
    }
    return order || textOrder(left.cardName, right.cardName);
  });
};

const useDashboardStyles = makeStyles({
  page: {
    display: 'grid',
    width: '100%',
    minWidth: 0,
    gap: '24px',
    maxWidth: '1500px',
    marginInline: 'auto',
  },
  header: {
    order: -5,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalXL,
    '@media (max-width: 760px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  heading: {
    display: 'grid',
    minWidth: 0,
    gap: tokens.spacingVerticalXS,
    '& > *': { minWidth: 0, overflowWrap: 'anywhere' },
  },
  eyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  detail: {
    color: tokens.colorNeutralForeground2,
    maxWidth: '76ch',
    overflowWrap: 'anywhere',
  },
  segmented: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '3px',
    padding: '4px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 32%, transparent)',
    backdropFilter: 'blur(18px) saturate(145%)',
  },
  status: {
    order: -4,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `5px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: 'var(--balance-glass)',
    backdropFilter: 'blur(24px) saturate(145%)',
    '@media (max-width: 760px)': { alignItems: 'flex-start', flexDirection: 'column' },
  },
  statusWarning: { borderLeftColor: tokens.colorPaletteDarkOrangeBorder2 },
  statusAlert: { borderLeftColor: tokens.colorPaletteRedBorder2 },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1080px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 520px)': { gridTemplateColumns: '1fr' },
  },
  metricCard: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  metricValue: {
    fontSize: 'clamp(1.65rem, 3.2vw, 2.55rem)',
    lineHeight: '1.08',
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.035em',
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  metricLabel: { color: tokens.colorNeutralForeground2, fontWeight: tokens.fontWeightSemibold },
  section: { display: 'grid', minWidth: 0, gap: tokens.spacingVerticalL },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 700px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  cardHeaderActions: {
    display: 'flex',
    alignItems: 'end',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  cardSortField: { minWidth: '220px' },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1120px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 680px)': { gridTemplateColumns: '1fr' },
  },
  safeSpendHero: {
    order: -3,
    padding: `clamp(20px, 3vw, 32px)`,
    display: 'grid',
    minWidth: 0,
    gap: tokens.spacingVerticalXL,
    overflow: 'hidden',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: '28px',
    backgroundColor: 'var(--balance-glass-strong)',
    backgroundImage: `radial-gradient(circle at 88% 0%, ${tokens.colorBrandBackground2} 0, transparent 45%), linear-gradient(145deg, var(--balance-glass-highlight), transparent 40%)`,
    boxShadow: tokens.shadow8,
    backdropFilter: 'blur(28px) saturate(150%)',
  },
  dailyCashQuick: { order: -2 },
  safeSpendGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 680px)': { gridTemplateColumns: '1fr' },
  },
  safeSpendCard: {
    position: 'relative',
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  safeSpendCardSafe: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteGreenBorder2}`,
  },
  safeSpendCardCaution: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteDarkOrangeBorder2}`,
  },
  safeSpendAmount: {
    display: 'block',
    fontSize: 'clamp(2.05rem, 4vw, 2.8rem)',
    lineHeight: 1,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.045em',
    fontVariantNumeric: 'tabular-nums',
  },
  cardBalanceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    '& > *': { minWidth: 0 },
  },
  cardBalanceStat: {
    display: 'grid',
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 42%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight)',
  },
  cardBalanceStatHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalXS,
  },
  compactEditButton: {
    minWidth: 'auto',
    minHeight: '24px',
    height: '24px',
    paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase100,
  },
  quickOpenSurface: {
    position: 'relative',
    overflow: 'hidden',
    transitionProperty: 'transform, border-color, box-shadow',
    transitionDuration: tokens.durationNormal,
    '&:has(.quick-open-hit:focus-visible)': {
      outline: '2px solid var(--balance-focus-ring)',
      outlineOffset: '3px',
    },
    '&:has(.quick-open-hit:hover)': {
      transform: 'translateY(-1px)',
    },
    '& details, & button:not(.quick-open-hit), & a, & input, & select': {
      position: 'relative',
      zIndex: 2,
    },
  },
  quickOpenHit: {
    position: 'absolute',
    zIndex: 1,
    inset: 0,
    width: '100%',
    height: '100%',
    minHeight: 0,
    padding: 0,
    border: 0,
    borderRadius: 'inherit',
    background: 'transparent',
    cursor: 'pointer',
    '&:focus-visible': { outline: 'none' },
  },
  quickOpenHint: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
  },
  quickDialog: {
    width: 'min(520px, calc(100vw - 32px))',
    maxWidth: '520px',
    padding: tokens.spacingHorizontalXL,
    borderRadius: '24px',
    border: '1px solid var(--balance-glass-border)',
    background: 'var(--balance-glass-strong)',
    backdropFilter: 'blur(28px) saturate(140%)',
    '@media (max-width: 540px)': {
      width: '100vw',
      maxWidth: '100vw',
      margin: 0,
      alignSelf: 'end',
      borderRadius: '24px 24px 0 0',
      paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
    },
  },
  quickDialogForm: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
  },
  quickTabs: {
    marginBottom: tokens.spacingVerticalS,
  },
  quickModeActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  quickPreview: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 48%, transparent)',
    fontVariantNumeric: 'tabular-nums',
  },
  expenseTreatment: {
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 28%, transparent)',
  },
  expenseTreatmentOptions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
  },
  cardBalanceWarning: {
    gridColumn: '1 / -1',
    color: tokens.colorPaletteDarkOrangeForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  cardBalanceValue: {
    fontSize: tokens.fontSizeBase400,
    lineHeight: 1.15,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.02em',
    overflowWrap: 'anywhere',
  },
  stillOwedValue: { color: tokens.colorPaletteDarkOrangeForeground2 },
  safeSpendFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 520px)': { gridTemplateColumns: '1fr' },
  },
  runwayPanel: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  runwayBalanceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  powerCard: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  powerTop: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    '& > *': { minWidth: 0 },
  },
  cardTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    flex: '1 1 230px',
    '& strong': { overflowWrap: 'anywhere' },
  },
  cardTimingRow: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    minWidth: 0,
    '& > *': { overflowWrap: 'anywhere' },
  },
  resetBadge: {
    width: '34px',
    height: '34px',
    flex: '0 0 34px',
    display: 'grid',
    placeItems: 'center',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: `inset 0 1px 0 var(--balance-glass-highlight), ${tokens.shadow4}`,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: 'tabular-nums',
  },
  powerValue: {
    display: 'block',
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  warningText: { color: tokens.colorPaletteDarkOrangeForeground2 },
  dangerText: { color: tokens.colorPaletteRedForeground1 },
  factGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    '@media (max-width: 420px)': { gridTemplateColumns: '1fr' },
  },
  fact: { minWidth: 0, display: 'grid', gap: tokens.spacingVerticalXXS },
  factValue: {
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  twoColumn: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    '@media (max-width: 1040px)': { gridTemplateColumns: '1fr' },
  },
  stack: { display: 'grid', gap: tokens.spacingVerticalL },
  panel: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '24px',
    backgroundColor: 'var(--balance-glass)',
    boxShadow: `inset 0 1px 0 var(--balance-glass-highlight), ${tokens.shadow4}`,
    backdropFilter: 'blur(24px) saturate(145%)',
  },
  chart: {
    width: '100%',
    height: '360px',
    '@media (max-width: 680px)': { height: '260px' },
  },
  tableViewport: {
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'auto',
    maxHeight: '610px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  table: {
    width: '100%',
    minWidth: '760px',
    borderCollapse: 'separate',
    borderSpacing: 0,
    '& th': {
      position: 'sticky',
      top: 0,
      zIndex: 1,
      color: tokens.colorNeutralForeground3,
      backgroundColor: tokens.colorNeutralBackground2,
      fontSize: tokens.fontSizeBase200,
      fontWeight: tokens.fontWeightSemibold,
      letterSpacing: '0.045em',
      textTransform: 'uppercase',
    },
    '& th, & td': {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      textAlign: 'left',
      verticalAlign: 'top',
      whiteSpace: 'nowrap',
    },
    '& tbody tr:hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  desktopLedger: {
    '@media (max-width: 680px)': { display: 'none' },
  },
  mobileLedger: {
    display: 'none',
    '@media (max-width: 680px)': {
      display: 'flex',
      flexDirection: 'column',
      maxHeight: '650px',
      gap: tokens.spacingVerticalS,
      overflowY: 'auto',
    },
  },
  mobileLedgerDay: {
    flexShrink: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    '& > summary': {
      padding: tokens.spacingHorizontalL,
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      alignItems: 'center',
      gap: tokens.spacingHorizontalM,
      listStylePosition: 'inside',
    },
    '&[open] > summary': {
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
  },
  mobileLedgerAmount: {
    display: 'grid',
    justifyItems: 'end',
    gap: tokens.spacingVerticalXXS,
    fontVariantNumeric: 'tabular-nums',
  },
  mobileLedgerDetails: {
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gap: tokens.spacingVerticalL,
  },
  mobileLedgerFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  mobileLedgerEvents: {
    paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  money: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  eventCell: { minWidth: '260px', whiteSpace: 'normal !important' },
  eventLine: {
    display: 'grid',
    gap: tokens.spacingVerticalXXS,
    marginBottom: tokens.spacingVerticalS,
    '&:last-child': { marginBottom: 0 },
  },
  eventHeading: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  eventTraceButton: {
    appearance: 'none',
    padding: 0,
    border: 0,
    color: 'inherit',
    background: 'transparent',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    '&:hover': { color: tokens.colorBrandForeground1, textDecorationLine: 'underline' },
    '&:focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '2px',
    },
  },
  eventState: {
    display: 'inline-flex',
    padding: `1px ${tokens.spacingHorizontalS}`,
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase200,
    letterSpacing: '0.035em',
    textTransform: 'uppercase',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground2,
  },
  eventScope: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  accountRows: { display: 'grid' },
  accountRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1fr) auto',
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
    paddingBlock: tokens.spacingVerticalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    '& > *': { minWidth: 0 },
    '& strong': { overflowWrap: 'anywhere' },
    '&:last-child': { borderBottom: 'none' },
  },
  accountHeader: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  balanceStatus: { color: tokens.colorPaletteGreenForeground1 },
  nextStatementPosition: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 38%, transparent)',
  },
  accountLow: {
    gridColumn: '1 / -1',
    color: tokens.colorNeutralForeground2,
    fontVariantNumeric: 'tabular-nums',
  },
  advisorPanel: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    backgroundImage: `linear-gradient(145deg, ${tokens.colorBrandBackground2}, transparent 72%)`,
    boxShadow: tokens.shadow4,
  },
  advisorForm: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 0.75fr) auto',
    alignItems: 'end',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 760px)': { gridTemplateColumns: '1fr' },
  },
  advisorSummary: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
    borderLeft: `5px solid ${tokens.colorPaletteGreenForeground1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  advisorSummaryConditional: { borderLeftColor: tokens.colorPaletteDarkOrangeBorder2 },
  advisorSummaryUnsafe: { borderLeftColor: tokens.colorPaletteRedBorder2 },
  advisorOptions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    padding: 0,
    margin: 0,
    listStyleType: 'none',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 680px)': { gridTemplateColumns: '1fr' },
  },
  advisorOption: {
    height: '100%',
    minWidth: 0,
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    alignContent: 'start',
    gap: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  advisorRank: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  advisorFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    '@media (max-width: 420px)': { gridTemplateColumns: '1fr' },
  },
  advisorSafe: {
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  fundingList: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
    padding: 0,
    margin: 0,
    listStyleType: 'none',
  },
  fundingClear: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteGreenBorder2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorPaletteGreenBackground2,
    '@media (max-width: 680px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  fundingRow: {
    minWidth: 0,
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gridTemplateColumns: 'minmax(170px, 0.72fr) minmax(0, 1.7fr) minmax(230px, 0.9fr)',
    alignItems: 'start',
    gap: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    '& > *': { minWidth: 0 },
    '@media (max-width: 1280px)': {
      gridTemplateColumns: 'minmax(170px, 0.72fr) minmax(0, 1.7fr)',
    },
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
      alignItems: 'stretch',
    },
  },
  fundingFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
    '@media (max-width: 420px)': { gridTemplateColumns: '1fr' },
  },
  fundingResolution: {
    display: 'grid',
    alignContent: 'start',
    gap: tokens.spacingVerticalM,
    minWidth: 0,
    '& > *': { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' },
    '& button': { width: 'fit-content', whiteSpace: 'normal' },
    '@media (max-width: 1280px)': { gridColumn: '1 / -1' },
    '@media (max-width: 900px)': { gridColumn: 'auto' },
  },
  explain: {
    color: tokens.colorNeutralForeground2,
    '& summary': {
      cursor: 'pointer',
      color: tokens.colorBrandForeground1,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
  rankedDisclosure: {
    padding: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    '& > summary': {
      color: tokens.colorNeutralForeground1,
      fontSize: tokens.fontSizeBase400,
      fontWeight: tokens.fontWeightSemibold,
    },
    '&[open] > summary': { marginBottom: tokens.spacingVerticalL },
  },
  empty: {
    padding: tokens.spacingHorizontalXL,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
  },
  error: { color: tokens.colorPaletteRedForeground1 },
});

const valueForSeries = (point: DailyPoint, mode: ForecastMode, series: SeriesId): number => {
  if (series === 'position')
    return mode === 'expected' ? point.expectedPositionCents : point.conservativePositionCents;
  if (series === 'cash')
    return mode === 'expected' ? point.expectedCashCents : point.conservativeCashCents;
  if (series === 'net-worth')
    return (
      (mode === 'expected' ? point.expectedNetWorthCents : point.conservativeNetWorthCents) ?? 0
    );
  const accountId = series.slice('account:'.length);
  const account = point.accountBalances.find((candidate) => candidate.accountId === accountId);
  return mode === 'expected'
    ? (account?.expectedCashCents ?? 0)
    : (account?.conservativeCashCents ?? 0);
};

const eventType = (kind: string): string =>
  ({
    income: 'Income',
    'card-payment': 'Card payment',
    'loan-payment': 'Loan payment',
    'receivable-settlement': 'Money received',
    'receivable-accrual': 'Money owed added',
    'direct-commitment': 'Direct payment',
    'baseline-spending': 'Planned spending',
    'transfer-debit': 'Transfer out',
    'transfer-credit': 'Transfer in',
  })[kind] ?? 'Cash event';

const displayEventState = (state: DailyPoint['events'][number]['displayState']): string =>
  ({
    actual: 'Actual',
    locked: 'Locked',
    estimated: 'Estimated',
    hypothetical: 'Hypothetical',
    planned: 'Planned',
  })[state];

const eventForecastScope = (event: DailyPoint['events'][number]): string => {
  if (event.includedInExpected && event.includedInConservative) return 'Both forecast views';
  if (event.includedInExpected) return 'Expected only';
  if (event.includedInConservative) return 'Conservative only';
  return 'Not included in cash totals';
};

export const forecastEventSourcePath = (event: DailyPoint['events'][number]): string => {
  const entityId = encodeURIComponent(event.sourceRecordId ?? event.id);
  if (event.sourceRecordId && event.kind === 'card-payment') {
    return `/records?entityType=card-cycle&entityId=${entityId}`;
  }
  if (event.sourceRecordId && event.kind === 'loan-payment') {
    return `/records?entityType=loan&entityId=${entityId}`;
  }
  if (
    event.sourceRecordId &&
    (event.kind === 'receivable-settlement' || event.kind === 'receivable-accrual')
  ) {
    return `/records?entityType=receivable&entityId=${entityId}`;
  }
  return `/records?entityType=forecast-event&entityId=${entityId}`;
};

const cardRewardRateBasisPoints = (card: CardPowerRow): number | undefined => {
  const candidate = (card as CardPowerRow & { rewardRateBasisPoints?: unknown })
    .rewardRateBasisPoints;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
};

const advisorRewardText = (result: CardAdvisorResult): string | null => {
  if (result.rewardRateBasisPoints === undefined) return null;
  if (result.rewardType === 'cash-back' && result.estimatedRewardCents !== undefined) {
    return `${formatMoney(result.estimatedRewardCents)} estimated cash back`;
  }
  if (result.rewardType === 'points') {
    const pointsPerDollar = result.rewardRateBasisPoints / 100;
    return `${pointsPerDollar.toFixed(2)} point${pointsPerDollar === 1 ? '' : 's'} per dollar; point value not assumed`;
  }
  return `${(result.rewardRateBasisPoints / 100).toFixed(2)}% entered reward rate`;
};

const fundingActionPath = (need: FundingNeed): string | null => {
  if (!need.sourceAccountId || !need.initiationDate || !need.arrivalDate) return null;
  const parameters = new URLSearchParams({
    source: need.sourceAccountId,
    destination: need.accountId,
    amountCents: String(need.shortfallCents),
    initiation: need.initiationDate,
    arrival: need.arrivalDate,
  });
  return `/baseline?${parameters.toString()}`;
};

const Metric = ({
  label,
  value,
  detail,
  explanation,
}: {
  label: string;
  value: number;
  detail: string;
  explanation?: React.ReactNode;
}): React.JSX.Element => {
  const styles = useDashboardStyles();
  return (
    <Card className={styles.metricCard}>
      <Text className={styles.metricLabel}>{label}</Text>
      <Text className={styles.metricValue}>{formatMoney(value)}</Text>
      <Text size={200} className={styles.detail}>
        {detail}
      </Text>
      {explanation && (
        <details className={styles.explain}>
          <summary>Explain this number</summary>
          <Text size={200}>{explanation}</Text>
        </details>
      )}
    </Card>
  );
};

export const DashboardPage = ({
  fullForecast = false,
  preferences = defaultProfilePreferences,
}: {
  fullForecast?: boolean;
  preferences?: SessionDto['preferences'];
}): React.JSX.Element => {
  const styles = useDashboardStyles();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ForecastMode>(
    fullForecast ? 'expected' : preferences.overviewForecastMode,
  );
  const [series, setSeries] = useState<SeriesId>('position');
  const today = useMemo(() => Temporal.Now.plainDateISO().toString(), []);
  const [advisorAmount, setAdvisorAmount] = useState('');
  const [advisorDate, setAdvisorDate] = useState(today);
  const [advisorResults, setAdvisorResults] = useState<CardAdvisorResult[] | null>(null);
  const [cashAdvisorResults, setCashAdvisorResults] = useState<CashAdvisorResult[] | null>(null);
  const [advisorEvaluation, setAdvisorEvaluation] = useState<{
    amountCents: number;
    purchaseDate: string;
  } | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [advisorUnavailableCount, setAdvisorUnavailableCount] = useState(0);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const advisorRequestGenerationRef = useRef(0);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [overviewCardSort, setOverviewCardSort] = useState<OverviewCardSort>('period-asc');
  const [balanceEditor, setBalanceEditor] = useState<{
    accountId: string;
    balance: string;
    balanceAsOf: string;
  } | null>(null);
  const [balanceUpdatePendingAccountId, setBalanceUpdatePendingAccountId] = useState<string | null>(
    null,
  );
  const [balanceUpdateStatus, setBalanceUpdateStatus] = useState<string | null>(null);
  const [balanceUpdateError, setBalanceUpdateError] = useState<string | null>(null);
  const balanceUpdateLockRef = useRef(false);
  const [cardBalanceEditor, setCardBalanceEditor] = useState<CardBalanceEditor | null>(null);
  const [cardBalanceUpdatePendingKey, setCardBalanceUpdatePendingKey] = useState<string | null>(
    null,
  );
  const [cardBalanceUpdateStatus, setCardBalanceUpdateStatus] = useState<{
    cardId: string;
    message: string;
  } | null>(null);
  const [cardBalanceUpdateError, setCardBalanceUpdateError] = useState<{
    cardId: string;
    message: string;
  } | null>(null);
  const cardBalanceUpdateLockRef = useRef(false);
  const [quickMode, setQuickMode] = useState<'balance' | 'transaction'>('balance');
  const [detailArea, setDetailArea] = useState<'now' | 'activity' | 'plan'>('now');
  const [detailRecords, setDetailRecords] = useState<ManagedRecordsDto | null>(null);
  const [detailAuditHistory, setDetailAuditHistory] = useState<AuditHistoryEntryDto[]>([]);
  const [detailActionError, setDetailActionError] = useState<string | null>(null);
  const [detailActionBusy, setDetailActionBusy] = useState(false);
  const [quickTransaction, setQuickTransaction] = useState<QuickTransactionEditor>({
    direction: 'outflow',
    amount: '',
    label: '',
    date: today,
    notes: '',
  });
  const [expenseEditor, setExpenseEditor] = useState<OverviewExpenseEditor | null>(null);
  const [expenseRecords, setExpenseRecords] = useState<ManagedRecordsDto | null>(null);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [expenseError, setExpenseError] = useState<string | null>(null);
  const [expenseStatus, setExpenseStatus] = useState<string | null>(null);
  const expenseOriginRef = useRef<HTMLElement | null>(null);
  const quickOriginRef = useRef<HTMLElement | null>(null);
  const appliedDetailLinkRef = useRef<string | null>(null);
  const detailAccountId = balanceEditor?.accountId;
  const detailCardId = cardBalanceEditor?.cardId;

  useEffect(() => {
    if (!detailAccountId && !detailCardId) return;
    void window.balanceBook.listRecords().then((result) => {
      if (result.ok) setDetailRecords(result.value);
      else setDetailActionError(result.error);
    });
    const auditRequest = window.balanceBook.listAuditHistory?.();
    if (auditRequest) {
      void auditRequest.then((result) => {
        if (result.ok) setDetailAuditHistory(result.value);
        else setDetailActionError(result.error);
      });
    }
  }, [detailAccountId, detailCardId]);
  useEffect(() => {
    const detail = searchParams.get('detail');
    if (!snapshot || !detail || appliedDetailLinkRef.current === detail) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const separator = detail.indexOf(':');
      if (separator < 1) return;
      const kind = detail.slice(0, separator);
      const entityId = decodeURIComponent(detail.slice(separator + 1));
      const financialDate = snapshot.startDate ?? today;
      if (kind === 'account') {
        const account = snapshot.cashAccounts?.find((candidate) => candidate.id === entityId);
        if (!account) return;
        appliedDetailLinkRef.current = detail;
        setCardBalanceEditor(null);
        setDetailArea('now');
        setQuickMode('balance');
        setBalanceEditor({
          accountId: account.id,
          balance: (account.balanceCents / 100).toFixed(2),
          balanceAsOf: financialDate,
        });
        return;
      }
      if (kind === 'card') {
        const card = snapshot.cardSpendingPower?.find((candidate) => candidate.cardId === entityId);
        const debt = snapshot.revolvingDebtByCard?.find(
          (candidate) => candidate.cardId === entityId,
        );
        if (!card) return;
        appliedDetailLinkRef.current = detail;
        setBalanceEditor(null);
        setDetailArea('now');
        setQuickMode('balance');
        setCardBalanceEditor({
          cardId: card.cardId,
          cardName: card.cardName,
          kind: 'current',
          amount: ((debt?.currentBalanceCents ?? 0) / 100).toFixed(2),
          balanceAsOf: financialDate,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [searchParams, snapshot, today]);

  useEffect(() => {
    void window.balanceBook
      .getForecast()
      .then((result) => {
        if (!result.ok) setError(result.error);
        else setSnapshot(result.value);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'The financial plan could not load.'),
      );
  }, []);
  const chartData = useMemo(
    () =>
      (snapshot?.dailyCash ?? [])
        .filter(
          (point) =>
            !series.startsWith('account:') ||
            point.accountBalances.find(
              (account) => account.accountId === series.slice('account:'.length),
            )?.available,
        )
        .map((point) => ({
          date: point.date,
          value: valueForSeries(point, mode, series) / 100,
          valueCents: valueForSeries(point, mode, series),
        })),
    [mode, series, snapshot],
  );
  const chartLow = useMemo(
    () =>
      chartData.reduce(
        (lowest, point) => (point.valueCents < lowest.valueCents ? point : lowest),
        chartData[0] ?? { date: '', value: 0, valueCents: 0 },
      ),
    [chartData],
  );

  if (error)
    return (
      <div role="alert" className={styles.error}>
        {error}
      </div>
    );
  if (!snapshot)
    return <LoadingSkeleton label="Building your financial plan" variant="dashboard" />;
  if (!snapshot.setupComplete) {
    return (
      <Card className={styles.metricCard}>
        <Text className={styles.eyebrow}>Private and local</Text>
        <Title1 as="h1">Build your first forecast</Title1>
        <Text>
          Start with a dated cash balance and protected floor, then add only the income,
          commitments, cards, loans, money owed, and assets that apply to you.
        </Text>
        <Button appearance="primary" onClick={() => navigate('/setup')}>
          Start guided setup
        </Button>
        <Button appearance="outline" onClick={() => navigate('/settings')}>
          Restore an encrypted backup
        </Button>
      </Card>
    );
  }

  const currentCash = snapshot.currentConsolidatedCashCents ?? 0;
  const currentOwed = snapshot.currentReceivableCents ?? 0;
  const hardFloor = snapshot.hardFloorCents ?? 0;
  const preferredFloor = snapshot.preferredFloorCents;
  const positionLow =
    mode === 'expected'
      ? (snapshot.expectedPositionLowCents ?? 0)
      : (snapshot.conservativePositionLowCents ?? 0);
  const positionLowDate =
    mode === 'expected' ? snapshot.expectedPositionLowDate : snapshot.conservativePositionLowDate;
  const cashLow =
    mode === 'expected'
      ? (snapshot.expectedTroughCents ?? 0)
      : (snapshot.conservativeTroughCents ?? 0);
  const cashLowDate =
    mode === 'expected' ? snapshot.expectedTroughDate : snapshot.conservativeTroughDate;
  const intradayLow =
    mode === 'expected'
      ? (snapshot.expectedIntradaySafetyLowCents ?? cashLow)
      : (snapshot.conservativeIntradaySafetyLowCents ?? cashLow);
  const intradayLowDate =
    mode === 'expected'
      ? snapshot.expectedIntradaySafetyLowDate
      : snapshot.conservativeIntradaySafetyLowDate;
  const fundingNeeds =
    mode === 'expected' ? (snapshot.expectedTransferNeeds ?? []) : (snapshot.transferNeeds ?? []);
  const overviewCashAccounts = (snapshot.cashAccounts ?? []).filter(
    (account) => account.showOnOverview !== false,
  );
  const currentBalanceDate = snapshot.startDate ?? today;
  const closeExpenseEditor = (): void => {
    setExpenseEditor(null);
    setExpenseRecords(null);
    setExpenseError(null);
    const origin = expenseOriginRef.current;
    expenseOriginRef.current = null;
    window.setTimeout(() => origin?.focus(), 0);
  };
  const startExpenseEditor = async (origin?: EventTarget | null): Promise<void> => {
    if (expenseBusy) return;
    if (origin instanceof HTMLElement) expenseOriginRef.current = origin;
    setExpenseBusy(true);
    setExpenseError(null);
    setExpenseStatus(null);
    try {
      const result = await window.balanceBook.listRecords();
      if (!result.ok) throw new Error(result.error);
      if (result.value.accounts.length === 0 && result.value.cards.length === 0) {
        throw new Error('Add a cash account or card before logging an expense.');
      }
      setExpenseRecords(result.value);
      setExpenseEditor({
        paymentSource: '',
        amount: '',
        label: '',
        date: currentBalanceDate,
        notes: '',
        owedTreatment: 'none',
        owedBy: '',
      });
    } catch (caught) {
      setExpenseError(
        caught instanceof Error ? caught.message : 'The expense editor could not open.',
      );
    } finally {
      setExpenseBusy(false);
    }
  };
  const saveOverviewExpense = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!expenseEditor || expenseBusy) return;
    setExpenseBusy(true);
    setExpenseError(null);
    let persisted = false;
    try {
      const amountCents = dollarsToCents(expenseEditor.amount);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error('Enter an amount greater than zero.');
      }
      const date = Temporal.PlainDate.from(expenseEditor.date).toString();
      const label = expenseEditor.label.trim();
      if (!label) throw new Error('Add a short description.');
      const sourceKind = expenseEditor.paymentSource.startsWith('cash-account:')
        ? 'cash-account'
        : expenseEditor.paymentSource.startsWith('credit-card:')
          ? 'credit-card'
          : undefined;
      const sourceId = sourceKind ? expenseEditor.paymentSource.slice(`${sourceKind}:`.length) : '';
      if (!sourceKind || !sourceId) {
        throw new Error('Choose the account or card used.');
      }
      const owedBy = expenseEditor.owedBy.trim();
      if (expenseEditor.owedTreatment !== 'none' && !owedBy) {
        throw new Error('Enter who owes this amount.');
      }
      const response = await window.balanceBook.recordOverviewExpense({
        paymentSource:
          sourceKind === 'cash-account'
            ? { kind: 'cash-account', accountId: sourceId }
            : { kind: 'credit-card', cardId: sourceId },
        amountCents,
        date,
        label,
        notes: expenseEditor.notes.trim() || undefined,
        owedTreatment: expenseEditor.owedTreatment,
        owedBy: expenseEditor.owedTreatment === 'none' ? undefined : owedBy,
      });
      if (!response.ok) throw new Error(response.error);
      persisted = true;
      setExpenseRecords(response.value);
      const forecast = await window.balanceBook.getForecast();
      if (!forecast.ok) throw new Error(forecast.error);
      setSnapshot(forecast.value);
      announceCanonicalDataChanged();
      invalidateAdvisorResults();
      const selectedAccount =
        sourceKind === 'cash-account'
          ? expenseRecords?.accounts.find((account) => account.id === sourceId)?.name
          : expenseRecords?.cards.find((card) => card.id === sourceId)?.name;
      const owedAmountCents =
        expenseEditor.owedTreatment === 'reimbursable'
          ? amountCents
          : expenseEditor.owedTreatment === 'shared'
            ? Math.round(amountCents / 2)
            : 0;
      setExpenseStatus(
        `${label} recorded on ${selectedAccount ?? 'the selected account'}.${
          owedAmountCents > 0 ? ` ${formatMoney(owedAmountCents)} was added to Money Owed.` : ''
        }`,
      );
      closeExpenseEditor();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'The expense could not be saved.';
      setExpenseError(
        persisted ? `The expense was saved, but Overview could not refresh: ${detail}` : detail,
      );
    } finally {
      setExpenseBusy(false);
    }
  };
  const invalidateAdvisorResults = (): void => {
    advisorRequestGenerationRef.current += 1;
    setAdvisorResults(null);
    setCashAdvisorResults(null);
    setAdvisorEvaluation(null);
    setAdvisorError(null);
    setAdvisorUnavailableCount(0);
  };
  const rememberQuickOrigin = (origin?: EventTarget | null): void => {
    if (origin instanceof HTMLElement) quickOriginRef.current = origin;
  };
  const closeQuickEditor = (): void => {
    setBalanceEditor(null);
    setCardBalanceEditor(null);
    setQuickMode('balance');
    setDetailArea('now');
    setDetailActionError(null);
    setBalanceUpdateError(null);
    setCardBalanceUpdateError(null);
    const origin = quickOriginRef.current;
    quickOriginRef.current = null;
    window.setTimeout(() => origin?.focus(), 0);
  };
  const startBalanceUpdate = (
    account: (typeof overviewCashAccounts)[number],
    origin?: EventTarget | null,
  ): void => {
    if (balanceUpdateLockRef.current) return;
    rememberQuickOrigin(origin);
    setCardBalanceEditor(null);
    setQuickMode('balance');
    setDetailArea('now');
    setQuickTransaction({
      direction: 'outflow',
      amount: '',
      label: '',
      date: currentBalanceDate,
      notes: '',
    });
    setBalanceEditor({
      accountId: account.id,
      balance: (account.balanceCents / 100).toFixed(2),
      balanceAsOf: currentBalanceDate,
    });
    setBalanceUpdateStatus(null);
    setBalanceUpdateError(null);
  };
  const saveBalanceUpdate = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!balanceEditor || balanceUpdateLockRef.current) return;
    balanceUpdateLockRef.current = true;
    setBalanceUpdatePendingAccountId(balanceEditor.accountId);
    setBalanceUpdateStatus(null);
    setBalanceUpdateError(null);
    let persisted = false;
    try {
      const balanceCents = dollarsToCents(balanceEditor.balance);
      if (!Number.isSafeInteger(balanceCents)) throw new Error('Enter a valid account balance.');
      const balanceAsOf = Temporal.PlainDate.from(balanceEditor.balanceAsOf).toString();
      if (balanceAsOf !== balanceEditor.balanceAsOf) {
        throw new Error('Choose a valid balance date.');
      }
      const recordsResult = await window.balanceBook.listRecords();
      if (!recordsResult.ok) throw new Error(recordsResult.error);
      const storedAccount = recordsResult.value.accounts.find(
        (account) => account.id === balanceEditor.accountId,
      );
      if (!storedAccount) throw new Error('That cash account is no longer available.');
      const response = await window.balanceBook.upsertRecord(
        overviewBalanceUpdateRequest(storedAccount, balanceCents, balanceAsOf),
      );
      if (!response.ok) throw new Error(response.error);
      persisted = true;
      const forecast = await window.balanceBook.getForecast();
      if (!forecast.ok) throw new Error(forecast.error);
      setSnapshot(forecast.value);
      announceCanonicalDataChanged();
      closeQuickEditor();
      setBalanceUpdateStatus(
        `${storedAccount.name} updated to ${formatMoney(balanceCents)} as of ${displayDate(balanceAsOf)}. Forecasts and spending power refreshed.`,
      );
      invalidateAdvisorResults();
    } catch (caught: unknown) {
      const detail = caught instanceof Error ? caught.message : 'The balance could not be updated.';
      setBalanceUpdateError(
        persisted ? `The balance was saved, but Overview could not refresh: ${detail}` : detail,
      );
    } finally {
      balanceUpdateLockRef.current = false;
      setBalanceUpdatePendingAccountId(null);
    }
  };
  const startCardBalanceUpdate = async (
    cardId: string,
    cardName: string,
    kind: CardBalanceEditKind,
    debt: RevolvingDebtRow | undefined,
    origin?: EventTarget | null,
  ): Promise<void> => {
    if (cardBalanceUpdateLockRef.current || cardBalanceUpdatePendingKey !== null) return;
    rememberQuickOrigin(origin);
    const pendingKey = `${cardId}:load`;
    setCardBalanceUpdatePendingKey(pendingKey);
    setBalanceEditor(null);
    setQuickMode('balance');
    setDetailArea('now');
    setCardBalanceUpdateStatus(null);
    setCardBalanceUpdateError(null);
    try {
      const recordsResult = await window.balanceBook.listRecords();
      if (!recordsResult.ok) throw new Error(recordsResult.error);
      const storedCard = recordsResult.value.cards.find((card) => card.id === cardId);
      if (!storedCard) throw new Error('That card is no longer available.');
      if (kind === 'current') {
        setCardBalanceEditor({
          cardId,
          cardName,
          kind,
          amount: (
            (debt?.currentBalanceCents ?? storedCard.reportedBalanceCents ?? 0) / 100
          ).toFixed(2),
          balanceAsOf: currentBalanceDate,
        });
        return;
      }
      const latestStatementCycle = recordsResult.value.cardCycles.find(
        (cycle) =>
          cycle.cardId === cardId &&
          cycle.closesOn === debt?.latestStatementDate &&
          cycle.lockedStatementCents !== undefined,
      );
      if (!latestStatementCycle) {
        throw new Error('Add or lock the latest statement on Cards before editing it here.');
      }
      setCardBalanceEditor({
        cardId,
        cardName,
        kind,
        amount: (latestStatementCycle.lockedStatementCents! / 100).toFixed(2),
        balanceAsOf: currentBalanceDate,
        cycleId: latestStatementCycle.id,
        dueOn: latestStatementCycle.dueOn,
      });
    } catch (caught: unknown) {
      setCardBalanceUpdateError({
        cardId,
        message:
          caught instanceof Error ? caught.message : 'The card balance editor could not open.',
      });
    } finally {
      setCardBalanceUpdatePendingKey(null);
    }
  };
  const saveCardBalanceUpdate = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!cardBalanceEditor || cardBalanceUpdateLockRef.current) return;
    cardBalanceUpdateLockRef.current = true;
    const editor = cardBalanceEditor;
    const pendingKey = `${editor.cardId}:save`;
    setCardBalanceUpdatePendingKey(pendingKey);
    setCardBalanceUpdateStatus(null);
    setCardBalanceUpdateError(null);
    let persisted = false;
    try {
      const balanceCents = dollarsToCents(editor.amount);
      if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) {
        throw new Error('Enter a valid card balance of zero or more.');
      }
      const recordsResult = await window.balanceBook.listRecords();
      if (!recordsResult.ok) throw new Error(recordsResult.error);
      let request: UpsertManagedEntityRequest;
      if (editor.kind === 'current') {
        const storedCard = recordsResult.value.cards.find((card) => card.id === editor.cardId);
        if (!storedCard) throw new Error('That card is no longer available.');
        const balanceAsOf = Temporal.PlainDate.from(editor.balanceAsOf).toString();
        request = overviewCardBalanceUpdateRequest(storedCard, balanceCents, balanceAsOf);
      } else {
        const storedCycle = recordsResult.value.cardCycles.find(
          (cycle) => cycle.id === editor.cycleId && cycle.cardId === editor.cardId,
        );
        if (!storedCycle) throw new Error('That statement cycle is no longer available.');
        request = overviewStatementBalanceUpdateRequest(storedCycle, balanceCents);
      }
      const response = await window.balanceBook.upsertRecord(request);
      if (!response.ok) throw new Error(response.error);
      persisted = true;
      const forecast = await window.balanceBook.getForecast();
      if (!forecast.ok) throw new Error(forecast.error);
      setSnapshot(forecast.value);
      announceCanonicalDataChanged();
      closeQuickEditor();
      setCardBalanceUpdateStatus({
        cardId: editor.cardId,
        message: `${editor.kind === 'current' ? 'Current balance' : 'Last statement'} updated to ${formatMoney(balanceCents)}. Forecasts and card details refreshed.`,
      });
      invalidateAdvisorResults();
    } catch (caught: unknown) {
      const detail =
        caught instanceof Error ? caught.message : 'The card balance could not be updated.';
      setCardBalanceUpdateError({
        cardId: editor.cardId,
        message: persisted
          ? `The balance was saved, but Overview could not refresh: ${detail}`
          : detail,
      });
    } finally {
      cardBalanceUpdateLockRef.current = false;
      setCardBalanceUpdatePendingKey(null);
    }
  };
  const saveQuickTransaction = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const cashAccount = balanceEditor
      ? overviewCashAccounts.find((account) => account.id === balanceEditor.accountId)
      : undefined;
    const cardRow = cardBalanceEditor
      ? cardPower.find((card) => card.cardId === cardBalanceEditor.cardId)
      : undefined;
    if (
      (!cashAccount && !cardRow) ||
      balanceUpdateLockRef.current ||
      cardBalanceUpdateLockRef.current
    )
      return;
    const cashMutation = cashAccount !== undefined;
    if (cashMutation) balanceUpdateLockRef.current = true;
    else cardBalanceUpdateLockRef.current = true;
    const pendingKey = cashMutation ? cashAccount.id : `${cardRow!.cardId}:transaction`;
    if (cashMutation) setBalanceUpdatePendingAccountId(pendingKey);
    else setCardBalanceUpdatePendingKey(pendingKey);
    setBalanceUpdateError(null);
    setCardBalanceUpdateError(null);
    let persisted = false;
    try {
      const amountCents = dollarsToCents(quickTransaction.amount);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error('Enter an amount greater than zero.');
      }
      const date = Temporal.PlainDate.from(quickTransaction.date).toString();
      const label = quickTransaction.label.trim();
      if (!label) throw new Error('Add a short description.');
      const recordsResult = await window.balanceBook.listRecords();
      if (!recordsResult.ok) throw new Error(recordsResult.error);
      const request = cashAccount
        ? overviewCashTransactionRequest(
            recordsResult.value.accounts.find((account) => account.id === cashAccount.id)!,
            {
              id: crypto.randomUUID(),
              direction: quickTransaction.direction,
              amountCents,
              label,
              date,
              notes: quickTransaction.notes.trim() || undefined,
            },
          )
        : overviewCardTransactionRequest(
            recordsResult.value.cards.find((card) => card.id === cardRow!.cardId)!,
            {
              id: crypto.randomUUID(),
              direction: quickTransaction.direction,
              amountCents,
              label,
              date,
              notes: quickTransaction.notes.trim() || undefined,
            },
          );
      const response = await window.balanceBook.upsertRecord(request);
      if (!response.ok) throw new Error(response.error);
      persisted = true;
      const forecast = await window.balanceBook.getForecast();
      if (!forecast.ok) throw new Error(forecast.error);
      setSnapshot(forecast.value);
      announceCanonicalDataChanged();
      const actionLabel = cashAccount
        ? quickTransaction.direction === 'inflow'
          ? 'Deposit'
          : 'Withdrawal'
        : quickTransaction.direction === 'outflow'
          ? 'Purchase'
          : 'Card credit';
      if (cashAccount) {
        setBalanceUpdateStatus(
          `${actionLabel} saved to ${cashAccount.name}. Every forecast view refreshed.`,
        );
      } else {
        setCardBalanceUpdateStatus({
          cardId: cardRow!.cardId,
          message: `${actionLabel} saved to ${cardRow!.cardName}. Card debt and runway refreshed without moving bank cash.`,
        });
      }
      invalidateAdvisorResults();
      closeQuickEditor();
    } catch (caught: unknown) {
      const detail =
        caught instanceof Error ? caught.message : 'The transaction could not be saved.';
      const message = persisted
        ? `The transaction was saved, but Overview could not refresh: ${detail}`
        : detail;
      if (cashAccount) setBalanceUpdateError(message);
      else setCardBalanceUpdateError({ cardId: cardRow!.cardId, message });
    } finally {
      balanceUpdateLockRef.current = false;
      cardBalanceUpdateLockRef.current = false;
      setBalanceUpdatePendingAccountId(null);
      setCardBalanceUpdatePendingKey(null);
    }
  };
  const nextFundingNeed = fundingNeeds[0];
  const nextFundingFloor = nextFundingNeed
    ? ((snapshot.cashAccounts ?? []).find((account) => account.id === nextFundingNeed.accountId)
        ?.hardFloorCents ?? 0)
    : 0;
  const cashHardFloorMargin =
    mode === 'expected'
      ? (snapshot.expectedHardFloorMarginCents ?? snapshot.hardFloorMarginCents ?? 0)
      : (snapshot.conservativeHardFloorMarginCents ?? snapshot.hardFloorMarginCents ?? 0);
  const cashPreferredFloorMargin =
    mode === 'expected'
      ? (snapshot.expectedPreferredFloorMarginCents ?? cashHardFloorMargin)
      : (snapshot.conservativePreferredFloorMarginCents ??
        snapshot.preferredFloorMarginCents ??
        cashHardFloorMargin);
  const cardPower = preferences.showCreditCards
    ? mode === 'expected'
      ? (snapshot.cardSpendingPower ?? [])
      : (snapshot.conservativeCardSpendingPower ?? snapshot.cardSpendingPower ?? [])
    : [];
  const revolvingDebtByCardId = new Map(
    (snapshot.revolvingDebtByCard ?? []).map((debt) => [debt.cardId, debt] as const),
  );
  const sortedCardPower = sortOverviewCards(
    cardPower,
    snapshot.revolvingDebtByCard ?? [],
    overviewCardSort,
  );
  const advisorCardById = new Map<string, CardPowerRow>();
  for (const card of [
    ...(snapshot.cardSpendingPower ?? []),
    ...(snapshot.conservativeCardSpendingPower ?? []),
  ]) {
    advisorCardById.set(card.cardId, card);
  }
  const allAdvisorCards = preferences.showCreditCards ? [...advisorCardById.values()] : [];
  const advisorCards = allAdvisorCards.filter(
    (card) =>
      card.purchaseAdvisorEligible &&
      (card.spendingPowerStatus === 'determinate' ||
        card.spendingPowerStatus === 'conditional-existing-shortfall'),
  );
  const advisorUnsupportedCount = allAdvisorCards.length - advisorCards.length;
  const earliestAdvisorDate =
    snapshot.startDate && snapshot.startDate > today ? snapshot.startDate : today;
  const evaluateCardAdvisor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAdvisorError(null);
    setAdvisorUnavailableCount(0);
    setAdvisorResults(null);
    setCashAdvisorResults(null);
    setAdvisorEvaluation(null);

    let amountCents: number;
    try {
      amountCents = dollarsToCents(advisorAmount);
    } catch {
      setAdvisorError('Enter a valid purchase amount.');
      return;
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      setAdvisorError('Enter a purchase amount greater than zero.');
      return;
    }
    const purchaseDate = advisorDate < earliestAdvisorDate ? earliestAdvisorDate : advisorDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      setAdvisorError(`Choose a purchase date on or after ${displayDate(earliestAdvisorDate)}.`);
      return;
    }
    if (advisorCards.length === 0 && (snapshot.cashAccounts ?? []).length === 0) {
      setAdvisorError(
        'Add a cash account or current card cycle before comparing purchase options.',
      );
      return;
    }

    const requestGeneration = ++advisorRequestGenerationRef.current;
    const evaluationMode = mode;
    setAdvisorBusy(true);
    try {
      const [outcomes, cashOutcomes] = await Promise.all([
        Promise.all(
          advisorCards.map(async (card): Promise<CardAdvisorResult | null> => {
            try {
              const response = await window.balanceBook.evaluateScenario({
                description: 'Purchase advisor comparison',
                amountCents,
                settlementDate: purchaseDate,
                fundingType: 'card',
                forecastMode: evaluationMode,
                cardId: card.cardId,
              });
              if (!response.ok) return null;
              const rewardRateBasisPoints = cardRewardRateBasisPoints(card);
              return {
                card,
                scenario: response.value,
                ...(rewardRateBasisPoints === undefined
                  ? {}
                  : {
                      rewardRateBasisPoints,
                      ...(card.rewardType === undefined ? {} : { rewardType: card.rewardType }),
                      ...(card.rewardType === 'cash-back'
                        ? {
                            estimatedRewardCents: Math.round(
                              (amountCents * rewardRateBasisPoints) / 10_000,
                            ),
                          }
                        : {}),
                    }),
              };
            } catch {
              return null;
            }
          }),
        ),
        Promise.all(
          (snapshot.cashAccounts ?? []).map(async (account): Promise<CashAdvisorResult | null> => {
            try {
              const response = await window.balanceBook.evaluateScenario({
                description: 'Cash purchase advisor comparison',
                amountCents,
                settlementDate: purchaseDate,
                fundingType: 'cash',
                forecastMode: evaluationMode,
                accountId: account.id,
              });
              return response.ok
                ? { accountId: account.id, accountName: account.name, scenario: response.value }
                : null;
            } catch {
              return null;
            }
          }),
        ),
      ]);
      if (advisorRequestGenerationRef.current !== requestGeneration) return;
      const completed = outcomes.filter(
        (outcome): outcome is CardAdvisorResult => outcome !== null,
      );
      const unavailableCount = advisorCards.length - completed.length;
      setAdvisorUnavailableCount(unavailableCount);
      const completedCash = cashOutcomes.filter(
        (outcome): outcome is CashAdvisorResult => outcome !== null,
      );
      setCashAdvisorResults(completedCash);
      if (completed.length === 0 && completedCash.length === 0) {
        setAdvisorError(
          'No cash account or current card could be evaluated for that date. Review timing and try again.',
        );
        return;
      }
      setAdvisorResults(rankAdvisorResults(completed));
      setAdvisorEvaluation({ amountCents, purchaseDate });
    } finally {
      if (advisorRequestGenerationRef.current === requestGeneration) setAdvisorBusy(false);
    }
  };
  const positionMargin = positionLow - hardFloor;
  const positionShortfall = Math.max(0, -positionMargin);
  const cashShortfall = Math.max(0, hardFloor - intradayLow);
  const expectedOverview = !fullForecast && mode === 'expected';
  const statusClass = expectedOverview
    ? positionShortfall > 0
      ? styles.statusAlert
      : ''
    : positionShortfall > 0
      ? styles.statusAlert
      : cashShortfall > 0 || fundingNeeds.length > 0
        ? styles.statusWarning
        : '';
  const statusTitle = expectedOverview
    ? positionShortfall > 0
      ? `Total position falls ${formatMoney(positionShortfall)} below your protected floor.`
      : `Your lowest total position is ${formatMoney(positionLow)}.`
    : positionShortfall > 0
      ? `Total position falls ${formatMoney(positionShortfall)} below your protected floor.`
      : cashShortfall > 0 || fundingNeeds.length > 0
        ? `Your lowest total position is ${formatMoney(positionLow)}; account funding needs attention.`
        : `Your lowest total position is ${formatMoney(positionLow)}.`;
  const statusBody = expectedOverview
    ? positionShortfall > 0
      ? `The expected total position reaches ${formatMoney(positionLow)} on ${displayDate(positionLowDate)}, which is ${formatMoney(positionShortfall)} below the protected floor.`
      : `The expected total position reaches ${formatMoney(positionLow)} on ${displayDate(positionLowDate)} and leaves ${formatMoney(positionMargin)} above the protected floor.`
    : positionShortfall > 0
      ? `Cash plus outstanding money owed reaches ${formatMoney(positionLow)} on ${displayDate(positionLowDate)}. Liquid cash reaches ${formatMoney(intradayLow)} on ${displayDate(intradayLowDate)}.`
      : cashShortfall > 0 || fundingNeeds.length > 0
        ? `Cash plus outstanding money owed reaches ${formatMoney(positionLow)} on ${displayDate(positionLowDate)}. Liquid cash reaches ${formatMoney(intradayLow)} on ${displayDate(intradayLowDate)}${fundingNeeds[0] ? `; ${fundingNeeds[0].accountName} needs ${formatMoney(fundingNeeds[0].shortfallCents)} by ${displayDate(fundingNeeds[0].date)}` : ''}. The runway and account-funding warning are shown separately so neither is hidden.`
        : `The ${mode} cash-plus-owed low occurs on ${displayDate(positionLowDate)} and leaves ${formatMoney(positionMargin)} above the protected floor; liquid cash bottoms at ${formatMoney(cashLow)} on ${displayDate(cashLowDate)}.`;
  const seriesLabel =
    series === 'position'
      ? 'Cash + money owed'
      : series === 'cash'
        ? 'Liquid cash'
        : series === 'net-worth'
          ? 'Net worth'
          : ((snapshot.cashAccounts ?? []).find(
              (account) => account.id === series.slice('account:'.length),
            )?.name ?? 'Account');
  const selectedSeriesAccount = series.startsWith('account:')
    ? (snapshot.cashAccounts ?? []).find(
        (account) => account.id === series.slice('account:'.length),
      )
    : undefined;

  const changeMode = (nextMode: ForecastMode): void => {
    if (nextMode === mode) return;
    advisorRequestGenerationRef.current += 1;
    setMode(nextMode);
    setAdvisorResults(null);
    setCashAdvisorResults(null);
    setAdvisorEvaluation(null);
    setAdvisorError(null);
    setAdvisorUnavailableCount(0);
    setAdvisorBusy(false);
  };

  const modeControl = (
    <div className={styles.segmented} role="group" aria-label="Forecast mode">
      {(['expected', 'conservative'] as const).map((item) => (
        <Button
          key={item}
          appearance={mode === item ? 'primary' : 'subtle'}
          aria-pressed={mode === item}
          onClick={() => changeMode(item)}
        >
          {item === 'expected' ? 'Expected' : 'Conservative'}
        </Button>
      ))}
    </div>
  );

  if (fullForecast) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <Text className={styles.eyebrow}>Cash forecast</Text>
            <Title1 as="h1">Cash forecast</Title1>
            <Text className={styles.detail}>
              Every daily close from {displayDate(snapshot.startDate)} through{' '}
              {displayDate(snapshot.endDate)}, with total position, liquid cash, money owed, and
              each cash account kept separate.
            </Text>
          </div>
          {modeControl}
        </header>

        <div className={mergeClasses(styles.status, statusClass)} role="status">
          <div>
            <strong>{statusTitle}</strong>
            <br />
            <Text className={styles.detail}>{statusBody}</Text>
          </div>
          <Button appearance="subtle" onClick={() => navigate('/reconcile')}>
            Check a balance
          </Button>
        </div>

        <section className={styles.metricGrid} aria-label="Forecast summary">
          <Metric
            label="Net monthly free cash flow"
            value={snapshot.longRunMonthlyFreeCashFlowCents ?? 0}
            detail={
              (snapshot.longRunMonthlyScheduledCardPaymentCents ?? 0) > 0
                ? `${formatMoney(snapshot.longRunMonthlyScheduledCardPaymentCents ?? 0)}/mo in known future card payments included`
                : 'Conservative recurring budget margin'
            }
            explanation={
              <>
                Conservative monthly change in expected cash plus Money Owed from{' '}
                {displayDate(snapshot.longRunCashFlowWindowStart)} through{' '}
                {displayDate(snapshot.longRunCashFlowWindowEnd)}. Balance Book scans a clean future
                year after current card activity and the next two calendar months clear, then uses
                its weakest three-month average so extra-paycheck months and later debt payoffs do
                not inflate today's base budget. Recurring income, shared-expense offsets, bills,
                loans, baseline card spending, and known future card payments remain included.
                {(snapshot.longRunMonthlyScheduledCardPaymentCents ?? 0) > 0 &&
                  snapshot.longRunMonthlyBeforeScheduledCardPaymentCents !== undefined &&
                  ` Before specifically scheduled card payments, the same base budget is ${formatMoney(snapshot.longRunMonthlyBeforeScheduledCardPaymentCents)} per month.`}
              </>
            }
          />
          <Metric
            label={`${mode === 'expected' ? 'Expected' : 'Conservative'} position low`}
            value={positionLow}
            detail={displayDate(positionLowDate)}
            explanation={`${mode === 'expected' ? 'Expected' : 'Conservative'} daily available cash plus Money Owed on each date; this is the lowest total within the visible forecast.`}
          />
          <Metric
            label="Liquid cash low"
            value={cashLow}
            detail={displayDate(cashLowDate)}
            explanation="Lowest daily close across cash accounts counted as available cash. The status warning also checks the safest ordering of same-day activity."
          />
          <Metric
            label="Money owed now"
            value={currentOwed}
            detail="Tracked separately from cash until received"
            explanation="Money Owed at the forecast start. New amounts change Money Owed; recorded receipts reduce Money Owed and add cash together."
          />
          <Metric
            label="Protected floor"
            value={hardFloor}
            detail={`Intraday cash low ${formatMoney(intradayLow)}`}
            explanation={`The higher of your ${formatMoney(snapshot.accountHardFloorTotalCents ?? 0)} included-account minimum total and ${formatMoney(snapshot.configuredHardFloorCents ?? 0)} consolidated override, compared against the lowest cash state after conservatively ordered same-day events.`}
          />
        </section>

        <section className={styles.panel} aria-labelledby="forecast-chart-title">
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Title2 id="forecast-chart-title" as="h2">
                {seriesLabel}
              </Title2>
              <Text className={styles.detail}>
                Low {formatMoney(chartLow.valueCents)} on {displayDate(chartLow.date)}
              </Text>
            </div>
            <div className={styles.segmented} role="group" aria-label="Forecast series">
              <Button
                appearance={series === 'position' ? 'primary' : 'subtle'}
                aria-pressed={series === 'position'}
                onClick={() => setSeries('position')}
              >
                Total position
              </Button>
              <Button
                appearance={series === 'cash' ? 'primary' : 'subtle'}
                aria-pressed={series === 'cash'}
                onClick={() => setSeries('cash')}
              >
                Liquid cash
              </Button>
              {(snapshot.cashAccounts ?? []).map((account) => (
                <Button
                  key={account.id}
                  disabled={
                    !(snapshot.dailyCash ?? []).some((point) =>
                      point.accountBalances.some(
                        (balance) => balance.accountId === account.id && balance.available,
                      ),
                    )
                  }
                  appearance={series === `account:${account.id}` ? 'primary' : 'subtle'}
                  aria-pressed={series === `account:${account.id}`}
                  onClick={() => setSeries(`account:${account.id}`)}
                >
                  {account.name}
                </Button>
              ))}
              <Button
                disabled={
                  !(snapshot.dailyCash ?? []).some((point) =>
                    mode === 'expected'
                      ? point.expectedNetWorthCents !== undefined
                      : point.conservativeNetWorthCents !== undefined,
                  )
                }
                appearance={series === 'net-worth' ? 'primary' : 'subtle'}
                aria-pressed={series === 'net-worth'}
                onClick={() => setSeries('net-worth')}
              >
                Net worth
              </Button>
            </div>
          </div>
          <div className={styles.chart} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 24, right: 20, bottom: 0, left: 6 }}>
                <CartesianGrid vertical={false} stroke={tokens.colorNeutralStroke2} />
                <XAxis
                  dataKey="date"
                  minTickGap={34}
                  tickFormatter={(value: string) => value.slice(5)}
                  stroke={tokens.colorNeutralForeground3}
                />
                <YAxis
                  width={62}
                  tickFormatter={(value: number) => {
                    if (Math.abs(value) < 1000) return `$${Math.round(value)}`;
                    const thousands = value / 1000;
                    return `$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
                  }}
                  stroke={tokens.colorNeutralForeground3}
                />
                <Tooltip
                  labelFormatter={(value) => displayDate(String(value))}
                  formatter={(value) => [formatMoney(Number(value) * 100), seriesLabel]}
                  contentStyle={{
                    color: tokens.colorNeutralForeground1,
                    backgroundColor: tokens.colorNeutralBackground1,
                    border: `1px solid ${tokens.colorNeutralStroke1}`,
                    borderRadius: tokens.borderRadiusLarge,
                    boxShadow: tokens.shadow8,
                  }}
                  labelStyle={{ color: tokens.colorNeutralForeground2 }}
                  itemStyle={{ color: tokens.colorBrandForeground1 }}
                />
                {series === 'cash' && (
                  <>
                    {preferredFloor !== undefined && (
                      <ReferenceLine
                        y={preferredFloor / 100}
                        label={{ value: 'Preferred buffer', position: 'insideBottomLeft' }}
                        stroke={tokens.colorPaletteDarkOrangeForeground2}
                        strokeDasharray="2 4"
                      />
                    )}
                    <ReferenceLine
                      y={hardFloor / 100}
                      label={{ value: 'Protected floor', position: 'insideTopLeft' }}
                      stroke={tokens.colorPaletteRedForeground1}
                      strokeDasharray="5 4"
                    />
                  </>
                )}
                {selectedSeriesAccount && (
                  <>
                    {selectedSeriesAccount.preferredFloorCents !== undefined && (
                      <ReferenceLine
                        y={selectedSeriesAccount.preferredFloorCents / 100}
                        label={{ value: 'Account preferred', position: 'insideBottomLeft' }}
                        stroke={tokens.colorPaletteDarkOrangeForeground2}
                        strokeDasharray="2 4"
                      />
                    )}
                    <ReferenceLine
                      y={selectedSeriesAccount.hardFloorCents / 100}
                      label={{ value: 'Account minimum', position: 'insideTopLeft' }}
                      stroke={tokens.colorPaletteRedForeground1}
                      strokeDasharray="5 4"
                    />
                  </>
                )}
                <ReferenceDot
                  x={chartLow.date}
                  y={chartLow.value}
                  r={5}
                  label={{ value: 'Low', position: 'top' }}
                  fill={tokens.colorBrandBackground}
                  stroke={tokens.colorNeutralBackground1}
                />
                <Line
                  type="stepAfter"
                  dataKey="value"
                  name={seriesLabel}
                  stroke={tokens.colorBrandForeground1}
                  strokeWidth={3}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="daily-ledger-title">
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Title2 id="daily-ledger-title" as="h2">
                Daily closes
              </Title2>
              <Text className={styles.detail}>
                Total position equals liquid cash plus open money owed. Liquid cash equals the cash
                account columns plus any transfer still in transit.
              </Text>
              <Text size={200} className={styles.detail}>
                {mode === 'expected'
                  ? `Expected currently depends on ${(snapshot.dependencies ?? []).length} nonconfirmed cash event${(snapshot.dependencies ?? []).length === 1 ? '' : 's'}. Each event below says whether it affects both forecasts or only one.`
                  : 'Conservative keeps active cash outflows but removes unconfirmed inflows unless you explicitly include them. Each event below says whether it affects both forecasts or only one.'}
              </Text>
            </div>
            <Button appearance="subtle" onClick={() => navigate('/records')}>
              Edit forecast records
            </Button>
          </div>
          <div className={mergeClasses(styles.tableViewport, styles.desktopLedger)} tabIndex={0}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className={styles.money}>Total position</th>
                  <th className={styles.money}>Liquid cash</th>
                  <th className={styles.money}>In transfer</th>
                  <th className={styles.money}>Money owed</th>
                  {(snapshot.cashAccounts ?? []).map((account) => (
                    <th className={styles.money} key={account.id}>
                      {account.name}
                    </th>
                  ))}
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.dailyCash ?? []).map((point) => {
                  const position =
                    mode === 'expected'
                      ? point.expectedPositionCents
                      : point.conservativePositionCents;
                  const cash =
                    mode === 'expected' ? point.expectedCashCents : point.conservativeCashCents;
                  const inTransit =
                    mode === 'expected'
                      ? point.expectedInTransitCents
                      : point.conservativeInTransitCents;
                  const owed =
                    mode === 'expected'
                      ? point.expectedReceivableCents
                      : point.conservativeReceivableCents;
                  return (
                    <tr key={point.date}>
                      <td>{displayDate(point.date)}</td>
                      <td className={styles.money}>{formatMoney(position)}</td>
                      <td className={styles.money}>{formatMoney(cash)}</td>
                      <td className={styles.money}>{formatMoney(inTransit)}</td>
                      <td className={styles.money}>{formatMoney(owed)}</td>
                      {(snapshot.cashAccounts ?? []).map((account) => {
                        const balance = point.accountBalances.find(
                          (candidate) => candidate.accountId === account.id,
                        );
                        return (
                          <td className={styles.money} key={account.id}>
                            {balance?.available ? (
                              formatMoney(
                                mode === 'expected'
                                  ? balance.expectedCashCents
                                  : balance.conservativeCashCents,
                              )
                            ) : (
                              <span aria-label="Balance unavailable">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className={styles.eventCell}>
                        {point.events.length === 0
                          ? '—'
                          : point.events.map((event) => (
                              <span className={styles.eventLine} key={event.id}>
                                <span className={styles.eventHeading}>
                                  <button
                                    type="button"
                                    className={styles.eventTraceButton}
                                    aria-label={`Trace ${event.label} to its source record`}
                                    onClick={() => navigate(forecastEventSourcePath(event))}
                                  >
                                    {event.label}{' '}
                                    <strong>
                                      {formatMoney(
                                        event.direction === 'outflow'
                                          ? -event.amountCents
                                          : event.amountCents,
                                      )}
                                    </strong>
                                  </button>
                                  <span
                                    className={styles.eventState}
                                    aria-label={`${event.label} on ${point.date} event state`}
                                    title={`Stored status: ${event.status}; certainty: ${event.certainty}${event.hypothetical ? '; hypothetical' : ''}`}
                                  >
                                    {displayEventState(event.displayState)}
                                  </span>
                                </span>
                                <span className={styles.eventScope}>
                                  {event.accountName} · {eventForecastScope(event)}
                                </span>
                              </span>
                            ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.mobileLedger} aria-label={`Daily closes for ${seriesLabel}`}>
            {(snapshot.dailyCash ?? []).map((point, index, points) => {
              const selectedValue = valueForSeries(point, mode, series);
              const priorValue =
                index > 0 ? valueForSeries(points[index - 1]!, mode, series) : null;
              const dailyChange = priorValue === null ? null : selectedValue - priorValue;
              const position =
                mode === 'expected' ? point.expectedPositionCents : point.conservativePositionCents;
              const cash =
                mode === 'expected' ? point.expectedCashCents : point.conservativeCashCents;
              const inTransit =
                mode === 'expected'
                  ? point.expectedInTransitCents
                  : point.conservativeInTransitCents;
              const owed =
                mode === 'expected'
                  ? point.expectedReceivableCents
                  : point.conservativeReceivableCents;
              return (
                <details className={styles.mobileLedgerDay} key={point.date}>
                  <summary>
                    <span className={styles.heading}>
                      <strong>{displayDate(point.date)}</strong>
                      <Text size={200} className={styles.detail}>
                        {seriesLabel}
                      </Text>
                    </span>
                    <span className={styles.mobileLedgerAmount}>
                      <strong>{formatMoney(selectedValue)}</strong>
                      <Text size={200} className={styles.detail}>
                        {dailyChange === null
                          ? 'Opening day'
                          : `${dailyChange >= 0 ? '+' : ''}${formatMoney(dailyChange)} that day`}
                      </Text>
                    </span>
                  </summary>
                  <div className={styles.mobileLedgerDetails}>
                    <div className={styles.mobileLedgerFacts}>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Total position
                        </Text>
                        <Text className={styles.factValue}>{formatMoney(position)}</Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Liquid cash
                        </Text>
                        <Text className={styles.factValue}>{formatMoney(cash)}</Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Money owed
                        </Text>
                        <Text className={styles.factValue}>{formatMoney(owed)}</Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          In transfer
                        </Text>
                        <Text className={styles.factValue}>{formatMoney(inTransit)}</Text>
                      </div>
                      {(snapshot.cashAccounts ?? []).map((account) => {
                        const balance = point.accountBalances.find(
                          (candidate) => candidate.accountId === account.id,
                        );
                        return (
                          <div
                            className={styles.fact}
                            key={account.id}
                            aria-label={`${account.name} balance on ${point.date}`}
                          >
                            <Text size={200} className={styles.metricLabel}>
                              {account.name}
                            </Text>
                            <Text className={styles.factValue}>
                              {balance?.available
                                ? formatMoney(
                                    mode === 'expected'
                                      ? balance.expectedCashCents
                                      : balance.conservativeCashCents,
                                  )
                                : 'Unavailable'}
                            </Text>
                          </div>
                        );
                      })}
                    </div>
                    <div className={styles.mobileLedgerEvents}>
                      <Text className={styles.metricLabel}>Events</Text>
                      {point.events.length === 0 ? (
                        <Text className={styles.detail}>No modeled cash movement.</Text>
                      ) : (
                        point.events.map((event) => (
                          <span className={styles.eventLine} key={event.id}>
                            <span className={styles.eventHeading}>
                              <button
                                type="button"
                                className={styles.eventTraceButton}
                                aria-label={`Trace ${event.label} to its source record`}
                                onClick={() => navigate(forecastEventSourcePath(event))}
                              >
                                {event.label}{' '}
                                <strong>
                                  {formatMoney(
                                    event.direction === 'outflow'
                                      ? -event.amountCents
                                      : event.amountCents,
                                  )}
                                </strong>
                              </button>
                              <span className={styles.eventState}>
                                {displayEventState(event.displayState)}
                              </span>
                            </span>
                            <span className={styles.eventScope}>
                              {event.accountName} · {eventForecastScope(event)}
                            </span>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
          <details className={styles.explain}>
            <summary>Expected, conservative, and event states</summary>
            <Text>
              Expected includes confirmed and expected cash inflows plus every active cash outflow;
              uncertain inflows stay out. Conservative includes confirmed inflows allowed by your
              forecast policy plus every active cash outflow. A confirmed inflow can be deliberately
              excluded, but an expected or uncertain inflow cannot be forced into protected cash.
              Noncash card activity, payroll deductions, inactive records, and unaccepted
              hypotheticals do not move cash. Actual means recorded or paid, Locked means a
              confirmed scheduled amount and date, Estimated is not yet confirmed, Planned is
              confirmed but not locked to a schedule, and Hypothetical marks a scenario.
            </Text>
          </details>
          <details className={styles.explain}>
            <summary>How this maps to the workbook oracle</summary>
            <Text>
              Total position corresponds to the workbook&apos;s Balance total. Liquid cash is the
              sum of cash-account columns plus cash still owned while an internal transfer is in
              transit. Money owed is a separate noncash asset that increases only through its own
              accrual schedule and becomes cash only through a settlement record. The application
              calculates every series natively; the workbook is used only to test the result.
            </Text>
          </details>
        </section>
      </div>
    );
  }

  const quickCashAccount = balanceEditor
    ? overviewCashAccounts.find((account) => account.id === balanceEditor.accountId)
    : undefined;
  const quickCard = cardBalanceEditor
    ? cardPower.find((card) => card.cardId === cardBalanceEditor.cardId)
    : undefined;
  const quickCardDebt = quickCard ? revolvingDebtByCardId.get(quickCard.cardId) : undefined;
  const quickAmountCents = Number.isFinite(Number(quickTransaction.amount))
    ? Math.max(0, Math.round(Number(quickTransaction.amount) * 100))
    : 0;
  const quickTransactionDelta = quickTransaction.direction === 'inflow' ? 1 : -1;
  const quickCashPreviewCents = quickCashAccount
    ? quickCashAccount.balanceCents + quickTransactionDelta * quickAmountCents
    : 0;
  const quickCardPreviewCents = quickCardDebt
    ? Math.max(0, quickCardDebt.currentBalanceCents - quickTransactionDelta * quickAmountCents)
    : 0;
  const quickCardCyclePreviewCents = quickCardDebt
    ? Math.max(0, quickCardDebt.actualOpenCycleCents - quickTransactionDelta * quickAmountCents)
    : 0;
  const expenseAmountCents =
    expenseEditor && Number.isFinite(Number(expenseEditor.amount))
      ? Math.max(0, Math.round(Number(expenseEditor.amount) * 100))
      : 0;
  const expenseOwedCents =
    expenseEditor?.owedTreatment === 'reimbursable'
      ? expenseAmountCents
      : expenseEditor?.owedTreatment === 'shared'
        ? Math.round(expenseAmountCents / 2)
        : 0;
  const expenseCashAccount = expenseEditor?.paymentSource.startsWith('cash-account:')
    ? expenseRecords?.accounts.find(
        (account) => account.id === expenseEditor.paymentSource.slice('cash-account:'.length),
      )
    : undefined;
  const expenseCard = expenseEditor?.paymentSource.startsWith('credit-card:')
    ? expenseRecords?.cards.find(
        (card) => card.id === expenseEditor.paymentSource.slice('credit-card:'.length),
      )
    : undefined;
  const expenseCardDebt = expenseCard ? revolvingDebtByCardId.get(expenseCard.id) : undefined;
  const expenseCashPosition = expenseCashAccount
    ? snapshot.cashAccounts?.find((account) => account.id === expenseCashAccount.id)
    : undefined;
  const expenseDateMinimum = expenseCashAccount?.balanceAsOf ?? expenseCard?.reportedBalanceDate;
  const detailEvents = (detailRecords?.events ?? [])
    .filter((event) =>
      quickCashAccount
        ? event.accountId === quickCashAccount.id && event.paymentMethod !== 'credit-card'
        : event.cardId === quickCard?.cardId,
    )
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id))
    .slice(0, 6);
  const detailCycles = (detailRecords?.cardCycles ?? [])
    .filter((cycle) => cycle.cardId === quickCard?.cardId)
    .sort((left, right) => right.closesOn.localeCompare(left.closesOn))
    .slice(0, 4);
  const detailSourcePosition = quickCashAccount
    ? buildAccountPositionReadModel(quickCashAccount)
    : quickCardDebt
      ? buildCardPositionReadModel(quickCardDebt)
      : null;
  const detailRelatedRecordIds = new Set([
    ...(quickCashAccount ? [quickCashAccount.id] : []),
    ...(quickCard ? [quickCard.cardId] : []),
    ...detailEvents.map((event) => event.id),
    ...detailCycles.map((cycle) => cycle.id),
  ]);
  const detailAudits = detailAuditHistory
    .filter((event) => detailRelatedRecordIds.has(event.entityId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4);
  const reverseDetailActivity = async (activity: (typeof detailEvents)[number]): Promise<void> => {
    if (detailActionBusy) return;
    setDetailActionBusy(true);
    setDetailActionError(null);
    try {
      const response = await window.balanceBook.upsertRecord(
        compensatingForecastEventRequest(
          activity,
          `reversal-${crypto.randomUUID()}`,
          currentBalanceDate,
        ),
      );
      if (!response.ok) throw new Error(response.error);
      setDetailRecords(response.value);
      const forecast = await window.balanceBook.getForecast();
      if (!forecast.ok) throw new Error(forecast.error);
      setSnapshot(forecast.value);
      announceCanonicalDataChanged();
      invalidateAdvisorResults();
    } catch (caught) {
      setDetailActionError(
        caught instanceof Error ? caught.message : 'The compensating reversal could not be saved.',
      );
    } finally {
      setDetailActionBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Text className={styles.eyebrow}>Overview</Text>
          <Title1 as="h1">How much can I safely spend?</Title1>
          <Text className={styles.detail}>
            Today&apos;s card runway, account coverage, and protected threshold in one view.
          </Text>
        </div>
        {modeControl}
      </header>

      <div className={mergeClasses(styles.status, statusClass)} role="status">
        <div>
          <strong>{statusTitle}</strong>
          <br />
          <Text className={styles.detail}>{statusBody}</Text>
        </div>
        <Button appearance="subtle" onClick={() => navigate('/forecast')}>
          Inspect every day
        </Button>
      </div>

      <section
        className={mergeClasses(styles.panel, styles.dailyCashQuick)}
        aria-label="Overview cash accounts"
      >
        <div className={styles.sectionHeader}>
          <div className={styles.heading}>
            <Text className={styles.eyebrow}>Checking balances</Text>
            <Title2 as="h2">Update today&apos;s balances</Title2>
            <Text className={styles.detail}>
              Enter the balance shown by your bank. Forecasts and card runway refresh immediately.
            </Text>
          </div>
          {!preferences.showCreditCards && (
            <Button
              appearance="outline"
              disabled={expenseBusy || Boolean(expenseEditor)}
              onClick={(event) => void startExpenseEditor(event.currentTarget)}
            >
              {expenseBusy && !expenseEditor ? 'Opening…' : 'Log an expense'}
            </Button>
          )}
        </div>
        {balanceUpdateStatus && (
          <div className={styles.balanceStatus} role="status">
            {balanceUpdateStatus}
          </div>
        )}
        {balanceUpdateError && (
          <div className={styles.error} role="alert">
            {balanceUpdateError}
          </div>
        )}
        <div className={styles.accountRows}>
          {overviewCashAccounts.map((account) => {
            const position = buildAccountPositionReadModel(account);
            return (
              <div
                className={mergeClasses(styles.accountRow, styles.quickOpenSurface)}
                key={account.id}
                aria-label={`${account.name} balance summary`}
              >
                <button
                  type="button"
                  className={`${styles.quickOpenHit} quick-open-hit`}
                  aria-label={`Open quick update for ${account.name}`}
                  onClick={(event) => startBalanceUpdate(account, event.currentTarget)}
                />
                <div className={styles.accountHeader}>
                  <strong>{account.name}</strong>
                  <span className={styles.quickOpenHint}>Update</span>
                </div>
                <span className={styles.factValue}>
                  {formatMoney(position.calculatedBalanceCents)}
                </span>
                <span className={styles.accountLow}>
                  Calculated through {displayDate(position.calculatedThroughDate)}
                </span>
                <details className={styles.explain}>
                  <summary>
                    Source {formatMoney(position.sourceBalanceCents)} ·{' '}
                    {displayDate(position.sourceBalanceDate)}
                    {position.freshness === 'stale' ? ' · stale' : ''}
                  </summary>
                  <Text size={200}>
                    Net activity since reported: {formatMoney(position.postSourceChangeCents)}.
                  </Text>
                </details>
              </div>
            );
          })}
          {overviewCashAccounts.length === 0 && (
            <div className={styles.empty}>
              <Text>No checking accounts are currently shown on Overview.</Text>
              <Button appearance="subtle" onClick={() => navigate('/data')}>
                Choose visible accounts
              </Button>
            </div>
          )}
        </div>
      </section>

      {preferences.showCreditCards && (
        <section className={styles.safeSpendHero} aria-labelledby="safe-spend-title">
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Your card runway</Text>
              <Title2 id="safe-spend-title" as="h2">
                Safe to spend on each card today
              </Title2>
              <Text className={styles.detail}>
                Each card has its own runway. Do not add the amounts together.
              </Text>
              <details className={styles.explain}>
                <summary>How available spend works</summary>
                <Text size={200}>
                  Available spend is the lowest projected total position from that card&apos;s
                  current-cycle due date forward, less your protected threshold. Account lows cover
                  the same current-cycle risk window; later shortfalls stay in Account coverage.
                  Current balance is posted card debt. Last statement preserves the latest issuer
                  statement. Still owed appears only while a card is carrying statement debt and
                  reports that carried amount after confirmed or paid payments. Projected lows show
                  open money owed at the same date as the limiting total position. Next statement
                  position looks one cycle past the statement that today&apos;s spending will enter,
                  then shows the lowest total cash plus open money owed from that following due date
                  forward.
                </Text>
              </details>
            </div>
            <div className={styles.cardHeaderActions}>
              <Field className={styles.cardSortField} label="Sort cards">
                <Select
                  aria-label="Overview card sort order"
                  value={overviewCardSort}
                  onChange={(event) =>
                    setOverviewCardSort(event.currentTarget.value as OverviewCardSort)
                  }
                >
                  <option value="period-asc">Period remaining · low to high</option>
                  <option value="period-desc">Period remaining · high to low</option>
                  <option value="name-asc">Name · A to Z</option>
                  <option value="name-desc">Name · Z to A</option>
                  <option value="available-desc">Available spend · high to low</option>
                  <option value="available-asc">Available spend · low to high</option>
                  <option value="balance-desc">Current balance · high to low</option>
                  <option value="balance-asc">Current balance · low to high</option>
                  <option value="statement-desc">Last statement · high to low</option>
                  <option value="statement-asc">Last statement · low to high</option>
                </Select>
              </Field>
              <Button
                appearance="outline"
                disabled={expenseBusy || Boolean(expenseEditor)}
                onClick={(event) => void startExpenseEditor(event.currentTarget)}
              >
                {expenseBusy && !expenseEditor ? 'Opening…' : 'Log an expense'}
              </Button>
              <Button
                appearance="primary"
                onClick={() => document.getElementById('card-advisor-title')?.scrollIntoView()}
              >
                Test a purchase
              </Button>
            </div>
          </div>
          {expenseStatus && (
            <div className={styles.balanceStatus} role="status">
              {expenseStatus}
            </div>
          )}
          {expenseError && !expenseEditor && (
            <div className={styles.error} role="alert">
              {expenseError}
            </div>
          )}
          {cardPower.length === 0 ? (
            <Card className={styles.empty}>
              Add a card, current cycle, payment rule, and funding account to calculate a safe
              amount.
            </Card>
          ) : (
            <div className={styles.safeSpendGrid}>
              {sortedCardPower.map((card) => {
                const resetDate = card.currentCycleClosesOn;
                const resetDayDifference = resetDate
                  ? Temporal.PlainDate.from(today).until(Temporal.PlainDate.from(resetDate), {
                      largestUnit: 'day',
                    }).days
                  : undefined;
                const daysUntilReset =
                  resetDayDifference !== undefined && resetDayDifference >= 0
                    ? resetDayDifference
                    : undefined;
                const resetTimingText = !resetDate
                  ? 'Reset timing unavailable'
                  : resetDayDifference! < 0
                    ? `Reset date needs update · ${displayDate(resetDate)}`
                    : daysUntilReset === 0
                      ? 'Resets today'
                      : `Resets in ${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}`;
                const dueDayDifference = card.nextDueOn
                  ? Temporal.PlainDate.from(today).until(Temporal.PlainDate.from(card.nextDueOn), {
                      largestUnit: 'day',
                    }).days
                  : undefined;
                const debt = revolvingDebtByCardId.get(card.cardId);
                const cardPosition = debt ? buildCardPositionReadModel(debt) : undefined;
                const hasPastDueDebt =
                  dueDayDifference !== undefined &&
                  dueDayDifference < 0 &&
                  debt?.overdue === true &&
                  debt.amountCurrentlyDueCents > 0;
                const dueTimingText = !card.nextDueOn
                  ? 'Due date unavailable'
                  : dueDayDifference! < 0
                    ? hasPastDueDebt
                      ? `Past due ${displayDate(card.nextDueOn)}`
                      : `Paid · ${displayDate(card.nextDueOn)}`
                    : dueDayDifference === 0
                      ? `Due today · ${displayDate(card.nextDueOn)}`
                      : `Due ${displayDate(card.nextDueOn)}`;
                const unavailableReason = cardSpendingPowerUnavailableReason(card);
                const hasStatement = Boolean(debt?.latestStatementDate);
                const showStillOwed = hasStatement && (debt?.carryingBalanceCents ?? 0) > 0;
                const fundingFloor =
                  (snapshot.cashAccounts ?? []).find(
                    (account) => account.id === card.fundingAccountId,
                  )?.hardFloorCents ?? 0;
                const fundingShortfall = Math.max(0, fundingFloor - card.fundingAccountLowCents);
                const conditionalOnEarlierFunding =
                  card.spendingPowerStatus === 'conditional-existing-shortfall';
                const earlierShortfallAccount = card.prePaymentShortfallAccountId
                  ? (snapshot.cashAccounts ?? []).find(
                      (account) => account.id === card.prePaymentShortfallAccountId,
                    )?.name
                  : undefined;
                const runwayAvailable = !unavailableReason && card.spendingPowerCents > 0;
                const safelyFunded =
                  runwayAvailable && !conditionalOnEarlierFunding && fundingShortfall === 0;
                const visuallySafe = mode === 'expected' ? runwayAvailable : safelyFunded;
                const fundingInsight = conditionalOnEarlierFunding
                  ? `${earlierShortfallAccount ?? 'A cash account'} falls ${formatMoney(card.prePaymentShortfallCents)} below its minimum on ${displayDate(card.prePaymentShortfallDate)} before this card would be paid.`
                  : fundingShortfall > 0
                    ? `${card.fundingAccountName} needs ${formatMoney(fundingShortfall)} to stay above its minimum.`
                    : null;
                return (
                  <Card
                    key={card.cardId}
                    aria-label={`${card.cardName} safe spending summary`}
                    className={mergeClasses(
                      styles.safeSpendCard,
                      styles.quickOpenSurface,
                      visuallySafe ? styles.safeSpendCardSafe : styles.safeSpendCardCaution,
                    )}
                  >
                    <button
                      type="button"
                      className={`${styles.quickOpenHit} quick-open-hit`}
                      aria-label={`Open quick update for ${card.cardName}`}
                      onClick={(event) =>
                        void startCardBalanceUpdate(
                          card.cardId,
                          card.cardName,
                          'current',
                          debt,
                          event.currentTarget,
                        )
                      }
                    />
                    <div className={styles.powerTop}>
                      <div className={styles.cardTitleRow}>
                        <span
                          className={styles.resetBadge}
                          aria-label={
                            resetDate && resetDayDifference! >= 0
                              ? `${daysUntilReset} days until the current statement resets on ${displayDate(resetDate)}`
                              : resetDate
                                ? `Recorded statement reset date passed on ${displayDate(resetDate)}`
                                : 'Statement reset date unavailable'
                          }
                          title={
                            resetDate && resetDayDifference! >= 0
                              ? `${daysUntilReset} days until statement close · ${displayDate(resetDate)}`
                              : resetDate
                                ? `Update the current cycle · recorded close ${displayDate(resetDate)}`
                                : 'Add the current cycle close date'
                          }
                        >
                          {daysUntilReset ?? (resetDate ? '!' : '–')}
                        </span>
                        <div className={styles.heading}>
                          <strong>{card.cardName}</strong>
                          <span className={styles.quickOpenHint}>Update</span>
                          <div className={styles.cardTimingRow}>
                            {(resetDayDifference === undefined || resetDayDifference <= 0) && (
                              <Text
                                size={200}
                                className={mergeClasses(
                                  styles.detail,
                                  resetDayDifference !== undefined && resetDayDifference < 0
                                    ? styles.warningText
                                    : undefined,
                                )}
                              >
                                {resetTimingText}
                              </Text>
                            )}
                            <Text
                              size={200}
                              aria-label={`${card.cardName} next due date`}
                              className={mergeClasses(
                                styles.detail,
                                hasPastDueDebt ? styles.dangerText : undefined,
                              )}
                            >
                              {dueTimingText}
                            </Text>
                            {mode === 'conservative' && (
                              <Text size={200} className={styles.detail}>
                                Paid from {card.fundingAccountName}
                              </Text>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div>
                      <Text className={styles.metricLabel}>Available this cycle</Text>
                      <Text
                        aria-label={`${card.cardName} available spend`}
                        className={mergeClasses(
                          styles.safeSpendAmount,
                          card.spendingPowerCents > 0 ? undefined : styles.warningText,
                        )}
                      >
                        {unavailableReason ? 'Unavailable' : formatMoney(card.spendingPowerCents)}
                      </Text>
                    </div>
                    <div
                      className={styles.cardBalanceGrid}
                      data-layout-watch="overview-card-balances"
                      aria-label={`${card.cardName} balance details`}
                    >
                      <div className={styles.cardBalanceStat}>
                        <div className={styles.cardBalanceStatHeader}>
                          <Text size={200} className={styles.metricLabel}>
                            Current balance
                          </Text>
                          <Button
                            appearance="subtle"
                            size="small"
                            className={styles.compactEditButton}
                            disabled={
                              cardBalanceUpdatePendingKey !== null ||
                              balanceUpdatePendingAccountId !== null
                            }
                            aria-label={`Edit current total for ${card.cardName}`}
                            onClick={() =>
                              void startCardBalanceUpdate(
                                card.cardId,
                                card.cardName,
                                'current',
                                debt,
                              )
                            }
                          >
                            Edit
                          </Button>
                        </div>
                        <Text
                          aria-label={`${card.cardName} current balance`}
                          className={styles.cardBalanceValue}
                        >
                          {debt ? formatMoney(debt.currentBalanceCents) : '—'}
                        </Text>
                        {cardPosition && (
                          <Text size={200} className={styles.detail}>
                            Calculated through {displayDate(cardPosition.calculatedThroughDate)}
                          </Text>
                        )}
                      </div>
                      <div className={styles.cardBalanceStat}>
                        <div className={styles.cardBalanceStatHeader}>
                          <Text size={200} className={styles.metricLabel}>
                            Last statement
                          </Text>
                          <Button
                            appearance="subtle"
                            size="small"
                            className={styles.compactEditButton}
                            disabled={
                              !hasStatement ||
                              cardBalanceUpdatePendingKey !== null ||
                              balanceUpdatePendingAccountId !== null
                            }
                            aria-label={`Edit last statement for ${card.cardName}`}
                            onClick={() =>
                              void startCardBalanceUpdate(
                                card.cardId,
                                card.cardName,
                                'statement',
                                debt,
                              )
                            }
                          >
                            Edit
                          </Button>
                        </div>
                        <Text
                          aria-label={`${card.cardName} last statement balance`}
                          className={styles.cardBalanceValue}
                        >
                          {hasStatement ? formatMoney(debt!.latestStatementCents) : '—'}
                        </Text>
                      </div>
                      {showStillOwed && (
                        <div className={styles.cardBalanceStat}>
                          <Text
                            size={200}
                            className={styles.metricLabel}
                            title="Shown only while this card is carrying statement debt"
                          >
                            Still owed
                          </Text>
                          <Text
                            aria-label={`${card.cardName} still owed on statements`}
                            className={mergeClasses(styles.cardBalanceValue, styles.stillOwedValue)}
                          >
                            {formatMoney(debt!.carryingBalanceCents)}
                          </Text>
                        </div>
                      )}
                    </div>
                    {cardBalanceUpdateStatus?.cardId === card.cardId && (
                      <div className={styles.balanceStatus} role="status">
                        {cardBalanceUpdateStatus.message}
                      </div>
                    )}
                    {cardBalanceUpdateError?.cardId === card.cardId && (
                      <div className={styles.error} role="alert">
                        {cardBalanceUpdateError.message}
                      </div>
                    )}
                    {cardPosition && (
                      <details className={styles.explain}>
                        <summary>
                          {cardPosition.sourceBalanceDate
                            ? `Issuer source ${formatMoney(cardPosition.sourceBalanceCents ?? 0)} · ${displayDate(cardPosition.sourceBalanceDate)}${cardPosition.freshness === 'stale' ? ' · stale' : ''}`
                            : 'Issuer source balance unavailable'}
                        </summary>
                        <Text size={200}>
                          {cardPosition.postSourceActivityCents === undefined
                            ? 'No dated issuer source is available for a net-activity comparison.'
                            : `Net card activity since reported: ${formatMoney(cardPosition.postSourceActivityCents)}.`}
                        </Text>
                      </details>
                    )}
                    <div
                      className={styles.nextStatementPosition}
                      aria-label={`${card.cardName} next statement position`}
                    >
                      <div className={styles.heading}>
                        <Text size={200} className={styles.metricLabel}>
                          Next statement position
                        </Text>
                        <Text size={200} className={styles.detail}>
                          {card.nextStatementDueOn
                            ? `Lowest from ${displayDate(card.nextStatementDueOn)} forward`
                            : 'Due date unavailable'}
                        </Text>
                      </div>
                      <Text className={styles.factValue}>
                        {card.nextStatementPositionCents === undefined
                          ? '—'
                          : formatMoney(card.nextStatementPositionCents)}
                      </Text>
                    </div>
                    {unavailableReason && (
                      <details className={styles.explain}>
                        <summary>Why unavailable</summary>
                        <Text size={200}>{unavailableReason}</Text>
                      </details>
                    )}
                    {mode === 'conservative' && fundingInsight && (
                      <Text size={200} className={styles.warningText}>
                        Funding warning: {fundingInsight}
                      </Text>
                    )}
                    {!unavailableReason && (
                      <details
                        className={styles.runwayPanel}
                        aria-label={`${card.cardName} runway lows`}
                      >
                        <summary className={styles.metricLabel}>Projected lows</summary>
                        <div className={styles.runwayBalanceGrid}>
                          <div className={styles.fact}>
                            <Text size={200} className={styles.detail}>
                              Total position
                            </Text>
                            <Text
                              aria-label={`${card.cardName} total position low`}
                              className={styles.factValue}
                            >
                              {formatMoney(card.futurePositionLowCents)}
                            </Text>
                            <Text size={200}>{displayDate(card.futurePositionLowDate)}</Text>
                          </div>
                          <div className={styles.fact}>
                            <Text size={200} className={styles.detail}>
                              Owed to me at low
                            </Text>
                            <Text
                              aria-label={`${card.cardName} owed to me at total position low`}
                              className={styles.factValue}
                            >
                              {formatMoney(card.futurePositionLowReceivableCents)}
                            </Text>
                            <Text size={200}>{displayDate(card.futurePositionLowDate)}</Text>
                          </div>
                          {card.futureAccountLows.map((account) => (
                            <div className={styles.fact} key={account.accountId}>
                              <Text size={200} className={styles.detail}>
                                {account.accountName} low
                              </Text>
                              <Text
                                aria-label={`${card.cardName} ${account.accountName} account low`}
                                className={mergeClasses(
                                  styles.factValue,
                                  account.endingBalanceCents < 0 ? styles.dangerText : undefined,
                                )}
                              >
                                {formatMoney(account.endingBalanceCents)}
                              </Text>
                              <Text size={200}>{displayDate(account.date)}</Text>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {mode === 'conservative' && !unavailableReason && (
                      <div className={styles.safeSpendFacts}>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Cash capacity
                          </Text>
                          <Text
                            className={styles.factValue}
                            aria-label={`${card.cardName} cash-only capacity`}
                          >
                            {formatMoney(card.cashBackedCapacityCents)}
                          </Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Payment account low
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(card.fundingAccountLowCents)}
                          </Text>
                          <Text size={200} className={styles.detail}>
                            {displayDate(card.fundingAccountLowDate)} · minimum{' '}
                            {formatMoney(fundingFloor)}
                          </Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Cash low
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(card.futureCashLowCents)}
                          </Text>
                          <Text size={200}>{displayDate(card.futureCashLowDate)}</Text>
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {preferences.showOverviewDailySummary && (
        <section className={styles.metricGrid} aria-label="Daily decision summary">
          <Metric
            label="Global Spending Power"
            value={Math.max(0, positionMargin)}
            detail={`${formatMoney(positionLow)} total-position low on ${displayDate(positionLowDate)}`}
            explanation={
              <>
                The lowest {mode} bank-cash-plus-money-owed position minus the global protected
                threshold. This uses the same runway definition as each card below.
              </>
            }
          />
          {mode === 'expected' ? (
            <Metric
              label="Total position today"
              value={snapshot.currentTotalPositionCents ?? currentCash + currentOwed}
              detail={`As of ${displayDate(snapshot.startDate)}`}
              explanation="Included bank-account balances plus open money owed as of the forecast start."
            />
          ) : (
            <Metric
              label="Lowest liquid cash"
              value={cashLow}
              detail={displayDate(cashLowDate)}
              explanation={`The lowest ${mode} daily close across accounts counted as available cash. Intraday cash reaches ${formatMoney(intradayLow)} on ${displayDate(intradayLowDate)}; this cash-only warning does not replace Spending Power.`}
            />
          )}
          <Metric
            label="Next account low"
            value={nextFundingNeed ? nextFundingFloor - nextFundingNeed.shortfallCents : 0}
            detail={
              nextFundingNeed
                ? `${nextFundingNeed.accountName} on ${displayDate(nextFundingNeed.date)} · deepest in this run ${formatMoney(nextFundingFloor - (nextFundingNeed.horizonDeepestShortfallCents ?? nextFundingNeed.shortfallCents))} on ${displayDate(nextFundingNeed.horizonDeepestShortfallDate ?? nextFundingNeed.date)}`
                : 'No transfer required'
            }
            explanation="The first daily closing balance below an account minimum and the deepest closing balance before that account recovers. Funding Actions below show the exact dollars needed, safe transfers, and projected money owed that could be released."
          />
          {mode === 'expected' ? (
            <Metric
              label="Protected floor"
              value={hardFloor}
              detail={`${formatMoney(positionMargin)} expected position margin`}
              explanation="The global threshold subtracted from total-position lows when calculating Spending Power."
            />
          ) : (
            <Metric
              label="Cash today"
              value={currentCash}
              detail={`As of ${displayDate(snapshot.startDate)}`}
              explanation={`Cash accounts counted as available now. Money owed to you (${formatMoney(currentOwed)}) improves total position but cannot fund a payment until received.`}
            />
          )}
        </section>
      )}

      <section
        className={fundingNeeds.length === 0 ? styles.fundingClear : styles.panel}
        aria-labelledby="funding-actions-title"
      >
        <div className={styles.sectionHeader}>
          <div className={styles.heading}>
            <Text className={styles.eyebrow}>Account coverage</Text>
            <Title2 id="funding-actions-title" as="h2">
              {fundingNeeds.length === 0 ? 'Every account is funded' : 'Funding actions'}
            </Title2>
            <Text className={styles.detail}>
              {fundingNeeds.length === 0
                ? `No transfer is needed in the ${mode} forecast.`
                : `Accounts below their minimums in the ${mode} forecast.`}
            </Text>
            {fundingNeeds.length > 0 && (
              <details className={styles.explain}>
                <summary>How funding guidance works</summary>
                <Text size={200}>
                  Suggested transfers respect each account&apos;s modeled transfer delay and never
                  execute automatically. Money owed appears separately until you release it to a
                  cash account.
                </Text>
              </details>
            )}
          </div>
          <Button appearance="subtle" onClick={() => navigate('/baseline')}>
            Open transfer planner
          </Button>
        </div>
        {fundingNeeds.length === 0 ? null : (
          <ul className={styles.fundingList} aria-label={`${mode} funding actions`}>
            {fundingNeeds.map((need, index) => {
              const actionPath = fundingActionPath(need);
              const accountFloor =
                (snapshot.cashAccounts ?? []).find((account) => account.id === need.accountId)
                  ?.hardFloorCents ?? 0;
              return (
                <li key={`${need.accountId}-${need.date}-${index}`}>
                  <div className={styles.fundingRow} data-layout-watch="funding-action">
                    <div className={styles.heading}>
                      <strong>{need.accountName}</strong>
                      {need.sourceAccountName ? (
                        <Text size={200} className={styles.detail}>
                          Suggested source: {need.sourceAccountName}
                          {need.sourceSurplusAfterFloorsCents === undefined
                            ? ''
                            : ` · ${formatMoney(need.sourceSurplusAfterFloorsCents)} remains above its floors`}
                        </Text>
                      ) : (
                        <Text size={200} className={styles.dangerText}>
                          No safe internal source is available.
                        </Text>
                      )}
                    </div>
                    <div className={styles.fundingFacts}>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          First low
                        </Text>
                        <Text className={styles.factValue}>
                          {formatMoney(accountFloor - need.shortfallCents)}
                        </Text>
                        <Text size={200} className={styles.detail}>
                          Needs {formatMoney(need.shortfallCents)} by {displayDate(need.date)}
                        </Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Deepest in this run
                        </Text>
                        <Text className={styles.factValue}>
                          {formatMoney(
                            accountFloor -
                              (need.horizonDeepestShortfallCents ?? need.shortfallCents),
                          )}
                        </Text>
                        <Text size={200} className={styles.detail}>
                          Needs{' '}
                          {formatMoney(need.horizonDeepestShortfallCents ?? need.shortfallCents)} by{' '}
                          {displayDate(need.horizonDeepestShortfallDate ?? need.date)}
                        </Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Initiate transfer
                        </Text>
                        <Text className={styles.factValue}>{displayDate(need.initiationDate)}</Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Transfer arrival
                        </Text>
                        <Text className={styles.factValue}>{displayDate(need.arrivalDate)}</Text>
                      </div>
                    </div>
                    <div
                      className={styles.fundingResolution}
                      data-layout-region="funding-resolution"
                    >
                      {(need.receivableOutstandingCents ?? 0) > 0 ? (
                        <Text size={200} className={styles.detail}>
                          {need.uncoveredAfterReceivablesCents === 0 &&
                          need.deepestUncoveredAfterReceivablesCents === 0
                            ? `Money owed to you can cover this run if you release ${formatMoney(need.receivableReleaseNeededCents ?? 0)} to ${need.accountName} by ${displayDate(need.date)}${(need.horizonDeepestShortfallDate ?? need.date) === need.date ? '' : ` and ${formatMoney(need.deepestReceivableReleaseNeededCents ?? 0)} total by ${displayDate(need.horizonDeepestShortfallDate)}`}.`
                            : `Money owed to you can contribute ${formatMoney(need.receivableReleaseNeededCents ?? 0)} by ${displayDate(need.date)} and ${formatMoney(need.deepestReceivableReleaseNeededCents ?? 0)} by ${displayDate(need.horizonDeepestShortfallDate ?? need.date)}, leaving ${formatMoney(need.deepestUncoveredAfterReceivablesCents ?? 0)} still to fund.`}
                        </Text>
                      ) : (
                        <Text size={200} className={styles.detail}>
                          No projected money owed is available to release by this need.
                        </Text>
                      )}
                      {actionPath ? (
                        <Button appearance="primary" onClick={() => navigate(actionPath)}>
                          Review transfer
                        </Button>
                      ) : (
                        <Text size={200} className={styles.detail}>
                          {need.sourceAccountName
                            ? 'Transfer timing is incomplete; review the planner.'
                            : need.deepestUncoveredAfterReceivablesCents === 0 &&
                                (need.deepestReceivableReleaseNeededCents ?? 0) > 0
                              ? 'No safe internal transfer is available, but releasing the dated money owed above would cover this run.'
                              : 'A transfer and projected money owed cannot fully cover this need.'}
                        </Text>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        className={preferences.showOverviewUpcomingEvents ? styles.twoColumn : styles.section}
      >
        {preferences.showOverviewUpcomingEvents && (
          <div className={styles.panel}>
            <div className={styles.sectionHeader}>
              <div className={styles.heading}>
                <Text className={styles.eyebrow}>Next on the calendar</Text>
                <Title2 as="h2">Upcoming cash events</Title2>
              </div>
              <div className={styles.segmented}>
                {(snapshot.upcomingEvents ?? []).length > 5 && (
                  <Button
                    appearance="subtle"
                    aria-expanded={showAllUpcoming}
                    onClick={() => setShowAllUpcoming((current) => !current)}
                  >
                    {showAllUpcoming ? 'Show less' : 'Show more'}
                  </Button>
                )}
                <Button appearance="subtle" onClick={() => navigate('/records')}>
                  Edit records
                </Button>
              </div>
            </div>
            <div
              className={styles.tableViewport}
              tabIndex={0}
              aria-label="Upcoming cash events table"
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Event</th>
                    <th>Confidence</th>
                    <th className={styles.money}>Cash effect</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.upcomingEvents ?? [])
                    .slice(0, showAllUpcoming ? undefined : 5)
                    .map((event) => (
                      <tr key={event.id}>
                        <td>{displayDate(event.date)}</td>
                        <td>
                          <strong>{event.label}</strong>
                          <br />
                          <Text size={200}>
                            {event.accountName} · {eventType(event.kind)}
                          </Text>
                        </td>
                        <td>{event.certainty}</td>
                        <td className={styles.money}>
                          {formatMoney(
                            event.direction === 'outflow' ? -event.amountCents : event.amountCents,
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className={styles.stack}>
          <div className={styles.panel} aria-label="Overview account lows">
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Cash accounts</Text>
              <Title2 as="h2">Future account lows</Title2>
            </div>
            <div className={styles.accountRows}>
              {overviewCashAccounts.map((account) => {
                const nextNeed = fundingNeeds.find((need) => need.accountId === account.id);
                const low = snapshot.accountTroughs?.find(
                  (candidate) => candidate.accountId === account.id,
                );
                const lowAmount =
                  mode === 'expected'
                    ? (low?.expectedBalanceCents ?? account.balanceCents)
                    : (low?.balanceCents ?? account.balanceCents);
                const lowDate = mode === 'expected' ? low?.expectedDate : low?.date;
                const floorMargin = lowAmount - account.hardFloorCents;
                return (
                  <div
                    className={styles.accountRow}
                    key={account.id}
                    aria-label={`${account.name} future low summary`}
                  >
                    <div className={styles.accountHeader}>
                      <strong>{account.name}</strong>
                    </div>
                    <span
                      className={mergeClasses(
                        styles.accountLow,
                        nextNeed || floorMargin < 0 ? styles.dangerText : undefined,
                      )}
                    >
                      {nextNeed
                        ? `First low ${formatMoney(account.hardFloorCents - nextNeed.shortfallCents)} · ${displayDate(nextNeed.date)}`
                        : `${mode === 'expected' ? 'Expected' : 'Conservative'} low ${formatMoney(lowAmount)} · ${displayDate(lowDate)}`}
                    </span>
                    {nextNeed && (
                      <span className={mergeClasses(styles.accountLow, styles.dangerText)}>
                        Run low{' '}
                        {formatMoney(
                          account.hardFloorCents -
                            (nextNeed.horizonDeepestShortfallCents ?? nextNeed.shortfallCents),
                        )}{' '}
                        · {displayDate(nextNeed.horizonDeepestShortfallDate ?? nextNeed.date)}
                      </span>
                    )}
                    <span className={styles.accountLow}>
                      Min {formatMoney(account.hardFloorCents)} {' · '} margin{' '}
                      {formatMoney(nextNeed ? -nextNeed.shortfallCents : floorMargin)}
                      {account.preferredFloorCents === undefined
                        ? ''
                        : ` · preferred ${formatMoney(account.preferredFloorCents)}`}
                    </span>
                  </div>
                );
              })}
              {overviewCashAccounts.length === 0 && (
                <div className={styles.empty}>
                  <Text>No cash accounts are currently shown on Overview.</Text>
                  <Button appearance="subtle" onClick={() => navigate('/data')}>
                    Choose visible accounts
                  </Button>
                </div>
              )}
            </div>
            <div className={styles.sectionHeader}>
              <Button appearance="subtle" onClick={() => navigate('/forecast')}>
                Open daily account forecast
              </Button>
              <Button appearance="subtle" onClick={() => navigate('/data')}>
                Edit account minimums
              </Button>
            </div>
          </div>

          {mode === 'conservative' && (
            <div className={styles.panel}>
              <div className={styles.heading}>
                <Text className={styles.eyebrow}>Low points</Text>
                <Title2 as="h2">Position versus cash</Title2>
              </div>
              <div className={styles.factGrid}>
                <div className={styles.fact}>
                  <Text className={styles.metricLabel}>Cash + owed low</Text>
                  <Text className={styles.factValue}>{formatMoney(positionLow)}</Text>
                  <Text size={200}>{displayDate(positionLowDate)}</Text>
                </div>
                <div className={styles.fact}>
                  <Text className={styles.metricLabel}>Liquid cash low</Text>
                  <Text className={styles.factValue}>{formatMoney(cashLow)}</Text>
                  <Text size={200}>{displayDate(cashLowDate)}</Text>
                </div>
              </div>
              <Text className={styles.detail}>
                Money owed counts toward position, but becomes cash only when received.
              </Text>
              <Button appearance="subtle" onClick={() => navigate('/receivables')}>
                Review money owed
              </Button>
            </div>
          )}
        </div>
      </section>

      <details className={styles.section}>
        <summary>Test a purchase</summary>
        <div className={styles.advisorPanel}>
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Purchase advisor</Text>
              <Title2 id="card-advisor-title" as="h2">
                {preferences.showCreditCards
                  ? 'Which card should I use?'
                  : 'Can I afford this purchase?'}
              </Title2>
              <Text className={styles.detail}>
                Compare cash and every current card for one purchase.
              </Text>
              <details className={styles.explain}>
                <summary>How options are ranked</summary>
                <Text size={200}>
                  The selected {mode} forecast checks account funding first, then payment timing,
                  then entered rewards. Available credit is never treated as spendable cash.
                </Text>
              </details>
            </div>
          </div>
          {advisorCards.length === 0 && (snapshot.cashAccounts ?? []).length === 0 ? (
            <Card className={styles.empty}>
              Add a checking account or a card with a complete full-statement cash model to compare
              purchase options.
            </Card>
          ) : (
            <form
              className={styles.advisorForm}
              onSubmit={(event) => void evaluateCardAdvisor(event)}
            >
              <Field label="Purchase amount">
                <Input
                  value={advisorAmount}
                  inputMode="decimal"
                  placeholder="0.00"
                  required
                  disabled={advisorBusy}
                  onChange={(_, data) => {
                    setAdvisorAmount(data.value);
                    setAdvisorResults(null);
                    setCashAdvisorResults(null);
                    setAdvisorEvaluation(null);
                    setAdvisorError(null);
                  }}
                />
              </Field>
              <Field label="Purchase date">
                <Input
                  value={advisorDate < earliestAdvisorDate ? earliestAdvisorDate : advisorDate}
                  type="date"
                  min={earliestAdvisorDate}
                  required
                  disabled={advisorBusy}
                  onChange={(_, data) => {
                    setAdvisorDate(data.value);
                    setAdvisorResults(null);
                    setCashAdvisorResults(null);
                    setAdvisorEvaluation(null);
                    setAdvisorError(null);
                  }}
                />
              </Field>
              <Button appearance="primary" type="submit" disabled={advisorBusy}>
                {advisorBusy
                  ? 'Checking purchase...'
                  : preferences.showCreditCards
                    ? 'Compare every card'
                    : 'Check cash purchase'}
              </Button>
            </form>
          )}
          {advisorCards.length === 0 && (snapshot.cashAccounts ?? []).length > 0 && (
            <Text className={styles.warningText}>
              Cash can still be evaluated. Add current card-cycle timing to compare cards too.
            </Text>
          )}
          {preferences.showCreditCards && advisorUnsupportedCount > 0 && (
            <Text className={styles.warningText}>
              {advisorUnsupportedCount} card{advisorUnsupportedCount === 1 ? '' : 's'} excluded
              because payment policy, cycle timing, or account data cannot support a runway
              recommendation.
            </Text>
          )}
          {advisorError && (
            <Text className={styles.error} role="alert">
              {advisorError}
            </Text>
          )}
          {advisorUnavailableCount > 0 && advisorResults && (
            <Text className={styles.warningText} role="status">
              {advisorUnavailableCount} card{advisorUnavailableCount === 1 ? '' : 's'} could not be
              evaluated for this date and {advisorUnavailableCount === 1 ? 'was' : 'were'} excluded.
            </Text>
          )}
          {cashAdvisorResults && advisorEvaluation && cashAdvisorResults.length > 0 && (
            <Card className={styles.advisorSummary} aria-label="Cash purchase safety">
              {(() => {
                const readyCash = cashAdvisorResults.filter(
                  (result) =>
                    result.scenario.purchaseSafety?.safe &&
                    result.scenario.purchaseSafety.fundingAccountShortfallCents === 0,
                );
                const releaseFundedCash = cashAdvisorResults.filter(
                  (result) =>
                    result.scenario.purchaseSafety?.safe &&
                    result.scenario.purchaseSafety.fundingAccountShortfallCents > 0,
                );
                const unsafeCash = cashAdvisorResults.filter(
                  (result) => !result.scenario.purchaseSafety?.safe,
                );
                const cashStatusClass =
                  readyCash.length > 0
                    ? styles.advisorSafe
                    : releaseFundedCash.length > 0
                      ? styles.warningText
                      : styles.dangerText;
                return (
                  <>
                    <Text className={cashStatusClass}>Cash purchase</Text>
                    <Title2 as="h3">
                      {readyCash.length > 0
                        ? `Cash works from ${readyCash.map((result) => result.accountName).join(' or ')}`
                        : releaseFundedCash.length > 0
                          ? 'Cash works only after funding the account'
                          : 'Do not pay cash from a checking account yet'}
                    </Title2>
                    <Text>
                      {readyCash.length > 0
                        ? `${formatMoney(advisorEvaluation.amountCents)} leaves ${readyCash.map((result) => result.accountName).join(', ')} above its account threshold without another action.`
                        : releaseFundedCash.length > 0
                          ? `${formatMoney(advisorEvaluation.amountCents)} preserves total position, but every usable checking option needs a Money Owed release before its modeled low.`
                          : `${formatMoney(advisorEvaluation.amountCents)} would leave every modeled checking account below a protected threshold even after available Money Owed is considered.`}
                      {releaseFundedCash.length > 0
                        ? ` Fund ${releaseFundedCash.map((result) => result.accountName).join(', ')} by the date shown before treating cash as ready.`
                        : ''}
                      {unsafeCash.length > 0
                        ? ` Do not use cash from ${unsafeCash.map((result) => result.accountName).join(', ')} without another funding action.`
                        : ''}
                    </Text>
                    <div className={styles.advisorFacts}>
                      {cashAdvisorResults.map((result) => {
                        const safety = result.scenario.purchaseSafety;
                        const isReady = safety?.safe && safety.fundingAccountShortfallCents === 0;
                        const isReleaseFunded =
                          safety?.safe && safety.fundingAccountShortfallCents > 0;
                        return (
                          <div className={styles.fact} key={result.accountId}>
                            <Text size={200} className={styles.metricLabel}>
                              {result.accountName}
                            </Text>
                            <Text
                              className={
                                isReady
                                  ? styles.advisorSafe
                                  : isReleaseFunded
                                    ? styles.warningText
                                    : styles.dangerText
                              }
                            >
                              {isReady
                                ? 'Can use cash now'
                                : isReleaseFunded
                                  ? 'Can use after funding'
                                  : 'Do not use cash'}
                            </Text>
                            {safety && (
                              <Text size={200} className={styles.detail}>
                                Account low {formatMoney(safety.fundingAccountLowCents)} on{' '}
                                {displayDate(safety.fundingAccountLowDate)}
                                {safety.receivableReleaseNeededCents > 0
                                  ? ` · release ${formatMoney(safety.receivableReleaseNeededCents)} of Money Owed by then`
                                  : ''}
                                {safety.uncoveredFundingShortfallCents > 0
                                  ? ` · another ${formatMoney(safety.uncoveredFundingShortfallCents)} remains unfunded`
                                  : ''}
                              </Text>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </Card>
          )}
          {advisorResults &&
            advisorEvaluation &&
            advisorResults.length > 0 &&
            (() => {
              const recommendation = advisorResults.find(advisorResultIsSafe);
              const transferRecommendation = recommendation
                ? undefined
                : advisorResults.find(advisorResultIsFundable);
              const incomeDependentRecommendation =
                recommendation || transferRecommendation
                  ? undefined
                  : advisorResults.find(advisorResultIsIncomeDependent);
              const leadingOption =
                recommendation ??
                transferRecommendation ??
                incomeDependentRecommendation ??
                advisorResults[0]!;
              const hasSafeOption = recommendation !== undefined;
              const hasFundableOption = transferRecommendation !== undefined;
              const hasIncomeDependentOption = incomeDependentRecommendation !== undefined;
              const leadingReward = advisorRewardText(leadingOption);
              const leadingMargin =
                leadingOption.scenario.purchaseSafety?.totalPositionMarginCents ??
                leadingOption.scenario.afterHardFloorMarginCents;
              const safeCardOptions = advisorResults.filter(advisorResultIsSafe);
              const unsafeCardOptions = advisorResults.filter(
                (option) => !advisorResultIsSafe(option) && !advisorResultIsFundable(option),
              );
              return (
                <div className={styles.stack} aria-live="polite">
                  <Card
                    className={mergeClasses(
                      styles.advisorSummary,
                      hasIncomeDependentOption
                        ? styles.advisorSummaryConditional
                        : hasSafeOption || hasFundableOption
                          ? undefined
                          : styles.advisorSummaryUnsafe,
                    )}
                  >
                    <Text
                      className={
                        hasSafeOption || hasFundableOption
                          ? styles.advisorSafe
                          : hasIncomeDependentOption
                            ? styles.warningText
                            : styles.dangerText
                      }
                    >
                      {hasSafeOption
                        ? safeCardOptions.length === advisorResults.length
                          ? `All ${advisorResults.length} cards work`
                          : `${safeCardOptions.length} card${safeCardOptions.length === 1 ? '' : 's'} work`
                        : hasFundableOption
                          ? 'Recommended after a transfer'
                          : hasIncomeDependentOption
                            ? 'Conditional card option'
                            : 'No safe card for this purchase'}
                    </Text>
                    <Title2 as="h3">
                      {hasSafeOption
                        ? safeCardOptions.length === advisorResults.length
                          ? 'You can use any card'
                          : `You can use ${safeCardOptions.map((option) => option.card.cardName).join(', ')}`
                        : hasFundableOption || hasIncomeDependentOption
                          ? leadingOption.card.cardName
                          : 'Change the amount, timing, or funding plan first'}
                    </Title2>
                    {hasSafeOption && unsafeCardOptions.length > 0 && (
                      <Text>
                        Do not use{' '}
                        {unsafeCardOptions.map((option) => option.card.cardName).join(', ')} for
                        this purchase without changing the funding plan.
                      </Text>
                    )}
                    <Text>
                      {hasSafeOption
                        ? advisorReason(leadingOption)
                        : hasFundableOption
                          ? `${advisorReason(leadingOption)} Complete the transfer action below before relying on this card choice.`
                          : hasIncomeDependentOption
                            ? `${advisorReason(leadingOption)} Confirm that income or re-run the comparison after it arrives before treating this as safe.`
                            : `No card keeps ${formatMoney(advisorEvaluation.amountCents)} within both your protected minimum and account funding limits. The closest option is ${leadingOption.card.cardName}, but it is not recommended: ${advisorReason(leadingOption)}`}
                    </Text>
                    <div className={styles.advisorFacts}>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Actual cash-payment date
                        </Text>
                        <Text className={styles.factValue}>
                          {displayDate(leadingOption.scenario.settlementDate)}
                        </Text>
                      </div>
                      {leadingOption.scenario.incrementalCashPaymentCents !== undefined && (
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Added to that card payment
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(leadingOption.scenario.incrementalCashPaymentCents)}
                          </Text>
                          {leadingOption.scenario.baselineCardPaymentCents !== undefined &&
                            leadingOption.scenario.afterPurchaseCardPaymentCents !== undefined && (
                              <Text size={200}>
                                {formatMoney(leadingOption.scenario.baselineCardPaymentCents)} to{' '}
                                {formatMoney(leadingOption.scenario.afterPurchaseCardPaymentCents)}
                              </Text>
                            )}
                        </div>
                      )}
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Total-position threshold margin
                        </Text>
                        <Text
                          className={mergeClasses(
                            styles.factValue,
                            leadingMargin < 0 ? styles.dangerText : undefined,
                          )}
                        >
                          {formatMoney(leadingMargin)}
                        </Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Resulting available spend
                        </Text>
                        <Text className={styles.factValue}>
                          {formatMoney(
                            leadingOption.scenario.resultingAvailableSpendCents ??
                              leadingOption.scenario.afterAvailableToDeployCents,
                          )}
                        </Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Funding account
                        </Text>
                        <Text className={styles.factValue}>
                          {leadingOption.scenario.fundingAccountName}
                        </Text>
                      </div>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Purchase date
                        </Text>
                        <Text className={styles.factValue}>
                          {displayDate(advisorEvaluation.purchaseDate)}
                        </Text>
                      </div>
                      {leadingOption.scenario.followingStatementDueOn && (
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Following statement position
                          </Text>
                          <Text className={styles.factValue}>
                            {leadingOption.scenario.followingStatementPositionCents === undefined
                              ? 'Outside forecast'
                              : formatMoney(leadingOption.scenario.followingStatementPositionCents)}
                          </Text>
                          <Text size={200} className={styles.detail}>
                            Lowest from{' '}
                            {displayDate(leadingOption.scenario.followingStatementDueOn)} forward
                          </Text>
                        </div>
                      )}
                      {leadingReward && (
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Estimated reward, ranked last
                          </Text>
                          <Text className={styles.factValue}>{leadingReward}</Text>
                        </div>
                      )}
                    </div>
                    {hasFundableOption && (
                      <div className={styles.stack}>
                        {leadingOption.scenario.transferNeeds.map((need) => {
                          const actionPath = fundingActionPath(need);
                          return (
                            <Card className={styles.fundingRow} key={need.accountId}>
                              <Text>
                                Move <strong>{formatMoney(need.shortfallCents)}</strong> from{' '}
                                <strong>{need.sourceAccountName}</strong> to{' '}
                                <strong>{need.accountName}</strong>. Initiate{' '}
                                <strong>{displayDate(need.initiationDate)}</strong>; modeled arrival{' '}
                                <strong>{displayDate(need.arrivalDate)}</strong>, before the{' '}
                                {displayDate(need.date)} need.
                              </Text>
                              {actionPath && (
                                <Button appearance="primary" onClick={() => navigate(actionPath)}>
                                  Prefill this transfer
                                </Button>
                              )}
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                  <details className={styles.rankedDisclosure}>
                    <summary>Compare all {advisorResults.length} ranked card options</summary>
                    <Text className={styles.detail}>
                      Every option uses the same amount and purchase date. A higher rank never hides
                      a floor breach, account shortfall, or income dependency.
                    </Text>
                    <ol className={styles.advisorOptions} aria-label="Ranked card options">
                      {advisorResults.map((option, index) => {
                        const status = advisorResultStatus(option);
                        const rewardText = advisorRewardText(option);
                        return (
                          <li key={option.card.cardId}>
                            <Card
                              className={styles.advisorOption}
                              aria-label={`Rank ${index + 1}: ${option.card.cardName}`}
                            >
                              <div className={styles.powerTop}>
                                <div className={styles.heading}>
                                  <Text className={styles.advisorRank}>Rank {index + 1}</Text>
                                  <strong>{option.card.cardName}</strong>
                                </div>
                                <Text
                                  className={
                                    status === 'safe' || status === 'transfer-required'
                                      ? styles.advisorSafe
                                      : status === 'income-dependent'
                                        ? styles.warningText
                                        : styles.dangerText
                                  }
                                >
                                  {advisorStatusLabel[status]}
                                </Text>
                              </div>
                              <Text>
                                {option.scenario.purchaseSafety
                                  ? option.scenario.purchaseSafety.safe
                                    ? option.scenario.purchaseSafety.fundingAccountShortfallCents >
                                      0
                                      ? 'Within total threshold; funding action shown'
                                      : 'Within total and account thresholds'
                                    : 'Outside a total or account threshold'
                                  : advisorVerdictLabel[option.scenario.verdict]}
                              </Text>
                              <details className={styles.explain}>
                                <summary>Why?</summary>
                                <Text size={200} className={styles.detail}>
                                  {advisorReason(option)} The purchase settles from{' '}
                                  {option.scenario.fundingAccountName} on{' '}
                                  {displayDate(option.scenario.settlementDate)} and is checked
                                  against both the protected total threshold and that account&apos;s
                                  minimum.
                                </Text>
                              </details>
                              <div className={styles.advisorFacts}>
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Cash leaves
                                  </Text>
                                  <Text className={styles.factValue}>
                                    {displayDate(option.scenario.settlementDate)}
                                  </Text>
                                </div>
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Available after purchase
                                  </Text>
                                  <Text className={styles.factValue}>
                                    {formatMoney(
                                      option.scenario.resultingAvailableSpendCents ??
                                        option.scenario.afterAvailableToDeployCents,
                                    )}
                                  </Text>
                                </div>
                                {option.scenario.followingStatementDueOn && (
                                  <div className={styles.fact}>
                                    <Text size={200} className={styles.metricLabel}>
                                      Following statement position
                                    </Text>
                                    <Text className={styles.factValue}>
                                      {option.scenario.followingStatementPositionCents === undefined
                                        ? 'Outside forecast'
                                        : formatMoney(
                                            option.scenario.followingStatementPositionCents,
                                          )}
                                    </Text>
                                    <Text size={200} className={styles.detail}>
                                      Lowest from{' '}
                                      {displayDate(option.scenario.followingStatementDueOn)} forward
                                    </Text>
                                  </div>
                                )}
                                {option.scenario.incrementalCashPaymentCents !== undefined && (
                                  <div className={styles.fact}>
                                    <Text size={200} className={styles.metricLabel}>
                                      Added cash payment
                                    </Text>
                                    <Text className={styles.factValue}>
                                      {formatMoney(option.scenario.incrementalCashPaymentCents)}
                                    </Text>
                                  </div>
                                )}
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Total-position margin
                                  </Text>
                                  <Text
                                    className={mergeClasses(
                                      styles.factValue,
                                      (option.scenario.purchaseSafety?.totalPositionMarginCents ??
                                        option.scenario.afterHardFloorMarginCents) < 0
                                        ? styles.dangerText
                                        : undefined,
                                    )}
                                  >
                                    {formatMoney(
                                      option.scenario.purchaseSafety?.totalPositionMarginCents ??
                                        option.scenario.afterHardFloorMarginCents,
                                    )}
                                  </Text>
                                </div>
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Funding account
                                  </Text>
                                  <Text className={styles.factValue}>
                                    {option.scenario.fundingAccountName}
                                  </Text>
                                </div>
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Funding-account low
                                  </Text>
                                  <Text className={styles.factValue}>
                                    {option.scenario.purchaseSafety
                                      ? formatMoney(
                                          option.scenario.purchaseSafety.fundingAccountLowCents,
                                        )
                                      : option.scenario.accountShortfallCount}
                                  </Text>
                                </div>
                                {rewardText && (
                                  <div className={styles.fact}>
                                    <Text size={200} className={styles.metricLabel}>
                                      Estimated reward
                                    </Text>
                                    <Text className={styles.factValue}>{rewardText}</Text>
                                  </div>
                                )}
                              </div>
                            </Card>
                          </li>
                        );
                      })}
                    </ol>
                  </details>
                </div>
              );
            })()}
        </div>
      </details>

      {mode === 'conservative' && preferences.showCreditCards && (
        <section className={styles.section} aria-labelledby="spending-power-title">
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Title2 id="spending-power-title" as="h2">
                How each safe-spend limit is calculated
              </Title2>
              <Text className={styles.detail}>
                Inspect statements, current-cycle activity, payment dates, low points, and estimate
                headroom behind the plain-language answers above.
              </Text>
            </div>
            <Button appearance="subtle" onClick={() => navigate('/cards')}>
              Edit cards and statements
            </Button>
          </div>
          {cardPower.length === 0 ? (
            <Card className={styles.empty}>
              Add a card and its statement/payment timing to begin.
            </Card>
          ) : (
            <details className={styles.rankedDisclosure}>
              <summary>Show full calculations for all {cardPower.length} cards</summary>
              <div className={styles.cardGrid}>
                {cardPower.map((card) => {
                  const unavailableReason = cardSpendingPowerUnavailableReason(card);
                  const conditionalOnEarlierFunding =
                    card.spendingPowerStatus === 'conditional-existing-shortfall';
                  const fundingFloor =
                    (snapshot.cashAccounts ?? []).find(
                      (account) => account.id === card.fundingAccountId,
                    )?.hardFloorCents ?? 0;
                  const fundingShortfall = Math.max(0, fundingFloor - card.fundingAccountLowCents);
                  return (
                    <Card className={styles.powerCard} key={card.cardId}>
                      <div className={styles.powerTop}>
                        <div>
                          <strong>{card.cardName}</strong>
                          <Text size={200} className={styles.detail} block>
                            Paid from {card.fundingAccountName}
                          </Text>
                        </div>
                        <Button size="small" appearance="subtle" onClick={() => navigate('/cards')}>
                          Edit
                        </Button>
                      </div>
                      <div>
                        <Text className={styles.metricLabel}>Conservative available spend</Text>
                        <Text className={styles.powerValue}>
                          {unavailableReason
                            ? 'Runway unavailable'
                            : formatMoney(card.spendingPowerCents)}
                        </Text>
                        {unavailableReason && (
                          <Text size={200} className={styles.warningText}>
                            {unavailableReason}
                          </Text>
                        )}
                        <Text size={200} className={styles.detail}>
                          Limiting total position {formatMoney(card.futurePositionLowCents)} on{' '}
                          {displayDate(card.futurePositionLowDate)}
                        </Text>
                        {conditionalOnEarlierFunding && (
                          <Text size={200} className={styles.warningText} block>
                            Conditional: resolve the {formatMoney(card.prePaymentShortfallCents)}{' '}
                            earlier funding gap on {displayDate(card.prePaymentShortfallDate)}{' '}
                            first.
                          </Text>
                        )}
                      </div>
                      <div className={styles.factGrid}>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Statement {card.statementState === 'paid' ? 'paid' : 'coming due'}
                          </Text>
                          <Text className={styles.factValue}>
                            {card.statementCycleId
                              ? formatMoney(card.statementAmountCents)
                              : 'None'}
                          </Text>
                          <Text size={200}>{displayDate(card.statementDueOn)}</Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Current cycle projected
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(card.currentCycleAmountCents)}
                          </Text>
                          <Text size={200}>
                            Recorded + planned · closes {displayDate(card.currentCycleClosesOn)}
                          </Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Current cycle payment date
                          </Text>
                          <Text className={styles.factValue}>
                            {displayDate(card.currentCyclePaymentOn)}
                          </Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Future liquid cash low
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(card.futureCashLowCents)}
                          </Text>
                          <Text size={200}>{displayDate(card.futureCashLowDate)}</Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            {card.fundingAccountName} low
                          </Text>
                          <Text
                            className={mergeClasses(
                              styles.factValue,
                              fundingShortfall > 0 ? styles.dangerText : undefined,
                            )}
                          >
                            {formatMoney(card.fundingAccountLowCents)}
                          </Text>
                          <Text size={200}>{displayDate(card.fundingAccountLowDate)}</Text>
                        </div>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.metricLabel}>
                            Cash-only capacity
                          </Text>
                          <Text className={styles.factValue}>
                            {formatMoney(card.cashBackedCapacityCents)}
                          </Text>
                          <Text size={200}>Separate funding-readiness diagnostic</Text>
                        </div>
                      </div>
                      {!unavailableReason && (
                        <div className={styles.runwayPanel}>
                          <Text className={styles.metricLabel}>
                            Reconciled limiting-date breakdown
                          </Text>
                          <div className={styles.runwayBalanceGrid}>
                            {card.futurePositionLowAccountBalances.map((account) => (
                              <div className={styles.fact} key={account.accountId}>
                                <Text size={200} className={styles.detail}>
                                  {account.accountName}
                                </Text>
                                <Text
                                  className={mergeClasses(
                                    styles.factValue,
                                    account.endingBalanceCents < 0 ? styles.dangerText : undefined,
                                  )}
                                >
                                  {formatMoney(account.endingBalanceCents)}
                                </Text>
                              </div>
                            ))}
                            <div className={styles.fact}>
                              <Text size={200} className={styles.detail}>
                                Owed to me
                              </Text>
                              <Text className={styles.factValue}>
                                {formatMoney(card.futurePositionLowReceivableCents)}
                              </Text>
                            </div>
                            <div className={styles.fact}>
                              <Text size={200} className={styles.detail}>
                                Total
                              </Text>
                              <Text className={styles.factValue}>
                                {formatMoney(card.futurePositionLowCents)}
                              </Text>
                            </div>
                          </div>
                        </div>
                      )}
                      {fundingShortfall > 0 && (
                        <Text className={styles.warningText} size={200}>
                          {card.fundingAccountName} needs at least {formatMoney(fundingShortfall)}{' '}
                          of funding to remain above its {formatMoney(fundingFloor)} minimum even
                          before additional card spending.
                        </Text>
                      )}
                      <details className={styles.explain}>
                        <summary>Explain this card</summary>
                        <Text size={200}>
                          For a full-statement card, Spending Power is the lowest {mode} total
                          position from the current-cycle due date forward, less the global
                          protected threshold. Total position is every liquidity-account closing
                          balance plus outstanding money owed. It preserves the workbook-style
                          runway answer while cash-only and individual-account lows remain separate
                          warnings. Revolving payment policies stay unavailable until a complete
                          paydown rule determines timing.
                        </Text>
                      </details>
                    </Card>
                  );
                })}
              </div>
            </details>
          )}
        </section>
      )}

      {preferences.showOverviewWiderPicture && (
        <details className={styles.panel}>
          <summary>Wider financial picture</summary>
          <section className={styles.section} aria-labelledby="wider-picture-title">
            <div className={styles.sectionHeader}>
              <div className={styles.heading}>
                <Text className={styles.eyebrow}>Wider financial picture</Text>
                <Title2 id="wider-picture-title" as="h2">
                  Debt, net worth, and review status
                </Title2>
              </div>
              <Button appearance="subtle" onClick={() => navigate('/net-worth')}>
                Review assets and liabilities
              </Button>
            </div>
            <div className={styles.factGrid}>
              <div className={styles.fact}>
                <Text className={styles.metricLabel}>Total tracked debt</Text>
                <Text className={styles.factValue}>
                  {formatMoney(snapshot.totalDebtCents ?? 0)}
                </Text>
                <Text size={200}>
                  Installment {formatMoney(snapshot.totalLoansCents ?? 0)} · cards and lines{' '}
                  {formatMoney(snapshot.totalRevolvingDebtCents ?? 0)}
                </Text>
              </div>
              <div className={styles.fact}>
                <Text className={styles.metricLabel}>Net worth</Text>
                <Text className={styles.factValue}>
                  {formatMoney(snapshot.contractualNetWorthCents ?? 0)}
                </Text>
                <Text size={200}>
                  Adjusted view {formatMoney(snapshot.economicNetWorthCents ?? 0)}
                </Text>
              </div>
              {mode === 'expected' ? (
                <div className={styles.fact}>
                  <Text className={styles.metricLabel}>Expected total-position margin</Text>
                  <Text className={styles.factValue}>{formatMoney(positionMargin)}</Text>
                  <Text size={200}>
                    Lowest total position minus the {formatMoney(hardFloor)} protected floor.
                  </Text>
                </div>
              ) : (
                <div className={styles.fact}>
                  <Text className={styles.metricLabel}>Conservative liquid-cash margin</Text>
                  <Text className={styles.factValue}>{formatMoney(cashHardFloorMargin)}</Text>
                  <Text size={200}>
                    Preferred-buffer margin {formatMoney(cashPreferredFloorMargin)}
                  </Text>
                  <Text size={200}>
                    Cash-only diagnostic; it does not replace the card runway or total-position low.
                  </Text>
                  <Text size={200}>
                    Account minimums {formatMoney(snapshot.accountHardFloorTotalCents ?? 0)}; global
                    override {formatMoney(snapshot.configuredHardFloorCents ?? 0)}
                  </Text>
                </div>
              )}
              <div className={styles.fact}>
                <Text className={styles.metricLabel}>Last balance check</Text>
                <Text className={styles.factValue}>
                  {snapshot.lastReconciliationDate
                    ? displayDate(snapshot.lastReconciliationDate)
                    : 'Not recorded'}
                </Text>
                <Text size={200}>
                  Actual balances never silently rewrite the original forecast.
                </Text>
              </div>
            </div>
            <details className={styles.explain}>
              <summary>Explain these totals</summary>
              <Text size={200}>
                Installment totals use each active loan&apos;s balance projected to the financial
                date. Revolving totals use posted debt or an issuer-reported balance; planned
                purchases and future estimates are excluded from current debt. Carrying means a
                statement residual left past payment, so a paid-in-full card can show its statement
                history while carrying zero. Current carrying is{' '}
                {formatMoney(snapshot.totalCarryingDebtCents ?? 0)}; modeled installment interest is{' '}
                {formatMoney(snapshot.modeledDailyInterestCents ?? 0)} per day. Net worth subtracts
                both current installment and revolving debt.
              </Text>
            </details>
            <div className={styles.sectionHeader}>
              <Button appearance="subtle" onClick={() => navigate('/loans')}>
                Edit loans
              </Button>
              <Button appearance="subtle" onClick={() => navigate('/reconcile')}>
                Check an account balance
              </Button>
            </div>
          </section>
        </details>
      )}
      {expenseEditor && expenseRecords && (
        <Dialog
          open
          modalType="modal"
          onOpenChange={(_event, data) => {
            if (!data.open && !expenseBusy) closeExpenseEditor();
          }}
        >
          <DialogSurface className={styles.quickDialog}>
            <DialogBody>
              <DialogTitle>Log an expense</DialogTitle>
              <DialogContent>
                <form
                  className={styles.quickDialogForm}
                  aria-label="Log an expense"
                  aria-busy={expenseBusy}
                  onSubmit={(event) => void saveOverviewExpense(event)}
                >
                  <Field label="Paid with">
                    <Select
                      autoFocus
                      required
                      value={expenseEditor.paymentSource}
                      onChange={(_event, data) =>
                        setExpenseEditor((current) =>
                          current ? { ...current, paymentSource: data.value } : current,
                        )
                      }
                    >
                      <option value="">Choose an account or card</option>
                      {expenseRecords.accounts.length > 0 && (
                        <optgroup label="Cash accounts">
                          {[...expenseRecords.accounts]
                            .sort((left, right) => left.name.localeCompare(right.name))
                            .map((account) => (
                              <option value={`cash-account:${account.id}`} key={account.id}>
                                {account.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {expenseRecords.cards.some((card) => card.status !== 'closed') && (
                        <optgroup label="Credit cards">
                          {expenseRecords.cards
                            .filter((card) => card.status !== 'closed')
                            .sort((left, right) => left.name.localeCompare(right.name))
                            .map((card) => (
                              <option value={`credit-card:${card.id}`} key={card.id}>
                                {card.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </Select>
                  </Field>
                  <Field label="Amount">
                    <Input
                      inputMode="decimal"
                      required
                      value={expenseEditor.amount}
                      onChange={(_event, data) =>
                        setExpenseEditor((current) =>
                          current ? { ...current, amount: data.value } : current,
                        )
                      }
                    />
                  </Field>
                  <Field label="Description">
                    <Input
                      required
                      maxLength={240}
                      value={expenseEditor.label}
                      onChange={(_event, data) =>
                        setExpenseEditor((current) =>
                          current ? { ...current, label: data.value } : current,
                        )
                      }
                    />
                  </Field>
                  <Field label="Expense date">
                    <Input
                      type="date"
                      required
                      min={expenseDateMinimum}
                      max={currentBalanceDate}
                      value={expenseEditor.date}
                      onChange={(_event, data) =>
                        setExpenseEditor((current) =>
                          current ? { ...current, date: data.value } : current,
                        )
                      }
                    />
                  </Field>
                  <div className={styles.expenseTreatment}>
                    <Text weight="semibold">Does someone owe you for this?</Text>
                    <div className={styles.expenseTreatmentOptions}>
                      <Checkbox
                        label="Reimbursable (100%)"
                        checked={expenseEditor.owedTreatment === 'reimbursable'}
                        onChange={(_event, data) =>
                          setExpenseEditor((current) =>
                            current
                              ? {
                                  ...current,
                                  owedTreatment: data.checked ? 'reimbursable' : 'none',
                                  owedBy: data.checked ? current.owedBy : '',
                                }
                              : current,
                          )
                        }
                      />
                      <Checkbox
                        label="Shared expense (50%)"
                        checked={expenseEditor.owedTreatment === 'shared'}
                        onChange={(_event, data) =>
                          setExpenseEditor((current) =>
                            current
                              ? {
                                  ...current,
                                  owedTreatment: data.checked ? 'shared' : 'none',
                                  owedBy: data.checked ? current.owedBy : '',
                                }
                              : current,
                          )
                        }
                      />
                    </div>
                    {expenseEditor.owedTreatment !== 'none' && (
                      <Field label="Owed by">
                        <Input
                          required
                          maxLength={120}
                          value={expenseEditor.owedBy}
                          onChange={(_event, data) =>
                            setExpenseEditor((current) =>
                              current ? { ...current, owedBy: data.value } : current,
                            )
                          }
                        />
                      </Field>
                    )}
                  </div>
                  {expenseEditor.paymentSource && expenseAmountCents > 0 && (
                    <>
                      <div className={styles.quickPreview} aria-live="polite">
                        <Text>
                          {expenseCashAccount
                            ? `${expenseCashAccount.name} after expense`
                            : `${expenseCard?.name ?? 'Card'} current balance`}
                        </Text>
                        <strong>
                          {formatMoney(
                            expenseCashPosition
                              ? expenseCashPosition.balanceCents - expenseAmountCents
                              : (expenseCardDebt?.currentBalanceCents ??
                                  expenseCard?.reportedBalanceCents ??
                                  0) + expenseAmountCents,
                          )}
                        </strong>
                      </div>
                      {expenseCard && (
                        <Text size={200} className={styles.detail}>
                          Added to this card&apos;s current cycle. Bank cash will move only when the
                          card is paid.
                        </Text>
                      )}
                      {expenseOwedCents > 0 && (
                        <div className={styles.quickPreview}>
                          <Text>Added to Money Owed</Text>
                          <strong>{formatMoney(expenseOwedCents)}</strong>
                        </div>
                      )}
                    </>
                  )}
                  <details>
                    <summary>More options</summary>
                    <Field label="Notes (optional)">
                      <Textarea
                        resize="vertical"
                        value={expenseEditor.notes}
                        onChange={(_event, data) =>
                          setExpenseEditor((current) =>
                            current ? { ...current, notes: data.value } : current,
                          )
                        }
                      />
                    </Field>
                  </details>
                  {expenseError && (
                    <div role="alert" className={styles.error}>
                      {expenseError}
                    </div>
                  )}
                  <DialogActions>
                    <Button
                      type="button"
                      appearance="subtle"
                      disabled={expenseBusy}
                      onClick={closeExpenseEditor}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" appearance="primary" disabled={expenseBusy}>
                      {expenseBusy ? 'Saving…' : 'Save expense'}
                    </Button>
                  </DialogActions>
                </form>
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      {(balanceEditor || cardBalanceEditor) && (
        <Dialog
          open={Boolean(balanceEditor || cardBalanceEditor)}
          modalType="modal"
          onOpenChange={(_event, data) => {
            if (
              !data.open &&
              balanceUpdatePendingAccountId === null &&
              cardBalanceUpdatePendingKey === null
            ) {
              closeQuickEditor();
            }
          }}
        >
          <DialogSurface className={styles.quickDialog}>
            <DialogBody>
              <DialogTitle>
                {quickCashAccount?.name ?? quickCard?.cardName ?? 'Quick update'}
              </DialogTitle>
              <DialogContent>
                <TabList
                  className={styles.quickTabs}
                  selectedValue={detailArea}
                  aria-label="Financial detail section"
                  onTabSelect={(_event, data) => {
                    const value = data.value;
                    setDetailArea(value === 'activity' || value === 'plan' ? value : 'now');
                    setDetailActionError(null);
                  }}
                >
                  <Tab value="now">Now</Tab>
                  <Tab value="activity">Activity</Tab>
                  <Tab value="plan">Plan</Tab>
                </TabList>

                {detailArea === 'now' && (
                  <>
                    <TabList
                      className={styles.quickTabs}
                      selectedValue={quickMode}
                      aria-label="Quick update mode"
                      onTabSelect={(_event, data) => {
                        const nextMode = data.value === 'transaction' ? 'transaction' : 'balance';
                        setQuickMode(nextMode);
                        if (nextMode === 'transaction') {
                          setQuickTransaction({
                            direction: 'outflow',
                            amount: '',
                            label: '',
                            date: currentBalanceDate,
                            notes: '',
                          });
                        }
                      }}
                    >
                      <Tab value="balance">Balance</Tab>
                      <Tab value="transaction">Transaction</Tab>
                    </TabList>

                    {quickMode === 'balance' && balanceEditor && quickCashAccount && (
                      <form
                        className={styles.quickDialogForm}
                        aria-label={`Update ${quickCashAccount.name} balance`}
                        aria-busy={balanceUpdatePendingAccountId !== null}
                        onSubmit={(event) => void saveBalanceUpdate(event)}
                      >
                        <Text className={styles.detail}>
                          Displayed balance {formatMoney(quickCashAccount.balanceCents)}
                        </Text>
                        <Field label="New balance">
                          <Input
                            autoFocus
                            inputMode="decimal"
                            required
                            value={balanceEditor.balance}
                            onChange={(_event, data) =>
                              setBalanceEditor((current) =>
                                current ? { ...current, balance: data.value } : current,
                              )
                            }
                          />
                        </Field>
                        <Field label="Balance as of">
                          <Input
                            type="date"
                            max={currentBalanceDate}
                            required
                            value={balanceEditor.balanceAsOf}
                            onChange={(_event, data) =>
                              setBalanceEditor((current) =>
                                current ? { ...current, balanceAsOf: data.value } : current,
                              )
                            }
                          />
                        </Field>
                        <div className={styles.quickPreview} aria-live="polite">
                          <Text>Resulting balance</Text>
                          <strong>
                            {Number.isFinite(Number(balanceEditor.balance))
                              ? formatMoney(Math.round(Number(balanceEditor.balance) * 100))
                              : '—'}
                          </strong>
                        </div>
                        {balanceUpdateError && (
                          <div role="alert" className={styles.error}>
                            {balanceUpdateError}
                          </div>
                        )}
                        <Button
                          type="button"
                          appearance="subtle"
                          size="small"
                          onClick={() => {
                            closeQuickEditor();
                            navigate('/settings?section=accounts');
                          }}
                        >
                          Full account settings
                        </Button>
                        <DialogActions>
                          <Button type="button" appearance="subtle" onClick={closeQuickEditor}>
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            appearance="primary"
                            disabled={balanceUpdatePendingAccountId !== null}
                          >
                            {balanceUpdatePendingAccountId ? 'Saving…' : 'Save balance'}
                          </Button>
                        </DialogActions>
                      </form>
                    )}

                    {quickMode === 'balance' && cardBalanceEditor && quickCard && (
                      <form
                        className={styles.quickDialogForm}
                        aria-label={`Update ${quickCard.cardName} balance`}
                        aria-busy={cardBalanceUpdatePendingKey !== null}
                        onSubmit={(event) => void saveCardBalanceUpdate(event)}
                      >
                        <div className={styles.quickModeActions} aria-label="Card balance type">
                          <Button
                            type="button"
                            size="small"
                            appearance={cardBalanceEditor.kind === 'current' ? 'primary' : 'subtle'}
                            onClick={() =>
                              void startCardBalanceUpdate(
                                quickCard.cardId,
                                quickCard.cardName,
                                'current',
                                quickCardDebt,
                              )
                            }
                          >
                            Current total
                          </Button>
                          <Button
                            type="button"
                            size="small"
                            disabled={!quickCardDebt?.latestStatementDate}
                            appearance={
                              cardBalanceEditor.kind === 'statement' ? 'primary' : 'subtle'
                            }
                            onClick={() =>
                              void startCardBalanceUpdate(
                                quickCard.cardId,
                                quickCard.cardName,
                                'statement',
                                quickCardDebt,
                              )
                            }
                          >
                            Last statement
                          </Button>
                        </div>
                        <Field
                          label={
                            cardBalanceEditor.kind === 'current'
                              ? 'Issuer current balance'
                              : 'Latest statement balance'
                          }
                        >
                          <Input
                            autoFocus
                            inputMode="decimal"
                            required
                            value={cardBalanceEditor.amount}
                            onChange={(_event, data) =>
                              setCardBalanceEditor((current) =>
                                current ? { ...current, amount: data.value } : current,
                              )
                            }
                          />
                        </Field>
                        {cardBalanceEditor.kind === 'current' && (
                          <Field label="Balance as of">
                            <Input
                              type="date"
                              max={currentBalanceDate}
                              required
                              value={cardBalanceEditor.balanceAsOf}
                              onChange={(_event, data) =>
                                setCardBalanceEditor((current) =>
                                  current ? { ...current, balanceAsOf: data.value } : current,
                                )
                              }
                            />
                          </Field>
                        )}
                        {cardBalanceEditor.kind === 'statement' && cardBalanceEditor.dueOn && (
                          <div className={styles.quickPreview}>
                            <Text>Due {displayDate(cardBalanceEditor.dueOn)} · still owed</Text>
                            <strong>
                              {formatMoney(quickCardDebt?.amountCurrentlyDueCents ?? 0)}
                            </strong>
                          </div>
                        )}
                        {cardBalanceEditor.kind === 'statement' &&
                          cardBalanceEditor.dueOn &&
                          statementBalanceEditIsUnusual(
                            { dueOn: cardBalanceEditor.dueOn },
                            currentBalanceDate,
                          ) && (
                            <div className={styles.cardBalanceWarning} role="note">
                              This statement is past its due date. Editing it now is unusual, but
                              allowed.
                            </div>
                          )}
                        {cardBalanceUpdateError?.cardId === quickCard.cardId && (
                          <div role="alert" className={styles.error}>
                            {cardBalanceUpdateError.message}
                          </div>
                        )}
                        <Button
                          type="button"
                          appearance="subtle"
                          size="small"
                          onClick={() => {
                            closeQuickEditor();
                            navigate('/cards');
                          }}
                        >
                          Manage card
                        </Button>
                        <DialogActions>
                          <Button type="button" appearance="subtle" onClick={closeQuickEditor}>
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            appearance="primary"
                            disabled={cardBalanceUpdatePendingKey !== null}
                          >
                            {cardBalanceUpdatePendingKey ? 'Saving…' : 'Save balance'}
                          </Button>
                        </DialogActions>
                      </form>
                    )}

                    {quickMode === 'transaction' && (quickCashAccount || quickCard) && (
                      <form
                        className={styles.quickDialogForm}
                        aria-label={`Log transaction for ${quickCashAccount?.name ?? quickCard?.cardName}`}
                        aria-busy={
                          balanceUpdatePendingAccountId !== null ||
                          cardBalanceUpdatePendingKey !== null
                        }
                        onSubmit={(event) => void saveQuickTransaction(event)}
                      >
                        <Field label="Type">
                          <Select
                            autoFocus
                            value={quickTransaction.direction}
                            onChange={(_event, data) =>
                              setQuickTransaction((current) => ({
                                ...current,
                                direction: data.value === 'inflow' ? 'inflow' : 'outflow',
                              }))
                            }
                          >
                            <option value="outflow">
                              {quickCashAccount ? 'Withdrawal' : 'Purchase'}
                            </option>
                            <option value="inflow">
                              {quickCashAccount ? 'Deposit' : 'Card credit'}
                            </option>
                          </Select>
                        </Field>
                        <Field label="Amount">
                          <Input
                            inputMode="decimal"
                            required
                            value={quickTransaction.amount}
                            onChange={(_event, data) =>
                              setQuickTransaction((current) => ({ ...current, amount: data.value }))
                            }
                          />
                        </Field>
                        <Field label="Description">
                          <Input
                            required
                            maxLength={240}
                            value={quickTransaction.label}
                            onChange={(_event, data) =>
                              setQuickTransaction((current) => ({ ...current, label: data.value }))
                            }
                          />
                        </Field>
                        <Field label={quickCard ? 'Posted date' : 'Transaction date'}>
                          <Input
                            type="date"
                            min={balanceEditor?.balanceAsOf}
                            required
                            value={quickTransaction.date}
                            onChange={(_event, data) =>
                              setQuickTransaction((current) => ({ ...current, date: data.value }))
                            }
                          />
                        </Field>
                        <div className={styles.quickPreview} aria-live="polite">
                          <Text>
                            {quickCashAccount
                              ? 'Resulting account balance'
                              : 'Resulting card balance'}
                          </Text>
                          <strong>
                            {formatMoney(
                              quickCashAccount ? quickCashPreviewCents : quickCardPreviewCents,
                            )}
                          </strong>
                        </div>
                        {quickCard && (
                          <Text size={200} className={styles.detail}>
                            Current-cycle spending becomes {formatMoney(quickCardCyclePreviewCents)}
                            . Bank cash does not move until a card payment.
                          </Text>
                        )}
                        <details>
                          <summary>More options</summary>
                          <Field label="Notes (optional)">
                            <Textarea
                              resize="vertical"
                              value={quickTransaction.notes}
                              onChange={(_event, data) =>
                                setQuickTransaction((current) => ({
                                  ...current,
                                  notes: data.value,
                                }))
                              }
                            />
                          </Field>
                        </details>
                        {quickCashAccount && (
                          <div className={styles.quickModeActions}>
                            <Button
                              type="button"
                              appearance="subtle"
                              size="small"
                              onClick={() => {
                                closeQuickEditor();
                                navigate('/baseline');
                              }}
                            >
                              Transfer instead
                            </Button>
                            <Button
                              type="button"
                              appearance="subtle"
                              size="small"
                              onClick={() => {
                                closeQuickEditor();
                                navigate('/settings?section=accounts');
                              }}
                            >
                              Full account settings
                            </Button>
                          </div>
                        )}
                        {(balanceUpdateError ||
                          cardBalanceUpdateError?.cardId === quickCard?.cardId) && (
                          <div role="alert" className={styles.error}>
                            {balanceUpdateError ?? cardBalanceUpdateError?.message}
                          </div>
                        )}
                        <DialogActions>
                          <Button type="button" appearance="subtle" onClick={closeQuickEditor}>
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            appearance="primary"
                            disabled={
                              balanceUpdatePendingAccountId !== null ||
                              cardBalanceUpdatePendingKey !== null
                            }
                          >
                            {balanceUpdatePendingAccountId || cardBalanceUpdatePendingKey
                              ? 'Saving…'
                              : 'Save transaction'}
                          </Button>
                        </DialogActions>
                      </form>
                    )}
                  </>
                )}

                {detailArea === 'activity' && (
                  <section className={styles.quickDialogForm} aria-label="Recent activity">
                    <Text className={styles.detail}>
                      Recent financial activity. Undo is available for supported manual entries and
                      preserves the original history.
                    </Text>
                    {detailActionError && (
                      <div className={styles.error} role="alert">
                        {detailActionError}
                      </div>
                    )}
                    {detailSourcePosition && (
                      <div className={styles.quickPreview}>
                        <div className={styles.heading}>
                          <strong>
                            {quickCashAccount ? 'Latest bank balance' : 'Issuer balance snapshot'}
                          </strong>
                          <Text size={200} className={styles.detail}>
                            {detailSourcePosition.sourceBalanceDate
                              ? `Reported ${displayDate(detailSourcePosition.sourceBalanceDate)}`
                              : 'Source date unavailable'}
                          </Text>
                        </div>
                        <strong>
                          {detailSourcePosition.sourceBalanceCents === undefined
                            ? 'Unavailable'
                            : formatMoney(detailSourcePosition.sourceBalanceCents)}
                        </strong>
                      </div>
                    )}
                    {detailEvents.map((activity) => {
                      const alreadyReversed = (detailRecords?.events ?? []).some(
                        (candidate) => candidate.sourceRecordId === activity.id,
                      );
                      const canReverse =
                        activity.kind === 'manual-adjustment' &&
                        activity.status === 'confirmed' &&
                        !activity.sourceRecordId &&
                        !alreadyReversed;
                      return (
                        <div className={styles.quickPreview} key={activity.id}>
                          <div className={styles.heading}>
                            <strong>{activity.label}</strong>
                            <Text size={200} className={styles.detail}>
                              {displayDate(activity.date)} ·{' '}
                              {activity.paymentMethod === 'credit-card' ? 'Card' : 'Cash'}
                            </Text>
                          </div>
                          <strong>
                            {activity.direction === 'inflow' ? '+' : '−'}
                            {formatMoney(activity.amountCents)}
                          </strong>
                          {canReverse && (
                            <Button
                              size="small"
                              appearance="subtle"
                              disabled={detailActionBusy}
                              onClick={() => void reverseDetailActivity(activity)}
                            >
                              Undo with reversal
                            </Button>
                          )}
                          {alreadyReversed && <Text size={200}>Reversed</Text>}
                        </div>
                      );
                    })}
                    {detailCycles.map((cycle) => (
                      <div className={styles.quickPreview} key={cycle.id}>
                        <div className={styles.heading}>
                          <strong>Statement {cycle.state.replaceAll('-', ' ')}</strong>
                          <Text size={200} className={styles.detail}>
                            Closed {displayDate(cycle.closesOn)} · due {displayDate(cycle.dueOn)}
                          </Text>
                        </div>
                        <strong>
                          {cycle.lockedStatementCents === undefined
                            ? formatMoney(cycle.actualActivityCents + cycle.plannedActivityCents)
                            : formatMoney(cycle.lockedStatementCents)}
                        </strong>
                      </div>
                    ))}
                    {detailAudits.map((audit) => (
                      <div className={styles.quickPreview} key={audit.id}>
                        <div className={styles.heading}>
                          <strong>{audit.action.replaceAll('-', ' ')}</strong>
                          <Text size={200} className={styles.detail}>
                            Audit history · {displayDate(audit.createdAt.slice(0, 10))}
                          </Text>
                        </div>
                        <Text size={200}>{audit.entityType.replaceAll('-', ' ')}</Text>
                      </div>
                    ))}
                    <Button
                      appearance="subtle"
                      onClick={() => {
                        closeQuickEditor();
                        navigate(
                          quickCard
                            ? `/records?entityType=credit-card&entityId=${encodeURIComponent(quickCard.cardId)}`
                            : `/records?entityType=cash-account&entityId=${encodeURIComponent(quickCashAccount?.id ?? '')}`,
                        );
                      }}
                    >
                      Open complete activity
                    </Button>
                  </section>
                )}

                {detailArea === 'plan' && (
                  <section className={styles.quickDialogForm} aria-label="Financial plan details">
                    {quickCashAccount && (
                      <>
                        <div className={styles.quickPreview}>
                          <Text>Protected minimum</Text>
                          <strong>{formatMoney(quickCashAccount.hardFloorCents)}</strong>
                        </div>
                        <div className={styles.quickPreview}>
                          <Text>Preferred buffer</Text>
                          <strong>
                            {quickCashAccount.preferredFloorCents === undefined
                              ? 'Not set'
                              : formatMoney(quickCashAccount.preferredFloorCents)}
                          </strong>
                        </div>
                      </>
                    )}
                    {quickCard && quickCardDebt && (
                      <>
                        <div className={styles.quickPreview}>
                          <Text>Safe spend this cycle</Text>
                          <strong>{formatMoney(quickCard.spendingPowerCents)}</strong>
                        </div>
                        <div className={styles.quickPreview}>
                          <Text>Payment account</Text>
                          <strong>{quickCard.fundingAccountName}</strong>
                        </div>
                        <div className={styles.quickPreview}>
                          <Text>Next payment</Text>
                          <strong>
                            {displayDate(quickCard.currentCyclePaymentOn ?? quickCard.nextDueOn)}
                          </strong>
                        </div>
                      </>
                    )}
                    <div className={styles.quickModeActions}>
                      {quickCard && (
                        <>
                          <Button
                            appearance="primary"
                            onClick={() => {
                              const cardId = quickCard.cardId;
                              closeQuickEditor();
                              navigate(`/cards?card=${encodeURIComponent(cardId)}&focus=payment`);
                            }}
                          >
                            Record payment
                          </Button>
                          <Button
                            onClick={() => {
                              const cardId = quickCard.cardId;
                              closeQuickEditor();
                              navigate(`/cards?card=${encodeURIComponent(cardId)}&focus=schedule`);
                            }}
                          >
                            Schedule payment
                          </Button>
                        </>
                      )}
                      <Button
                        appearance={quickCard ? 'subtle' : 'primary'}
                        onClick={() => {
                          closeQuickEditor();
                          navigate(quickCard ? '/cards' : '/settings?section=accounts');
                        }}
                      >
                        Open advanced settings
                      </Button>
                    </div>
                  </section>
                )}
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
};
