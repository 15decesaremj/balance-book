import { useEffect, useId, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Text,
  Title1,
  Title2,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Temporal } from '@js-temporal/polyfill';
import {
  compareDates,
  daysBetween,
  plainDateSchema,
  type PlainDateString,
} from '@balance-book/domain';
import type { ForecastSnapshotDto, ManagedRecordsDto } from '../shared/contracts';
import {
  buildChartsViewModel,
  type ChartsCategory,
  type ChartsPoint,
  type ChartsSeries,
  type ChartsTrajectory,
  type ChartsViewModel,
} from './charts-view-model';
import { formatMoney, formatPlainDate } from './utils';
import { LoadingSkeleton } from './LoadingSkeleton';

const categoryDetails: Array<{ id: ChartsCategory; label: string; symbol: string }> = [
  { id: 'position', label: 'Total position', symbol: '◉' },
  { id: 'cash', label: 'Cash accounts', symbol: '⌁' },
  { id: 'cards', label: 'Cards', symbol: '▱' },
  { id: 'loans', label: 'Loans', symbol: '↘' },
  { id: 'assets', label: 'Investments & assets', symbol: '◇' },
  { id: 'owed', label: 'Money owed', symbol: '↗' },
];

const seriesColors = [
  '#5b8cff',
  '#57d5c7',
  '#b58cff',
  '#ff9c66',
  '#f06f9c',
  '#76c76b',
  '#e8c45d',
  '#66a9db',
  '#c487e8',
  '#e07b72',
  '#7ec7a2',
  '#9a9fea',
];

const useStyles = makeStyles({
  page: {
    width: '100%',
    minWidth: 0,
    maxWidth: '1500px',
    marginInline: 'auto',
    display: 'grid',
    gap: tokens.spacingVerticalXXL,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalXL,
    '@media (max-width: 760px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  heading: { display: 'grid', gap: tokens.spacingVerticalXS, maxWidth: '760px' },
  eyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.11em',
    textTransform: 'uppercase',
  },
  detail: { color: tokens.colorNeutralForeground2, maxWidth: '76ch' },
  windowBadge: {
    display: 'grid',
    gap: '2px',
    minWidth: '220px',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: '999px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  glass: {
    minWidth: 0,
    padding: tokens.spacingHorizontalXL,
    borderRadius: '28px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundImage: `linear-gradient(145deg, color-mix(in srgb, ${tokens.colorNeutralBackground1} 92%, transparent), color-mix(in srgb, ${tokens.colorBrandBackground2} 26%, ${tokens.colorNeutralBackground1}))`,
    boxShadow: tokens.shadow8,
    backdropFilter: 'blur(28px) saturate(145%)',
    WebkitBackdropFilter: 'blur(28px) saturate(145%)',
  },
  controls: { display: 'grid', gap: tokens.spacingVerticalL },
  controlGroup: { display: 'grid', gap: tokens.spacingVerticalS },
  controlLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  pillRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  pill: { borderRadius: '999px' },
  chartCard: { display: 'grid', gap: tokens.spacingVerticalXL },
  chartHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 640px)': { flexDirection: 'column' },
  },
  chartFrame: {
    width: '100%',
    minWidth: 0,
    overflow: 'hidden',
    borderRadius: '20px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: 'color-mix(in srgb, currentColor 2%, transparent)',
  },
  dataDisclosure: {
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    '& > summary': {
      width: 'fit-content',
      color: tokens.colorNeutralForeground2,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
  dataViewport: {
    maxWidth: '100%',
    maxHeight: '440px',
    overflow: 'auto',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  dataTable: {
    width: '100%',
    minWidth: '620px',
    borderCollapse: 'collapse',
    '& th, & td': {
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      textAlign: 'left',
    },
    '& th': {
      position: 'sticky',
      top: 0,
      zIndex: 1,
      color: tokens.colorNeutralForeground3,
      backgroundColor: tokens.colorNeutralBackground2,
      fontSize: tokens.fontSizeBase200,
    },
    '& td:nth-child(3), & th:nth-child(3)': {
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
    },
  },
  svg: { display: 'block', width: '100%', height: 'auto', minHeight: '280px' },
  empty: {
    minHeight: '300px',
    display: 'grid',
    placeItems: 'center',
    padding: tokens.spacingHorizontalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  legend: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  legendButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minHeight: '32px',
    padding: `4px ${tokens.spacingHorizontalM}`,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '999px',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    font: 'inherit',
    '&:focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '2px',
    },
  },
  legendMuted: { opacity: 0.42, textDecorationLine: 'line-through' },
  dot: { width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 auto' },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 980px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 540px)': { gridTemplateColumns: '1fr' },
  },
  metricCard: {
    minWidth: 0,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalXL,
    borderRadius: '22px',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  metricValue: {
    fontSize: 'clamp(1.3rem, 2.5vw, 2rem)',
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.035em',
    fontVariantNumeric: 'tabular-nums',
  },
  metricDetail: { color: tokens.colorNeutralForeground3 },
  positive: { color: tokens.colorPaletteGreenForeground1 },
  negative: { color: tokens.colorPaletteRedForeground1 },
  notes: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground2,
    '& summary': { cursor: 'pointer', fontWeight: tokens.fontWeightSemibold },
  },
  noteList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
  },
  loadState: { minHeight: '420px', display: 'grid', placeItems: 'center' },
  error: {
    padding: tokens.spacingHorizontalXL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
  },
});

