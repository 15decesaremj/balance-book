import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Field,
  Input,
  Text,
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
import { useNavigate } from 'react-router';
import type { ForecastSnapshotDto, ScenarioResponseDto } from '../shared/contracts';
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

type ForecastMode = 'conservative' | 'expected';
type SeriesId = 'position' | 'cash' | `account:${string}`;
type DailyPoint = NonNullable<ForecastSnapshotDto['dailyCash']>[number];
type CardPowerRow = NonNullable<ForecastSnapshotDto['cardSpendingPower']>[number];
type FundingNeed = NonNullable<ForecastSnapshotDto['transferNeeds']>[number];
type CashAdvisorResult = {
  accountId: string;
  accountName: string;
  scenario: ScenarioResponseDto;
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
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalXL,
    '@media (max-width: 760px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  heading: { display: 'grid', gap: tokens.spacingVerticalXS },
  eyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  detail: { color: tokens.colorNeutralForeground2, maxWidth: '76ch' },
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
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1080px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 360px)': { gridTemplateColumns: '1fr' },
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
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1120px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 680px)': { gridTemplateColumns: '1fr' },
  },
  safeSpendHero: {
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
  insightPill: {
    width: 'fit-content',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorPaletteGreenForeground1,
    backgroundColor: tokens.colorPaletteGreenBackground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  insightPillCaution: {
    color: tokens.colorPaletteDarkOrangeForeground2,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground2,
  },
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
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
  },
  cardTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
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
  },
  warningText: { color: tokens.colorPaletteDarkOrangeForeground2 },
  dangerText: { color: tokens.colorPaletteRedForeground1 },
  factGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
  },
  fact: { minWidth: 0, display: 'grid', gap: tokens.spacingVerticalXXS },
  factValue: { fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
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
    '&:last-child': { borderBottom: 'none' },
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
    gridTemplateColumns: 'minmax(180px, 0.8fr) minmax(0, 2fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
      alignItems: 'stretch',
    },
  },
  fundingFacts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
    '@media (max-width: 720px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 420px)': { gridTemplateColumns: '1fr' },
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
}: {
  fullForecast?: boolean;
}): React.JSX.Element => {
  const styles = useDashboardStyles();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ForecastMode>('expected');
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
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);

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
  const cardPower =
    mode === 'expected'
      ? (snapshot.cardSpendingPower ?? [])
      : (snapshot.conservativeCardSpendingPower ?? snapshot.cardSpendingPower ?? []);
  const advisorCardById = new Map<string, CardPowerRow>();
  for (const card of [
    ...(snapshot.cardSpendingPower ?? []),
    ...(snapshot.conservativeCardSpendingPower ?? []),
  ]) {
    advisorCardById.set(card.cardId, card);
  }
  const allAdvisorCards = [...advisorCardById.values()];
  const advisorCards = allAdvisorCards.filter(
    (card) =>
      card.spendingPowerStatus === 'determinate' ||
      card.spendingPowerStatus === 'conditional-existing-shortfall',
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
                forecastMode: mode,
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
                forecastMode: mode,
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
      setAdvisorBusy(false);
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
        : ((snapshot.cashAccounts ?? []).find(
            (account) => account.id === series.slice('account:'.length),
          )?.name ?? 'Account');
  const selectedSeriesAccount = series.startsWith('account:')
    ? (snapshot.cashAccounts ?? []).find(
        (account) => account.id === series.slice('account:'.length),
      )
    : undefined;

  const changeMode = (nextMode: ForecastMode): void => {
    setMode(nextMode);
    setAdvisorResults(null);
    setCashAdvisorResults(null);
    setAdvisorEvaluation(null);
    setAdvisorError(null);
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
            <Title1 as="h1">Daily balance ledger</Title1>
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
            Reconcile a balance
          </Button>
        </div>

        <section className={styles.metricGrid} aria-label="Forecast summary">
          <Metric
            label={`${mode === 'expected' ? 'Expected' : 'Conservative'} position low`}
            value={positionLow}
            detail={displayDate(positionLowDate)}
            explanation={`${mode === 'expected' ? 'Expected' : 'Conservative'} daily liquid cash plus the outstanding receivable balance on each date; this is the lowest total within the visible horizon.`}
          />
          <Metric
            label="Liquid cash low"
            value={cashLow}
            detail={displayDate(cashLowDate)}
            explanation="Lowest daily close across cash accounts included in liquidity. The separate status warning also checks more conservative intraday ordering."
          />
          <Metric
            label="Money owed now"
            value={currentOwed}
            detail="Tracked separately from cash until received"
            explanation="Open receivable balances at the forecast start. Their own accrual schedules change money owed; settlement schedules change owed and cash together."
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
                                  <span>
                                    {event.label}{' '}
                                    <strong>
                                      {formatMoney(
                                        event.direction === 'outflow'
                                          ? -event.amountCents
                                          : event.amountCents,
                                      )}
                                    </strong>
                                  </span>
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
                              <span>
                                {event.label}{' '}
                                <strong>
                                  {formatMoney(
                                    event.direction === 'outflow'
                                      ? -event.amountCents
                                      : event.amountCents,
                                  )}
                                </strong>
                              </span>
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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Text className={styles.eyebrow}>Overview</Text>
          <Title1 as="h1">How much can I safely spend?</Title1>
          <Text className={styles.detail}>
            One reconciled runway answer for every card, tied to its current-cycle due date, every
            bank account, money owed to you, and your protected threshold.
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

      <section className={styles.safeSpendHero} aria-labelledby="safe-spend-title">
        <div className={styles.sectionHeader}>
          <div className={styles.heading}>
            <Text className={styles.eyebrow}>Your card runway</Text>
            <Title2 id="safe-spend-title" as="h2">
              Safe to spend on each card today
            </Title2>
            <Text className={styles.detail}>
              Available spend is the lowest projected total position from that card&apos;s
              current-cycle due date forward, less your global protected threshold. Each
              bank-account low covers the current-cycle risk window through the later of that total
              low or the actual payment date. Later account episodes stay in Account coverage. Each
              card is its own runway; do not add them together.
            </Text>
          </div>
          <Button
            appearance="primary"
            onClick={() => document.getElementById('card-advisor-title')?.scrollIntoView()}
          >
            Test a purchase
          </Button>
        </div>
        {cardPower.length === 0 ? (
          <Card className={styles.empty}>
            Add a card, current cycle, payment rule, and funding account to calculate a safe amount.
          </Card>
        ) : (
          <div className={styles.safeSpendGrid}>
            {cardPower.map((card) => {
              const resetDate = card.currentCycleClosesOn;
              const daysUntilReset = resetDate
                ? Math.max(
                    0,
                    Temporal.PlainDate.from(today).until(Temporal.PlainDate.from(resetDate), {
                      largestUnit: 'day',
                    }).days,
                  )
                : undefined;
              const unavailableReason = cardSpendingPowerUnavailableReason(card);
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
              const status = unavailableReason
                ? 'Needs card setup'
                : mode === 'expected'
                  ? card.spendingPowerCents > 0
                    ? 'Runway available'
                    : 'No runway above threshold'
                  : conditionalOnEarlierFunding || fundingShortfall > 0
                    ? 'Runway available · funding needed'
                    : card.spendingPowerCents > 0
                      ? 'Runway available'
                      : 'No runway above threshold';
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
                    visuallySafe ? styles.safeSpendCardSafe : styles.safeSpendCardCaution,
                  )}
                >
                  <div className={styles.powerTop}>
                    <div className={styles.cardTitleRow}>
                      <span
                        className={styles.resetBadge}
                        aria-label={
                          resetDate
                            ? `${daysUntilReset} days until the current statement resets on ${displayDate(resetDate)}`
                            : 'Statement reset date unavailable'
                        }
                        title={
                          resetDate
                            ? `${daysUntilReset} days until statement close · ${displayDate(resetDate)}`
                            : 'Add the current cycle close date'
                        }
                      >
                        {daysUntilReset ?? '–'}
                      </span>
                      <div className={styles.heading}>
                        <strong>{card.cardName}</strong>
                        <Text size={200} className={styles.detail}>
                          {resetDate
                            ? `${daysUntilReset === 0 ? 'Resets today' : `Resets in ${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}`}`
                            : 'Reset timing unavailable'}
                          {mode === 'conservative' ? ` · paid from ${card.fundingAccountName}` : ''}
                        </Text>
                      </div>
                    </div>
                    <Text
                      className={mergeClasses(
                        styles.insightPill,
                        visuallySafe ? undefined : styles.insightPillCaution,
                      )}
                    >
                      {status}
                    </Text>
                  </div>
                  <div>
                    <Text className={styles.metricLabel}>Available spend in current cycle</Text>
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
                  {unavailableReason && <Text className={styles.detail}>{unavailableReason}</Text>}
                  {mode === 'conservative' && fundingInsight && (
                    <Text size={200} className={styles.warningText}>
                      Funding warning: {fundingInsight}
                    </Text>
                  )}
                  {!unavailableReason && (
                    <div className={styles.runwayPanel} aria-label={`${card.cardName} runway lows`}>
                      <Text className={styles.metricLabel}>Current-cycle runway lows</Text>
                      <div className={styles.runwayBalanceGrid}>
                        <div className={styles.fact}>
                          <Text size={200} className={styles.detail}>
                            Lowest total position
                          </Text>
                          <Text
                            aria-label={`${card.cardName} total position low`}
                            className={styles.factValue}
                          >
                            {formatMoney(card.futurePositionLowCents)}
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
                    </div>
                  )}
                  {mode === 'conservative' && !unavailableReason && (
                    <div className={styles.safeSpendFacts}>
                      <div className={styles.fact}>
                        <Text size={200} className={styles.metricLabel}>
                          Cash-only capacity
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
                          Funding-account low
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
                          Future liquid cash low
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
            explanation={`The lowest ${mode} daily close across accounts included in liquidity. Intraday cash reaches ${formatMoney(intradayLow)} on ${displayDate(intradayLowDate)}; this cash-only warning does not replace Spending Power.`}
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
            explanation={`Cash accounts included in liquidity. Money owed to you (${formatMoney(currentOwed)}) improves total position but cannot fund a payment until received.`}
          />
        )}
      </section>

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
                : `Every account projected below its protected minimum in the ${mode} forecast. Suggested transfers respect modeled transfer delays and never execute automatically.`}
            </Text>
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
                  <div className={styles.fundingRow}>
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
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.twoColumn}>
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Next on the calendar</Text>
              <Title2 as="h2">Upcoming cash events</Title2>
              <Text className={styles.detail}>The next items that change a cash account.</Text>
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

        <div className={styles.stack}>
          <div className={styles.panel}>
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Cash accounts</Text>
              <Title2 as="h2">Balances and future lows</Title2>
            </div>
            <div className={styles.accountRows}>
              {(snapshot.cashAccounts ?? []).map((account) => {
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
                  <div className={styles.accountRow} key={account.id}>
                    <strong>{account.name}</strong>
                    <span className={styles.factValue}>{formatMoney(account.balanceCents)}</span>
                    <span
                      className={mergeClasses(
                        styles.accountLow,
                        nextNeed || floorMargin < 0 ? styles.dangerText : undefined,
                      )}
                    >
                      {nextNeed
                        ? `Next below minimum ${formatMoney(account.hardFloorCents - nextNeed.shortfallCents)} on ${displayDate(nextNeed.date)}`
                        : `${mode === 'expected' ? 'Expected' : 'Conservative'} low ${formatMoney(lowAmount)} on ${displayDate(lowDate)}`}
                    </span>
                    {nextNeed && (
                      <span className={mergeClasses(styles.accountLow, styles.dangerText)}>
                        Deepest in that run{' '}
                        {formatMoney(
                          account.hardFloorCents -
                            (nextNeed.horizonDeepestShortfallCents ?? nextNeed.shortfallCents),
                        )}{' '}
                        on {displayDate(nextNeed.horizonDeepestShortfallDate ?? nextNeed.date)}
                      </span>
                    )}
                    <span className={styles.accountLow}>
                      Minimum {formatMoney(account.hardFloorCents)} {' · '} margin{' '}
                      {formatMoney(nextNeed ? -nextNeed.shortfallCents : floorMargin)}
                      {account.preferredFloorCents === undefined
                        ? ''
                        : ` · preferred ${formatMoney(account.preferredFloorCents)}`}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={styles.sectionHeader}>
              <Button appearance="subtle" onClick={() => navigate('/forecast')}>
                Open daily account ledger
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
                Money owed improves your overall position but cannot fund a payment until it is
                actually received. Both lows matter, so the app keeps both visible.
              </Text>
              <Button appearance="subtle" onClick={() => navigate('/receivables')}>
                Review money owed
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="card-advisor-title">
        <div className={styles.advisorPanel}>
          <div className={styles.sectionHeader}>
            <div className={styles.heading}>
              <Text className={styles.eyebrow}>Purchase advisor</Text>
              <Title2 id="card-advisor-title" as="h2">
                Which card should I use?
              </Title2>
              <Text className={styles.detail}>
                Test one amount against cash and every current card using the selected {mode}{' '}
                forecast. Funding safety ranks first, a later cash-payment date breaks close ties,
                and rewards rank last. Available credit is never treated as spendable cash.
              </Text>
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
                {advisorBusy ? 'Comparing cards...' : 'Compare every card'}
              </Button>
            </form>
          )}
          {advisorCards.length === 0 && (snapshot.cashAccounts ?? []).length > 0 && (
            <Text className={styles.warningText}>
              Cash can still be evaluated. Add current card-cycle timing to compare cards too.
            </Text>
          )}
          {advisorUnsupportedCount > 0 && (
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
                            : `No card keeps ${formatMoney(advisorEvaluation.amountCents)} within both the protected cash floor and account-funding guardrails. The closest modeled option is ${leadingOption.card.cardName}, but it is not recommended: ${advisorReason(leadingOption)}`}
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
                              <Text size={200} className={styles.detail}>
                                {advisorReason(option)}
                              </Text>
                              <div className={styles.advisorFacts}>
                                <div className={styles.fact}>
                                  <Text size={200} className={styles.metricLabel}>
                                    Cash leaves
                                  </Text>
                                  <Text className={styles.factValue}>
                                    {displayDate(option.scenario.settlementDate)}
                                  </Text>
                                </div>
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
      </section>

      {mode === 'conservative' && (
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

      <section className={styles.panel} aria-labelledby="wider-picture-title">
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
            <Text className={styles.factValue}>{formatMoney(snapshot.totalDebtCents ?? 0)}</Text>
            <Text size={200}>
              Installment {formatMoney(snapshot.totalLoansCents ?? 0)} · cards and lines{' '}
              {formatMoney(snapshot.totalRevolvingDebtCents ?? 0)}
            </Text>
            <Text size={200}>
              Carrying past payment {formatMoney(snapshot.totalCarryingDebtCents ?? 0)} · modeled
              installment interest/day {formatMoney(snapshot.modeledDailyInterestCents ?? 0)}
            </Text>
          </div>
          <div className={styles.fact}>
            <Text className={styles.metricLabel}>Contractual net worth</Text>
            <Text className={styles.factValue}>
              {formatMoney(snapshot.contractualNetWorthCents ?? 0)}
            </Text>
            <Text size={200}>Economic view {formatMoney(snapshot.economicNetWorthCents ?? 0)}</Text>
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
            <Text className={styles.metricLabel}>Last reconciliation</Text>
            <Text className={styles.factValue}>
              {snapshot.lastReconciliationDate
                ? displayDate(snapshot.lastReconciliationDate)
                : 'Not recorded'}
            </Text>
            <Text size={200}>Actual balances never silently rewrite the original forecast.</Text>
          </div>
        </div>
        <details className={styles.explain}>
          <summary>Explain these totals</summary>
          <Text size={200}>
            Installment totals use each active loan&apos;s balance projected to the financial date.
            Revolving totals use posted debt or an issuer-reported balance; planned purchases and
            future estimates are excluded from current debt. Carrying means a statement residual
            left past payment, so a paid-in-full card can show its statement history while carrying
            zero. Contractual net worth subtracts both current installment and revolving debt.
          </Text>
        </details>
        <div className={styles.sectionHeader}>
          <Button appearance="subtle" onClick={() => navigate('/loans')}>
            Edit loans
          </Button>
          <Button appearance="subtle" onClick={() => navigate('/reconcile')}>
            Reconcile an account
          </Button>
        </div>
      </section>
    </div>
  );
};
