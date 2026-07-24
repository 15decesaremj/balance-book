import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import {
  Button,
  Field,
  FluentProvider,
  Input,
  Select,
  Tab,
  TabList,
  Text,
  Title2,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type {
  ForecastSnapshotDto,
  ManagedRecordsDto,
  NotificationPresentationDto,
  UpdateStatusDto,
} from '../shared/contracts';
import {
  overviewBalanceUpdateRequest,
  overviewCardBalanceUpdateRequest,
} from './overview-mutations';
import {
  generateFinancialNotifications,
  unresolvedNotificationCount,
  type FinancialNotification,
} from './notifications';
import { dollarsToCents, formatMoney, formatPlainDate } from './utils';
import { announceCanonicalDataChanged, FINANCIAL_STATE_CHANGED_EVENT } from './financial-events';
import {
  confirmExpectedEventRequest,
  confirmScheduledCardPaymentRequest,
  receiveMoneyOwedRequest,
} from './notification-actions';
import {
  buildBalanceGlanceModel,
  buildUpcomingBillsModel,
  type CardBalanceGlance,
  type CashBalanceGlance,
} from './financial-hub-model';
import { FinancialGlyph } from './VisualSystem';
import { balanceBookDarkTheme, balanceBookLightTheme } from './theme';

const useStyles = makeStyles({
  anchor: {
    position: 'relative',
    display: 'inline-grid',
  },
  trigger: {
    width: '36px',
    minWidth: '36px',
    height: '36px',
    minHeight: '36px',
    boxSizing: 'border-box',
    padding: '0 !important',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    border: '1px solid var(--balance-glass-border)',
    fontVariantNumeric: 'tabular-nums',
    transitionProperty: 'transform, border-color, background-color, box-shadow',
    transitionDuration: tokens.durationNormal,
    '@media (max-width: 360px)': {
      width: '36px !important',
      minWidth: '36px !important',
    },
  },
  triggerAttention: {
    color: '#07111d',
    backgroundColor: '#ffd62e',
    border: '1px solid #ffe77d',
    boxShadow: '0 0 0 3px rgba(255, 214, 46, 0.1), 0 8px 18px rgba(0, 0, 0, 0.15)',
    '&:hover': {
      color: '#07111d',
      backgroundColor: '#ffe15c',
    },
  },
  triggerQuiet: {
    color: tokens.colorNeutralForeground2,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass) 78%, transparent)',
  },
  triggerCount: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightBold,
    lineHeight: 1,
  },
  triggerCloseGlyph: {
    fontSize: '20px',
    fontWeight: tokens.fontWeightRegular,
    lineHeight: 1,
    transform: 'translateY(-1px)',
  },
  portalProvider: {
    display: 'contents',
  },
  surface: {
    position: 'fixed',
    zIndex: 1000,
    top: '76px',
    right: '20px',
    width: 'min(680px, calc(100vw - 28px))',
    maxWidth: 'calc(100vw - 28px)',
    height: 'min(720px, calc(100vh - 92px))',
    padding: '0',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: '20px',
    border: '1px solid var(--balance-glass-border)',
    background:
      'radial-gradient(circle at 100% 0%, rgba(41, 151, 255, 0.12), transparent 34%), repeating-linear-gradient(118deg, transparent 0, transparent 18px, var(--balance-texture-line) 19px), var(--balance-glass-strong)',
    boxShadow: tokens.shadow64,
    backdropFilter: 'blur(28px) saturate(150%)',
    isolation: 'isolate',
    '@media (max-width: 640px)': {
      position: 'fixed !important' as never,
      top: 'auto !important',
      right: '8px !important',
      bottom: '8px !important',
      left: '8px !important',
      width: 'calc(100vw - 16px) !important',
      maxWidth: 'none',
      height: 'min(760px, calc(100vh - 16px)) !important',
      maxHeight: 'none',
      borderRadius: '24px 24px 18px 18px',
      transform: 'none !important',
    },
  },
  header: {
    minHeight: '76px',
    boxSizing: 'border-box',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    borderBottom: '1px solid var(--balance-glass-border)',
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-strong) 88%, transparent)',
  },
  headerCopy: { display: 'grid', gap: '1px', minWidth: 0 },
  headerTitle: {
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
    '& .fui-Button': { minHeight: '32px' },
  },
  modeSwitchWrap: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL} 0`,
  },
  modeSwitch: {
    position: 'relative',
    width: 'min(100%, 390px)',
    marginInline: 'auto',
    padding: '3px',
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    border: '1px solid var(--balance-glass-border)',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass) 72%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight)',
    '& .fui-Tab__content': { width: '100%' },
    '&::before': {
      content: '""',
      position: 'absolute',
      zIndex: 0,
      top: '3px',
      bottom: '3px',
      left: '3px',
      width: 'calc((100% - 6px) / 3)',
      borderRadius: tokens.borderRadiusCircular,
      backgroundImage: 'linear-gradient(135deg, #008fd4, #2474ee)',
      boxShadow: '0 6px 16px rgba(14, 112, 226, 0.22)',
      transitionProperty: 'transform',
      transitionDuration: '220ms',
      transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
    '&[data-active-index="1"]::before': { transform: 'translateX(100%)' },
    '&[data-active-index="2"]::before': { transform: 'translateX(200%)' },
    '@media (prefers-reduced-motion: reduce)': {
      '&::before': { transitionDuration: '0ms' },
    },
  },
  modeTab: {
    position: 'relative',
    zIndex: 1,
    minWidth: 0,
    minHeight: '34px',
    paddingInline: `${tokens.spacingHorizontalS} !important`,
    borderRadius: `${tokens.borderRadiusCircular} !important`,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    '&::after': { display: 'none' },
    '&[aria-selected="true"]': {
      color: tokens.colorNeutralForegroundOnBrand,
      backgroundColor: 'transparent',
    },
  },
  tabLabel: {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  modeCount: {
    minWidth: '20px',
    height: '20px',
    paddingInline: '5px',
    display: 'inline-grid',
    placeItems: 'center',
    color: '#082034',
    backgroundColor: '#d9f2ff',
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: 'tabular-nums',
  },
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: tokens.spacingHorizontalL,
    scrollbarGutter: 'stable',
  },
  list: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
  },
  section: { display: 'grid', gap: tokens.spacingVerticalM },
  sectionLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  item: {
    position: 'relative',
    display: 'grid',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalL} calc(${tokens.spacingHorizontalL} + 6px)`,
    border: '1px solid color-mix(in srgb, var(--balance-glass-border) 84%, #2997ff)',
    borderRadius: tokens.borderRadiusXLarge,
    background:
      'radial-gradient(circle at 100% 0%, rgba(41, 151, 255, 0.1), transparent 42%), color-mix(in srgb, var(--balance-glass) 84%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight), 0 12px 26px rgba(0, 0, 0, 0.12)',
  },
  unread: {
    '&::before': {
      content: '""',
      position: 'absolute',
      top: '14px',
      left: '10px',
      width: '8px',
      height: '8px',
      borderRadius: tokens.borderRadiusCircular,
      backgroundColor: tokens.colorBrandBackground,
      boxShadow: `0 0 0 3px ${tokens.colorNeutralBackground1}`,
    },
  },
  itemHeading: {
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) fit-content(42%)',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    '& strong': {
      minWidth: 0,
      overflowWrap: 'anywhere',
      fontSize: tokens.fontSizeBase300,
    },
    '@media (max-width: 440px)': {
      gridTemplateColumns: '1fr',
      alignItems: 'start',
    },
  },
  noticeSummary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    border: '1px solid color-mix(in srgb, var(--balance-glass-border) 80%, #2997ff)',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: 'color-mix(in srgb, #0877c9 12%, var(--balance-glass))',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight)',
    '@media (max-width: 440px)': {
      alignItems: 'flex-start',
      flexDirection: 'column',
      gap: tokens.spacingVerticalXS,
    },
  },
  subject: {
    minWidth: 0,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
    textAlign: 'right',
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
    '@media (max-width: 440px)': {
      maxWidth: '100%',
      textAlign: 'left',
    },
  },
  explanation: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
    overflowWrap: 'anywhere',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  form: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: '1px solid var(--balance-glass-border)',
    '& > *:last-child': { gridColumn: '1 / -1' },
    '@media (max-width: 440px)': { gridTemplateColumns: '1fr' },
  },
  empty: {
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  error: { color: tokens.colorPaletteRedForeground1, gridColumn: '1 / -1' },
  loading: {
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
  },
  summaryBand: {
    marginBottom: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
    border: '1px solid var(--balance-glass-border)',
    borderRadius: tokens.borderRadiusXLarge,
    background:
      'linear-gradient(135deg, color-mix(in srgb, #008fd4 16%, var(--balance-glass)), color-mix(in srgb, #6559ff 10%, var(--balance-glass)))',
    '@media (max-width: 440px)': { gridTemplateColumns: '1fr' },
  },
  summaryMetric: {
    minWidth: 0,
    display: 'grid',
    gap: '2px',
    '& strong': {
      fontSize: tokens.fontSizeBase500,
      fontVariantNumeric: 'tabular-nums',
    },
  },
  tileSection: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    '& + &': { marginTop: tokens.spacingVerticalL },
  },
  tileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalS,
    '@media (max-width: 700px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 440px)': { gridTemplateColumns: '1fr' },
  },
  financialTile: {
    minWidth: 0,
    minHeight: '132px',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: 'grid',
    alignContent: 'space-between',
    gap: tokens.spacingVerticalS,
    color: 'inherit',
    textAlign: 'left',
    border: '1px solid var(--balance-glass-border)',
    borderRadius: tokens.borderRadiusXLarge,
    background:
      'radial-gradient(circle at 100% 0%, rgba(47, 151, 255, 0.14), transparent 48%), color-mix(in srgb, var(--balance-glass) 82%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight), 0 10px 22px rgba(0, 0, 0, 0.1)',
    cursor: 'pointer',
    '&:hover': {
      border: `1px solid ${tokens.colorBrandStroke1}`,
      transform: 'translateY(-1px)',
    },
  },
  tileTop: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  tileIcon: {
    width: '32px',
    height: '32px',
    flex: '0 0 auto',
    display: 'grid',
    placeItems: 'center',
    color: '#78d7ff',
    border: '1px solid rgba(82, 196, 255, 0.26)',
    borderRadius: '11px',
    backgroundColor: 'rgba(18, 128, 170, 0.18)',
    '& svg': { width: '17px', height: '17px' },
  },
  tileTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tileValue: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: 'tabular-nums',
  },
  tileMeta: {
    display: 'grid',
    gap: '1px',
    color: tokens.colorNeutralForeground3,
  },
  tileStatus: {
    justifySelf: 'start',
    padding: '3px 8px',
    color: '#74e4d6',
    backgroundColor: 'rgba(27, 155, 138, 0.14)',
    border: '1px solid rgba(64, 205, 187, 0.26)',
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
  },
  tileStatusAttention: {
    color: '#ffd65c',
    backgroundColor: 'rgba(157, 120, 12, 0.14)',
    border: '1px solid rgba(255, 205, 62, 0.3)',
  },
  billsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalS,
    '@media (max-width: 600px)': { gridTemplateColumns: '1fr' },
  },
  billTile: {
    minWidth: 0,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: 'grid',
    gridTemplateColumns: '34px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    border: '1px solid var(--balance-glass-border)',
    borderRadius: tokens.borderRadiusXLarge,
    background:
      'radial-gradient(circle at 100% 0%, rgba(47, 151, 255, 0.1), transparent 46%), color-mix(in srgb, var(--balance-glass) 82%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight), 0 10px 22px rgba(0, 0, 0, 0.1)',
  },
  billCopy: {
    minWidth: 0,
    display: 'grid',
    gap: '2px',
  },
  billAmount: {
    textAlign: 'right',
    fontWeight: tokens.fontWeightBold,
    fontVariantNumeric: 'tabular-nums',
  },
  footerAction: {
    marginTop: tokens.spacingVerticalM,
    display: 'flex',
    justifyContent: 'flex-end',
  },
});