const compactMoney = (cents: number): string => {
  const dollars = cents / 100;
  const absolute = Math.abs(dollars);
  const sign = dollars < 0 ? '-' : '';
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}k`;
  return `${sign}$${absolute.toFixed(0)}`;
};

const splitSegments = (points: ChartsPoint[]): ChartsPoint[][] => {
  const segments: ChartsPoint[][] = [];
  for (const point of points) {
    const mode = point.provenance === 'projected' || point.provenance === 'modeled';
    const last = segments.at(-1);
    const lastPoint = last?.at(-1);
    const lastMode = lastPoint?.provenance === 'projected' || lastPoint?.provenance === 'modeled';
    if (!last || mode !== lastMode) segments.push([point]);
    else last.push(point);
  }
  for (let index = 1; index < segments.length; index += 1) {
    const priorPoint = segments[index - 1]?.at(-1);
    if (priorPoint) segments[index]!.unshift(priorPoint);
  }
  return segments;
};

const SvgChart = ({
  series,
  asOfDate,
}: {
  series: Array<ChartsSeries & { color: string }>;
  asOfDate: PlainDateString;
}): React.JSX.Element => {
  const titleId = useId();
  const descriptionId = useId();
  const width = 960;
  const height = 440;
  const margin = { top: 26, right: 24, bottom: 54, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allPoints = series.flatMap((candidate) => candidate.points);
  if (allPoints.length === 0) return <div />;
  const dates = allPoints.map((point) => point.date).sort(compareDates);
  const startDate = dates[0]!;
  const endDate = dates.at(-1)!;
  const totalDays = Math.max(1, daysBetween(startDate, endDate));
  const values = allPoints.map((point) => point.cents);
  const rawLow = Math.min(...values);
  const rawHigh = Math.max(...values);
  const yPadding = Math.max(1, (rawHigh - rawLow) * 0.09, Math.abs(rawHigh) * 0.02);
  const low = rawLow - yPadding;
  const high = rawHigh + yPadding;
  const ySpan = Math.max(1, high - low);
  const xFor = (date: PlainDateString): number =>
    margin.left + (daysBetween(startDate, date) / totalDays) * plotWidth;
  const yFor = (cents: number): number =>
    margin.top + plotHeight - ((cents - low) / ySpan) * plotHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => low + (ySpan * index) / 4);
  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const days = Math.round((totalDays * index) / 4);
    return plainDateSchema.parse(Temporal.PlainDate.from(startDate).add({ days }).toString());
  });
  const showAsOf = compareDates(asOfDate, startDate) >= 0 && compareDates(asOfDate, endDate) <= 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', width: '100%', height: 'auto' }}
    >
      <title id={titleId}>Financial balance trends</title>
      <desc id={descriptionId}>
        {series.length} selected series from {formatPlainDate(startDate)} through{' '}
        {formatPlainDate(endDate)}. Solid marks are recorded values; dashed marks are modeled or
        projected.
      </desc>
      {yTicks.map((value) => {
        const y = yFor(value);
        return (
          <g key={value}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity="0.09"
            />
            <text
              x={margin.left - 12}
              y={y + 4}
              textAnchor="end"
              fill="currentColor"
              opacity="0.62"
              fontSize="12"
            >
              {compactMoney(value)}
            </text>
          </g>
        );
      })}
      {xTicks.map((date) => (
        <g key={date}>
          <line
            x1={xFor(date)}
            x2={xFor(date)}
            y1={margin.top}
            y2={height - margin.bottom}
            stroke="currentColor"
            strokeOpacity="0.045"
          />
          <text
            x={xFor(date)}
            y={height - margin.bottom + 28}
            textAnchor="middle"
            fill="currentColor"
            opacity="0.62"
            fontSize="12"
          >
            {Temporal.PlainDate.from(date).toLocaleString(undefined, {
              month: 'short',
              year: '2-digit',
            })}
          </text>
        </g>
      ))}
      {showAsOf ? (
        <g>
          <line
            x1={xFor(asOfDate)}
            x2={xFor(asOfDate)}
            y1={margin.top}
            y2={height - margin.bottom}
            stroke="currentColor"
            strokeOpacity="0.38"
            strokeDasharray="3 5"
          />
          <text
            x={xFor(asOfDate) + 7}
            y={margin.top + 12}
            fill="currentColor"
            opacity="0.72"
            fontSize="11"
          >
            Today
          </text>
        </g>
      ) : null}
      {series.map((candidate) =>
        splitSegments(candidate.points).map((segment, segmentIndex) => {
          const projected = segment.some(
            (point) => point.provenance === 'projected' || point.provenance === 'modeled',
          );
          const path = segment
            .map(
              (point, index) =>
                `${index === 0 ? 'M' : 'L'} ${xFor(point.date).toFixed(2)} ${yFor(point.cents).toFixed(2)}`,
            )
            .join(' ');
          return (
            <g key={`${candidate.id}-${segmentIndex}`}>
              {segment.length > 1 ? (
                <path
                  d={path}
                  fill="none"
                  stroke={candidate.color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={projected ? '7 6' : undefined}
                />
              ) : null}
              {segment.map((point) => {
                const projectedPoint =
                  point.provenance === 'projected' || point.provenance === 'modeled';
                return (
                  <circle
                    key={`${candidate.id}-${point.date}`}
                    cx={xFor(point.date)}
                    cy={yFor(point.cents)}
                    r={projectedPoint ? 2.2 : 3.6}
                    fill={candidate.color}
                    stroke={projectedPoint ? 'none' : 'currentColor'}
                    strokeWidth={projectedPoint ? 0 : 0.8}
                  >
                    <title>
                      {candidate.label}: {formatMoney(point.cents)} on {formatPlainDate(point.date)}{' '}
                      ({point.provenance})
                    </title>
                  </circle>
                );
              })}
            </g>
          );
        }),
      )}
    </svg>
  );
};

const MetricCard = ({
  label,
  value,
  detail,
  change,
}: {
  label: string;
  value: string;
  detail: string;
  change?: number;
}): React.JSX.Element => {
  const styles = useStyles();
  const valueClass =
    change === undefined ? undefined : change >= 0 ? styles.positive : styles.negative;
  return (
    <Card className={styles.metricCard}>
      <Text className={styles.controlLabel}>{label}</Text>
      <Text className={mergeClasses(styles.metricValue, valueClass)}>{value}</Text>
      <Text size={200} className={styles.metricDetail}>
        {detail}
      </Text>
    </Card>
  );
};

const trajectoryText = (trajectory: ChartsTrajectory | null): string =>
  trajectory ? formatMoney(trajectory.changeCents) : 'Not available';

export const ChartsPage = ({
  experimentalCardInterestForecastEnabled,
}: {
  experimentalCardInterestForecastEnabled: boolean;
}): React.JSX.Element => {
  const styles = useStyles();
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [forecast, setForecast] = useState<ForecastSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [showFuture, setShowFuture] = useState(true);
  const [categories, setCategories] = useState<Set<ChartsCategory>>(
    () => new Set(categoryDetails.map((category) => category.id)),
  );
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    const requiredEndDate = plainDateSchema.parse(
      Temporal.Now.plainDateISO().add({ months: 12 }).toString(),
    );
    void Promise.all([
      window.balanceBook.listRecords(),
      window.balanceBook.getForecast({ requiredEndDate }),
    ])
      .then(([recordsResult, forecastResult]) => {
        if (!active) return;
        if (!recordsResult.ok) throw new Error(recordsResult.error);
        if (!forecastResult.ok) throw new Error(forecastResult.error);
        setRecords(recordsResult.value);
        setForecast(forecastResult.value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Charts could not load.');
      });
    return () => {
      active = false;
    };
  }, []);

  const model = useMemo<ChartsViewModel | null>(() => {
    if (!records || !forecast) return null;
    return buildChartsViewModel({
      records,
      forecast,
      historyMonths: 12,
      futureMonths: 12,
      experimentalCardInterestForecastEnabled,
    });
  }, [experimentalCardInterestForecastEnabled, forecast, records]);

  const visibleSeries = useMemo(() => {
    if (!model) return [];
    return model.series
      .filter((series) => categories.has(series.category) && !hiddenSeries.has(series.id))
      .map((series) => ({
        ...series,
        color:
          seriesColors[
            model.series.findIndex((candidate) => candidate.id === series.id) % seriesColors.length
          ]!,
        points: series.points.filter((point) =>
          compareDates(point.date, model.asOfDate) < 0 ? showHistory : showFuture,
        ),
      }))
      .filter((series) => series.points.length > 0);
  }, [categories, hiddenSeries, model, showFuture, showHistory]);

  const visibleRange = useMemo(() => {
    const values = visibleSeries.flatMap((series) => series.points.map((point) => point.cents));
    return values.length === 0
      ? { lowCents: null, highCents: null }
      : { lowCents: Math.min(...values), highCents: Math.max(...values) };
  }, [visibleSeries]);

  const visibleTableRows = useMemo(
    () =>
      visibleSeries
        .flatMap((series) =>
          series.points.map((point) => ({
            ...point,
            seriesId: series.id,
            seriesLabel: series.label,
          })),
        )
        .sort(
          (left, right) =>
            compareDates(left.date, right.date) ||
            left.seriesLabel.localeCompare(right.seriesLabel),
        ),
    [visibleSeries],
  );

  const toggleCategory = (category: ChartsCategory): void => {
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const toggleSeries = (seriesId: string, category: ChartsCategory): void => {
    if (!categories.has(category)) {
      setCategories((current) => new Set(current).add(category));
      setHiddenSeries((current) => {
        const next = new Set(current);
        next.delete(seriesId);
        return next;
      });
      return;
    }
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
  };

  if (error) {
    return (
      <div className={styles.page}>
        <div role="alert" className={styles.error}>
          <strong>Charts could not load.</strong> {error}
        </div>
      </div>
    );
  }
  if (!model) {
    return <LoadingSkeleton label="Building your financial timeline" variant="dashboard" />;
  }

  const metrics = model.metrics;
  const hasChartData = visibleSeries.some((series) => series.points.length > 0);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Text className={styles.eyebrow}>Financial timeline</Text>
          <Title1 as="h1">Trends</Title1>
          <Text className={styles.detail}>
            One year back and one year forward. Missing history stays blank.
          </Text>
        </div>
        <div className={styles.windowBadge} aria-label="Visible date window">
          <Text size={200}>12 months back · 12 months forward</Text>
          <strong>
            {formatPlainDate(model.windowStartDate)} – {formatPlainDate(model.windowEndDate)}
          </strong>
        </div>
      </header>

      <section className={mergeClasses(styles.glass, styles.controls)} aria-label="Chart controls">
        <div className={styles.controlGroup}>
          <Text className={styles.controlLabel}>Time</Text>
          <div className={styles.pillRow}>
            <Button
              className={styles.pill}
              appearance={showHistory ? 'primary' : 'subtle'}
              aria-pressed={showHistory}
              onClick={() => setShowHistory((current) => !current || !showFuture)}
            >
              Historical
            </Button>
            <Button
              className={styles.pill}
              appearance={showFuture ? 'primary' : 'subtle'}
              aria-pressed={showFuture}
              onClick={() => setShowFuture((current) => !current || !showHistory)}
            >
              Expected future
            </Button>
          </div>
        </div>
        <div className={styles.controlGroup}>
          <Text className={styles.controlLabel}>Show</Text>
          <div className={styles.pillRow}>
            {categoryDetails.map((category) => {
              const selected = categories.has(category.id);
              const available = model.series.some((series) => series.category === category.id);
              return (
                <Button
                  key={category.id}
                  className={styles.pill}
                  appearance={selected ? 'primary' : 'subtle'}
                  aria-pressed={selected}
                  disabled={!available}
                  onClick={() => toggleCategory(category.id)}
                >
                  <span aria-hidden="true">{category.symbol}</span> {category.label}
                </Button>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className={mergeClasses(styles.glass, styles.chartCard)}
        aria-labelledby="balance-chart-title"
      >
        <div className={styles.chartHeader}>
          <div className={styles.heading}>
            <Title2 as="h2" id="balance-chart-title">
              Balances over time
            </Title2>
            <Text className={styles.detail}>
              Solid points are observed or reported. Dashed lines are expected or amortized.
            </Text>
          </div>
          <Text size={200} className={styles.metricDetail}>
            Forecast available through {formatPlainDate(model.actualEndDate)}
          </Text>
        </div>
        <div className={styles.legend} aria-label="Chart legend">
          {model.series.map((series, index) => {
            const hidden = hiddenSeries.has(series.id) || !categories.has(series.category);
            return (
              <button
                type="button"
                key={series.id}
                className={mergeClasses(
                  styles.legendButton,
                  hidden ? styles.legendMuted : undefined,
                )}
                aria-pressed={!hidden}
                onClick={() => toggleSeries(series.id, series.category)}
              >
                <span
                  className={styles.dot}
                  style={{ backgroundColor: seriesColors[index % seriesColors.length] }}
                  aria-hidden="true"
                />
                {series.label}
              </button>
            );
          })}
        </div>
        <div className={styles.chartFrame}>
          {hasChartData ? (
            <SvgChart series={visibleSeries} asOfDate={model.asOfDate} />
          ) : (
            <div className={styles.empty}>
              Select at least one available time range and balance series.
            </div>
          )}
        </div>
        {hasChartData ? (
          <details className={styles.dataDisclosure}>
            <summary>View chart data ({visibleTableRows.length} points)</summary>
            <div className={styles.dataViewport} tabIndex={0} aria-label="Visible chart data table">
              <table className={styles.dataTable}>
                <caption className="balance-visually-hidden">Visible chart data</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Series</th>
                    <th scope="col">Balance</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTableRows.map((point) => (
                    <tr key={`${point.seriesId}-${point.date}`}>
                      <td>{formatPlainDate(point.date)}</td>
                      <td>{point.seriesLabel}</td>
                      <td>{formatMoney(point.cents)}</td>
                      <td>{point.provenance.replace('-', ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="chart-metrics-title">
        <div className={styles.heading} style={{ marginBottom: tokens.spacingVerticalL }}>
          <Text className={styles.eyebrow}>At a glance</Text>
          <Title2 as="h2" id="chart-metrics-title">
            Patterns that matter
          </Title2>
        </div>
        <div className={styles.metricGrid}>
          <MetricCard
            label="Visible recorded range"
            value={
              visibleRange.lowCents === null || visibleRange.highCents === null
                ? 'Not available'
                : `${formatMoney(visibleRange.lowCents)} – ${formatMoney(visibleRange.highCents)}`
            }
            detail="Lowest and highest value across the selected chart series; missing dates are not filled."
          />
          <MetricCard
            label="Average money owed"
            value={
              metrics.averageMonthlyOwedCents === null
                ? 'Not available'
                : formatMoney(metrics.averageMonthlyOwedCents)
            }
            detail="Average of daily owed balances within each available forecast month."
          />
          <MetricCard
            label="Average card balance"
            value={
              metrics.averageMonthlyCardBalanceCents === null
                ? 'Not available'
                : formatMoney(metrics.averageMonthlyCardBalanceCents)
            }
            detail="Monthly total using each card’s latest available point in that month."
          />
          <MetricCard
            label="Average monthly carry"
            value={
              metrics.averageMonthlyCarryCents === null
                ? 'Not available'
                : formatMoney(metrics.averageMonthlyCarryCents)
            }
            detail={`Paid statement shortfalls only · current carry ${formatMoney(metrics.currentCarryCents)}.`}
          />
          <MetricCard
            label="Total-position trajectory"
            value={trajectoryText(metrics.totalPositionTrajectory)}
            change={metrics.totalPositionTrajectory?.changeCents}
            detail={
              metrics.totalPositionTrajectory
                ? `${formatMoney(metrics.totalPositionTrajectory.startCents)} → ${formatMoney(metrics.totalPositionTrajectory.endCents)}`
                : 'Requires at least two dated forecast points.'
            }
          />
          <MetricCard
            label="Net-worth trajectory"
            value={trajectoryText(metrics.netWorthTrajectory)}
            change={metrics.netWorthTrajectory?.changeCents}
            detail={
              metrics.netWorthTrajectory
                ? `${formatMoney(metrics.netWorthTrajectory.startCents)} → ${formatMoney(metrics.netWorthTrajectory.endCents)} · latest asset values held constant`
                : 'Requires a current net-worth baseline and future forecast.'
            }
          />
        </div>
      </section>

      <details className={mergeClasses(styles.glass, styles.notes)}>
        <summary>How these charts handle missing history</summary>
        <ul className={styles.noteList}>
          {model.availabilityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};