type ActionDraft = {
  notificationId: string;
  amount: string;
  date: string;
  destinationAccountId: string;
};

const amountInput = (amountCents?: number): string =>
  amountCents === undefined ? '' : (amountCents / 100).toFixed(2);

type FinancialCenterView = 'notices' | 'bills' | 'balances';
const financialCenterViews: FinancialCenterView[] = ['notices', 'bills', 'balances'];

const billTypeLabel = (kind: string): string =>
  (
    ({
      expense: 'Bill',
      'card-payment': 'Card payment',
      'loan-payment': 'Loan payment',
    }) as Record<string, string>
  )[kind] ?? 'Payment';

const freshnessLabel = (freshness: CashBalanceGlance['freshness']): string =>
  freshness === 'stale' ? 'Refresh' : freshness === 'aging' ? 'Aging' : 'Current';

export const NotificationCenter = ({
  refreshKey,
  darkMode = true,
}: {
  refreshKey: string;
  darkMode?: boolean;
}): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<FinancialCenterView>('notices');
  const [snapshot, setSnapshot] = useState<ForecastSnapshotDto | null>(null);
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const [presentations, setPresentations] = useState<NotificationPresentationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionDraft, setActionDraft] = useState<ActionDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusDto | null>(null);
  const actionLockRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewDirectionRef = useRef<1 | -1 | 0>(0);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    setLoadError(null);
    try {
      const [forecast, managed, presentation] = await Promise.all([
        window.balanceBook.getForecast(),
        window.balanceBook.listRecords(),
        window.balanceBook.listNotificationPresentations(),
      ]);
      if (generation !== loadGenerationRef.current) return;
      if (!forecast.ok) setLoadError(forecast.error);
      else if (!managed.ok) setLoadError(managed.error);
      else if (!presentation.ok) setLoadError(presentation.error);
      else {
        setSnapshot(forecast.value);
        setRecords(managed.value);
        setPresentations(presentation.value);
      }
    } catch (caught) {
      if (generation === loadGenerationRef.current) {
        setLoadError(caught instanceof Error ? caught.message : 'Financial state could not load.');
      }
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = Promise.resolve().then(load);
    void task;
  }, [load, refreshKey]);

  useEffect(() => {
    if (
      typeof window.balanceBook.getUpdateStatus !== 'function' ||
      typeof window.balanceBook.onUpdateStatus !== 'function'
    ) {
      return;
    }
    let active = true;
    const stopListening = window.balanceBook.onUpdateStatus((status) => {
      if (active) setUpdateStatus(status);
    });
    void window.balanceBook.getUpdateStatus().then((result) => {
      if (active && result.ok) setUpdateStatus(result.value);
    });
    return () => {
      active = false;
      stopListening();
    };
  }, []);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener(FINANCIAL_STATE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(FINANCIAL_STATE_CHANGED_EVENT, refresh);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !anchorRef.current?.contains(event.target) &&
        !surfaceRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    const body = bodyRef.current;
    const direction = viewDirectionRef.current;
    viewDirectionRef.current = 0;
    if (!body || direction === 0) return;
    body.scrollTop = 0;
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    body.animate?.(
      [
        { opacity: 0.35, transform: `translateX(${direction * 18}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [view]);

  const selectView = (nextView: FinancialCenterView): void => {
    if (nextView === view) return;
    viewDirectionRef.current =
      financialCenterViews.indexOf(nextView) > financialCenterViews.indexOf(view) ? 1 : -1;
    setView(nextView);
  };

  const notifications = useMemo(
    () =>
      snapshot?.startDate && records
        ? generateFinancialNotifications({
            snapshot,
            records,
            presentations,
            today: snapshot.startDate,
          })
        : [],
    [presentations, records, snapshot],
  );
  const updateNeedsAction = updateStatus?.state === 'ready';
  const unresolvedCount = unresolvedNotificationCount(notifications) + (updateNeedsAction ? 1 : 0);
  const unreadCount =
    notifications.filter((notification) => notification.unread).length +
    (updateNeedsAction ? 1 : 0);
  const upcomingBills = useMemo(
    () =>
      snapshot?.startDate
        ? buildUpcomingBillsModel(snapshot, snapshot.startDate)
        : { bills: [], totalCents: 0, horizonDays: 45 },
    [snapshot],
  );
  const balanceGlance = useMemo(
    () =>
      snapshot && records
        ? buildBalanceGlanceModel(snapshot, records)
        : {
            cash: [],
            cards: [],
            totalCashCents: 0,
            totalCardBalanceCents: 0,
          },
    [records, snapshot],
  );

  const markAllRead = async (): Promise<void> => {
    const unread = notifications.filter((notification) => notification.unread);
    if (unread.length > 0) {
      const readAt = new Date().toISOString();
      const response = await window.balanceBook.setNotificationPresentations({
        updates: unread.map((notification) => {
          const current = presentations.find(
            (presentation) => presentation.notificationId === notification.id,
          );
          return {
            notificationId: notification.id,
            conditionFingerprint: notification.fingerprint,
            readAt,
            snoozedUntil: current?.snoozedUntil ?? null,
            dismissedAt: current?.dismissedAt ?? null,
          };
        }),
      });
      if (response.ok) setPresentations(response.value);
      else setLoadError(response.error);
    }
    if (updateNeedsAction) {
      const response = await window.balanceBook.deferUpdate();
      if (response.ok) setUpdateStatus(response.value);
      else setLoadError(response.error);
    }
  };

  const beginAction = (notification: FinancialNotification): void => {
    if (notification.primaryAction === 'open') {
      if (notification.openPath) navigate(notification.openPath);
      setOpen(false);
      return;
    }
    setActionError(null);
    setActionDraft({
      notificationId: notification.id,
      amount: amountInput(notification.amountCents),
      date: notification.date ?? snapshot?.startDate ?? '',
      destinationAccountId: notification.fundingAccountId ?? records?.accounts[0]?.id ?? '',
    });
  };

  const saveAction = async (
    event: FormEvent<HTMLFormElement>,
    notification: FinancialNotification,
  ): Promise<void> => {
    event.preventDefault();
    if (!actionDraft || !records || busyId || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyId(notification.id);
    setActionError(null);
    try {
      const amountCents = dollarsToCents(actionDraft.amount);
      let response: Awaited<ReturnType<typeof window.balanceBook.upsertRecord>>;
      if (notification.primaryAction === 'confirm-account-balance') {
        const account = records.accounts.find((item) => item.id === notification.entityId);
        if (!account) throw new Error('Cash account is no longer available.');
        response = await window.balanceBook.upsertRecord(
          overviewBalanceUpdateRequest(account, amountCents, actionDraft.date),
        );
      } else if (notification.primaryAction === 'confirm-card-balance') {
        if (amountCents < 0) throw new Error('Card balance cannot be negative.');
        const card = records.cards.find((item) => item.id === notification.entityId);
        if (!card) throw new Error('Card is no longer available.');
        response = await window.balanceBook.upsertRecord(
          overviewCardBalanceUpdateRequest(card, amountCents, actionDraft.date),
        );
      } else if (notification.primaryAction === 'confirm-card-payment') {
        if (amountCents <= 0) throw new Error('Payment amount must be greater than zero.');
        const cycle = records.cardCycles.find((item) => item.id === notification.entityId);
        if (!cycle) throw new Error('Statement cycle is no longer available.');
        response = await window.balanceBook.upsertRecord(
          confirmScheduledCardPaymentRequest({
            cycle,
            amountCents,
            paymentDate: actionDraft.date,
            fundingAccountId: actionDraft.destinationAccountId,
          }),
        );
      } else if (notification.primaryAction === 'confirm-expected-event') {
        const expectedEvent = records.events.find((item) => item.id === notification.entityId);
        if (!expectedEvent) throw new Error('Expected event is no longer available.');
        if (amountCents !== expectedEvent.amountCents || actionDraft.date !== expectedEvent.date) {
          throw new Error(
            'Open the source record to change its amount or date before confirming it.',
          );
        }
        response = await window.balanceBook.upsertRecord(
          confirmExpectedEventRequest(expectedEvent),
        );
      } else {
        if (amountCents <= 0) throw new Error('Received amount must be greater than zero.');
        const settlement = await window.balanceBook.recordReceivableSettlement(
          receiveMoneyOwedRequest({
            receivableId: notification.entityId ?? '',
            amountCents,
            date: actionDraft.date,
            destinationAccountId: actionDraft.destinationAccountId,
          }),
        );
        if (!settlement.ok) {
          setActionError(settlement.error);
          return;
        }
        setRecords(settlement.value);
        announceCanonicalDataChanged();
        setActionDraft(null);
        return;
      }
      if (!response.ok) {
        setActionError(response.error);
        return;
      }
      setRecords(response.value);
      announceCanonicalDataChanged();
      setActionDraft(null);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'This action could not be saved.');
    } finally {
      actionLockRef.current = false;
      setBusyId(null);
    }
  };

  const renderNotification = (notification: FinancialNotification): React.JSX.Element => {
    const editing = actionDraft?.notificationId === notification.id;
    return (
      <article
        className={mergeClasses(styles.item, notification.unread && styles.unread)}
        key={notification.id}
        aria-label={`${notification.title}: ${notification.subject}`}
      >
        <div className={styles.itemHeading}>
          <strong>{notification.title}</strong>
          <Text size={200} className={styles.subject}>
            {notification.subject}
          </Text>
        </div>
        <Text size={200} className={styles.explanation}>
          {notification.explanation}
        </Text>
        {(notification.amountCents !== undefined || notification.date) && (
          <div className={styles.meta}>
            {notification.amountCents !== undefined && (
              <strong>{formatMoney(notification.amountCents)}</strong>
            )}
            {notification.date && <span>{formatPlainDate(notification.date)}</span>}
          </div>
        )}
        <div className={styles.actions}>
          <Button
            size="small"
            appearance="primary"
            onClick={() => beginAction(notification)}
            disabled={busyId !== null}
          >
            {notification.primaryActionLabel}
          </Button>
          {notification.primaryAction !== 'open' && notification.openPath && (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                navigate(notification.openPath!);
                setOpen(false);
              }}
            >
              Open
            </Button>
          )}
        </div>
        {editing && (
          <form className={styles.form} onSubmit={(event) => void saveAction(event, notification)}>
            <Field label="Exact amount">
              <Input
                value={actionDraft.amount}
                inputMode="decimal"
                required
                autoFocus
                onChange={(_, data) =>
                  setActionDraft((current) =>
                    current ? { ...current, amount: data.value } : current,
                  )
                }
              />
            </Field>
            <Field label="Exact date">
              <Input
                type="date"
                value={actionDraft.date}
                required
                onChange={(_, data) =>
                  setActionDraft((current) =>
                    current ? { ...current, date: data.value } : current,
                  )
                }
              />
            </Field>
            {(notification.primaryAction === 'confirm-card-payment' ||
              notification.primaryAction === 'receive-money-owed') && (
              <Field label="Cash account">
                <Select
                  value={actionDraft.destinationAccountId}
                  required
                  onChange={(_, data) =>
                    setActionDraft((current) =>
                      current ? { ...current, destinationAccountId: data.value } : current,
                    )
                  }
                >
                  {(records?.accounts ?? []).map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {actionError && (
              <Text className={styles.error} role="alert">
                {actionError}
              </Text>
            )}
            <div className={styles.actions}>
              <Button type="submit" appearance="primary" disabled={busyId !== null}>
                {busyId === notification.id ? 'Saving…' : 'Save exact update'}
              </Button>
              <Button
                type="button"
                appearance="subtle"
                onClick={() => {
                  setActionDraft(null);
                  setActionError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </article>
    );
  };

  const openFinancialPath = (path: string): void => {
    navigate(path);
    setOpen(false);
  };

  const renderCashBalance = (account: CashBalanceGlance): React.JSX.Element => {
    const belowFloor = account.balanceCents < account.hardFloorCents;
    const attention = belowFloor || account.freshness === 'stale';
    return (
      <button
        type="button"
        className={styles.financialTile}
        key={account.id}
        aria-label={`Open ${account.name} cash account`}
        onClick={() => openFinancialPath(account.openPath)}
      >
        <span className={styles.tileTop}>
          <span className={styles.tileIcon}>
            <FinancialGlyph name="cash" />
          </span>
          <strong className={styles.tileTitle}>{account.name}</strong>
        </span>
        <span className={styles.tileValue}>{formatMoney(account.balanceCents)}</span>
        <span className={styles.tileMeta}>
          <Text size={200}>
            Calculated through {formatPlainDate(account.calculatedThroughDate)}
          </Text>
          <Text size={200}>Minimum {formatMoney(account.hardFloorCents)}</Text>
        </span>
        <span className={mergeClasses(styles.tileStatus, attention && styles.tileStatusAttention)}>
          {belowFloor ? 'Below minimum' : freshnessLabel(account.freshness)}
        </span>
      </button>
    );
  };

  const renderCardBalance = (card: CardBalanceGlance): React.JSX.Element => {
    const attention = card.freshness === 'stale' || card.freshness === 'unavailable';
    return (
      <button
        type="button"
        className={styles.financialTile}
        key={card.id}
        aria-label={`Open ${card.name} credit card`}
        onClick={() => openFinancialPath(card.openPath)}
      >
        <span className={styles.tileTop}>
          <span className={styles.tileIcon}>
            <FinancialGlyph name="card" />
          </span>
          <strong className={styles.tileTitle}>{card.name}</strong>
        </span>
        <span className={styles.tileValue}>{formatMoney(card.balanceCents)}</span>
        <span className={styles.tileMeta}>
          <Text size={200}>Statement {formatMoney(card.latestStatementCents)}</Text>
          <Text size={200}>
            {card.nextDueOn ? `Due ${formatPlainDate(card.nextDueOn)}` : 'Due date not set'}
          </Text>
          {card.availableCreditCents !== undefined && (
            <Text size={200}>Available {formatMoney(card.availableCreditCents)}</Text>
          )}
        </span>
        <span className={mergeClasses(styles.tileStatus, attention && styles.tileStatusAttention)}>
          {card.freshness === 'unavailable' ? 'Balance needed' : freshnessLabel(card.freshness)}
        </span>
      </button>
    );
  };

  const needsAction = notifications.filter(
    (notification) => notification.section === 'needs-action',
  );
  const updates = notifications.filter((notification) => notification.section === 'updates');
  const balanceCount = balanceGlance.cash.length + balanceGlance.cards.length;
  const headerTitle =
    view === 'notices' ? 'Latest' : view === 'bills' ? 'Upcoming bills' : 'Current balances';
  const headerDetail =
    view === 'notices'
      ? `${unresolvedCount} to review · ${unreadCount} unread`
      : view === 'bills'
        ? `${upcomingBills.bills.length} payment${upcomingBills.bills.length === 1 ? '' : 's'} in the next ${upcomingBills.horizonDays} days`
        : `${balanceCount} account${balanceCount === 1 ? '' : 's'} · calculated through ${
            snapshot?.startDate ? formatPlainDate(snapshot.startDate) : 'today'
          }`;
  const hasNoticeItems = notifications.length > 0 || updateNeedsAction;

  return (
    <span className={styles.anchor} ref={anchorRef}>
      <Button
        className={mergeClasses(
          styles.trigger,
          unreadCount > 0 ? styles.triggerAttention : styles.triggerQuiet,
        )}
        appearance="subtle"
        shape="circular"
        aria-label={
          open
            ? 'Close notifications'
            : `Notifications, ${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
        }
        aria-expanded={open}
        aria-controls={open ? 'balance-book-financial-center' : undefined}
        data-unread-count={unreadCount}
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) void load();
        }}
      >
        {open ? (
          <span className={styles.triggerCloseGlyph} aria-hidden="true">
            ×
          </span>
        ) : (
          <span className={styles.triggerCount} aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {open &&
        createPortal(
          <FluentProvider
            className={styles.portalProvider}
            theme={darkMode ? balanceBookDarkTheme : balanceBookLightTheme}
            data-notification-theme={darkMode ? 'dark' : 'light'}
          >
            <div
              ref={surfaceRef}
              id="balance-book-financial-center"
              role="dialog"
              className={styles.surface}
              aria-label="Financial center"
            >
              <header className={styles.header}>
                <div className={styles.headerCopy}>
                  <Title2 className={styles.headerTitle} as="h2">
                    {headerTitle}
                  </Title2>
                  <Text size={200}>{headerDetail}</Text>
                </div>
                <div className={styles.headerActions}>
                  {view === 'notices' && (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => void markAllRead()}
                      disabled={unreadCount === 0}
                    >
                      Mark all read
                    </Button>
                  )}
                </div>
              </header>
              <div className={styles.modeSwitchWrap}>
                <TabList
                  className={styles.modeSwitch}
                  data-active-index={financialCenterViews.indexOf(view)}
                  selectedValue={view}
                  onTabSelect={(_, data) => selectView(data.value as FinancialCenterView)}
                  aria-label="Financial center sections"
                >
                  <Tab className={styles.modeTab} value="notices">
                    <span className={styles.tabLabel}>
                      Notices <span className={styles.modeCount}>{unresolvedCount}</span>
                    </span>
                  </Tab>
                  <Tab className={styles.modeTab} value="bills">
                    Bills
                  </Tab>
                  <Tab className={styles.modeTab} value="balances">
                    Balances
                  </Tab>
                </TabList>
              </div>
              <div
                ref={bodyRef}
                className={styles.body}
                role="tabpanel"
                aria-label={headerTitle}
                data-financial-center-view={view}
              >
                {loading && (
                  <div className={styles.loading} role="status">
                    <span className="balance-visually-hidden">Checking financial state…</span>
                    <span className="balance-skeleton__bar balance-skeleton__bar--body" />
                    <span className="balance-skeleton__bar balance-skeleton__bar--control" />
                    <span className="balance-skeleton__bar balance-skeleton__bar--control" />
                  </div>
                )}
                {loadError && (
                  <div className={styles.empty} role="alert">
                    {loadError}
                  </div>
                )}
                {!loading && !loadError && view === 'notices' && !hasNoticeItems && (
                  <div className={styles.empty}>Nothing requires attention right now.</div>
                )}
                {!loading && !loadError && view === 'notices' && hasNoticeItems && (
                  <div className={styles.list}>
                    <div className={styles.noticeSummary}>
                      <strong>
                        {unresolvedCount === 0
                          ? 'No action needed'
                          : `${unresolvedCount} item${unresolvedCount === 1 ? '' : 's'} to review`}
                      </strong>
                      <Text size={200}>
                        {updates.length} recent update{updates.length === 1 ? '' : 's'}
                      </Text>
                    </div>
                    {(needsAction.length > 0 || updateNeedsAction) && (
                      <section
                        className={styles.section}
                        aria-labelledby="notifications-needs-action"
                      >
                        <Text id="notifications-needs-action" className={styles.sectionLabel}>
                          Needs action
                        </Text>
                        {updateNeedsAction && updateStatus && (
                          <article
                            className={mergeClasses(styles.item, styles.unread)}
                            aria-label="Application update ready"
                          >
                            <div className={styles.itemHeading}>
                              <strong>Update ready</strong>
                              <Text size={200} className={styles.subject}>
                                {updateStatus.releaseName ?? 'Balance Book'}
                              </Text>
                            </div>
                            <Text size={200} className={styles.explanation}>
                              The verified update has downloaded. Save any open edits before
                              restarting.
                            </Text>
                            <div className={styles.actions}>
                              <Button
                                size="small"
                                appearance="primary"
                                onClick={() => {
                                  void window.balanceBook.restartForUpdate().then((response) => {
                                    if (response.ok) setUpdateStatus(response.value);
                                    else setLoadError(response.error);
                                  });
                                }}
                              >
                                Update and restart
                              </Button>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => {
                                  void window.balanceBook.deferUpdate().then((response) => {
                                    if (response.ok) setUpdateStatus(response.value);
                                    else setLoadError(response.error);
                                  });
                                }}
                              >
                                Restart later
                              </Button>
                            </div>
                          </article>
                        )}
                        {needsAction.map(renderNotification)}
                      </section>
                    )}
                    {updates.length > 0 && (
                      <section className={styles.section} aria-labelledby="notifications-updates">
                        <Text id="notifications-updates" className={styles.sectionLabel}>
                          Updates
                        </Text>
                        {updates.map(renderNotification)}
                      </section>
                    )}
                  </div>
                )}
                {!loading && !loadError && view === 'bills' && (
                  <>
                    <div className={styles.summaryBand}>
                      <span className={styles.summaryMetric}>
                        <Text size={200}>Due in {upcomingBills.horizonDays} days</Text>
                        <strong>{formatMoney(upcomingBills.totalCents)}</strong>
                      </span>
                      <span className={styles.summaryMetric}>
                        <Text size={200}>Scheduled payments</Text>
                        <strong>{upcomingBills.bills.length}</strong>
                      </span>
                    </div>
                    {upcomingBills.bills.length === 0 ? (
                      <div className={styles.empty}>No scheduled bills in this window.</div>
                    ) : (
                      <div className={styles.billsGrid}>
                        {upcomingBills.bills.map((bill) => (
                          <article className={styles.billTile} key={bill.id}>
                            <span className={styles.tileIcon}>
                              <FinancialGlyph name="bill" />
                            </span>
                            <span className={styles.billCopy}>
                              <strong>{bill.label}</strong>
                              <Text size={200}>
                                {formatPlainDate(bill.date)} · {bill.accountName}
                              </Text>
                              <Text size={100}>
                                {billTypeLabel(bill.kind)} · {bill.certainty}
                              </Text>
                            </span>
                            <span className={styles.billAmount}>
                              {formatMoney(bill.amountCents)}
                            </span>
                          </article>
                        ))}
                      </div>
                    )}
                    <div className={styles.footerAction}>
                      <Button appearance="subtle" onClick={() => openFinancialPath('/forecast')}>
                        Open cash forecast
                      </Button>
                    </div>
                  </>
                )}
                {!loading && !loadError && view === 'balances' && (
                  <>
                    <div className={styles.summaryBand}>
                      <span className={styles.summaryMetric}>
                        <Text size={200}>Cash accounts</Text>
                        <strong>{formatMoney(balanceGlance.totalCashCents)}</strong>
                      </span>
                      <span className={styles.summaryMetric}>
                        <Text size={200}>Current card balances</Text>
                        <strong>{formatMoney(balanceGlance.totalCardBalanceCents)}</strong>
                      </span>
                    </div>
                    {balanceCount === 0 ? (
                      <div className={styles.empty}>
                        Add an account to see current balances here.
                      </div>
                    ) : (
                      <>
                        {balanceGlance.cash.length > 0 && (
                          <section
                            className={styles.tileSection}
                            aria-labelledby="balance-glance-cash"
                          >
                            <Text id="balance-glance-cash" className={styles.sectionLabel}>
                              Cash
                            </Text>
                            <div className={styles.tileGrid}>
                              {balanceGlance.cash.map(renderCashBalance)}
                            </div>
                          </section>
                        )}
                        {balanceGlance.cards.length > 0 && (
                          <section
                            className={styles.tileSection}
                            aria-labelledby="balance-glance-cards"
                          >
                            <Text id="balance-glance-cards" className={styles.sectionLabel}>
                              Credit cards
                            </Text>
                            <div className={styles.tileGrid}>
                              {balanceGlance.cards.map(renderCardBalance)}
                            </div>
                          </section>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </FluentProvider>,
          document.body,
        )}
    </span>
  );
};
