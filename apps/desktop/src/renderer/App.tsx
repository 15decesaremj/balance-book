import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { Temporal } from '@js-temporal/polyfill';
import Decimal from 'decimal.js';
import {
  Button,
  Card,
  Checkbox,
  Field,
  FluentProvider,
  Input,
  Select,
  Subtitle1,
  Text,
  Title1,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { activeLoansForDate, hasRecurringReceivableSchedule } from '@balance-book/financial-engine';
import { defaultProfilePreferences, type ProfilePreferences } from '@balance-book/domain';
import type {
  ManagedRecordsDto,
  PostUpdateNoticeDto,
  ProfileSummaryDto,
  ScenarioResponseDto,
  SessionDto,
} from '../shared/contracts';
import { dollarsToCents, errorMessage, formatMoney } from './utils';
import {
  DataPage,
  BaselinePage,
  BillsPage,
  CardsPage,
  IncomePage,
  LoansPage,
  NetWorthPage,
  ReceivablesPage,
  ReconciliationPage,
  RecordsPage,
  RefinancePage,
} from './CorePages';
import { DashboardPage } from './DashboardPage';
import { ChartsPage } from './ChartsPage';
import {
  countLogicalSetupIncomingCash,
  countPotentialSetupDuplicateEvents,
} from './setup-checklist';
import { balanceBookDarkTheme, balanceBookLightTheme } from './theme';
import { LoadingSkeleton } from './LoadingSkeleton';
import { createImmediateActionLock } from './useEditorReveal';
import { NotificationCenter } from './NotificationCenter';
import {
  AmbientBackdrop,
  BalanceBookMark,
  NavigationIcon,
  type NavigationIconName,
} from './VisualSystem';
import {
  featureSettingsPath,
  financialFeatureLabels,
  isFinancialFeatureVisible,
  type FinancialFeature,
} from './feature-visibility';
import type { SettingsSection } from './settings-search';

const useStyles = makeStyles({
  authPage: {
    minHeight: '100vh',
    position: 'relative',
    isolation: 'isolate',
    display: 'grid',
    placeItems: 'center',
    padding: tokens.spacingHorizontalXXL,
    backgroundColor: tokens.colorNeutralBackground2,
    backgroundImage: `radial-gradient(circle at 20% 10%, ${tokens.colorBrandBackground2} 0, transparent 34%)`,
  },
  authPanel: {
    position: 'relative',
    zIndex: 1,
    width: 'min(100%, 560px)',
    padding: tokens.spacingHorizontalXXL,
    display: 'grid',
    gap: tokens.spacingVerticalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow8,
  },
  profileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  profileButton: {
    minHeight: '88px',
    justifyContent: 'flex-start',
    borderRadius: tokens.borderRadiusLarge,
  },
  form: {
    display: 'grid',
    gap: tokens.spacingVerticalL,
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
  },
  shell: {
    minHeight: '100vh',
    minWidth: 0,
    position: 'relative',
    isolation: 'isolate',
    display: 'grid',
    gridTemplateColumns: '256px minmax(0, 1fr)',
    gridTemplateRows: 'auto 1fr',
    backgroundColor: 'transparent',
    '@media (max-width: 1120px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'auto auto 1fr',
    },
  },
  shellCollapsed: {
    gridTemplateColumns: '82px minmax(0, 1fr)',
    '@media (max-width: 1120px)': {
      gridTemplateColumns: '1fr',
    },
  },
  menuRevealEdge: {
    position: 'fixed',
    zIndex: 2_147_483_647,
    top: 0,
    right: 0,
    left: 0,
    height: '6px',
    backgroundColor: 'transparent',
  },
  skipLink: {
    position: 'fixed',
    zIndex: 1000,
    top: tokens.spacingVerticalM,
    left: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow8,
    opacity: 0,
    pointerEvents: 'none',
    transform: 'translateY(calc(-100% - 24px))',
    transitionProperty: 'transform, opacity',
    transitionDuration: tokens.durationNormal,
    '&:focus': { opacity: 1, pointerEvents: 'auto', transform: 'translateY(0)' },
  },
  header: {
    position: 'relative',
    zIndex: 2,
    gridColumn: '2',
    gridRow: '1',
    minHeight: '72px',
    minWidth: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    borderBottom: '1px solid var(--balance-glass-border)',
    backgroundColor: 'color-mix(in srgb, var(--balance-glass) 82%, transparent)',
    backdropFilter: 'blur(26px) saturate(150%)',
    boxShadow: 'inset 0 -1px 0 var(--balance-glass-highlight)',
    '@media (max-width: 1120px)': {
      gridColumn: '1',
      gridRow: '2',
      alignItems: 'stretch',
      flexDirection: 'column',
      paddingBlock: tokens.spacingVerticalM,
      gap: tokens.spacingVerticalS,
    },
  },
  brand: { display: 'grid', gap: '1px', minWidth: 0, overflowWrap: 'anywhere' },
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    marginLeft: 'auto',
    '& > *': { minWidth: 0 },
    '@media (max-width: 1120px)': {
      width: '100%',
      justifyContent: 'flex-end',
      marginLeft: 0,
    },
    '@media (max-width: 360px)': {
      '& button': { width: '100%' },
    },
  },
  logoutButton: {
    height: '36px',
    minHeight: '36px',
  },
  authHeading: { display: 'grid', gap: tokens.spacingVerticalXS },
  sidebar: {
    gridColumn: '1',
    gridRow: '1 / 3',
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
    height: '100vh',
    position: 'sticky',
    zIndex: 2,
    top: 0,
    padding: '18px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    borderRight: '1px solid var(--balance-glass-border)',
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-strong) 78%, transparent)',
    backdropFilter: 'blur(32px) saturate(155%)',
    boxShadow: 'inset -1px 0 0 var(--balance-glass-highlight), var(--balance-glass-shadow)',
    '@media (max-width: 1120px)': {
      gridColumn: '1',
      gridRow: '1',
      width: '100%',
      height: 'auto',
      position: 'static',
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
      flexDirection: 'row',
      alignItems: 'center',
      gap: tokens.spacingHorizontalL,
      borderRight: 'none',
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      overflow: 'visible',
    },
    '@media (max-width: 520px)': {
      alignItems: 'stretch',
      flexDirection: 'column',
    },
  },
  sidebarCollapsed: {
    alignItems: 'stretch',
    '@media (max-width: 1120px)': {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
      alignItems: 'center',
    },
    '@media (max-width: 520px)': {
      alignItems: 'stretch',
    },
  },
  sidebarBrand: {
    width: '100%',
    minHeight: 'auto',
    boxSizing: 'border-box',
    display: 'grid',
    gridTemplateColumns: '40px minmax(0, 1fr)',
    alignItems: 'start',
    justifyContent: 'stretch',
    justifyItems: 'stretch',
    gap: tokens.spacingHorizontalM,
    padding: `14px 10px 16px`,
    color: 'inherit',
    border: 0,
    borderBottom: '1px solid color-mix(in srgb, var(--balance-glass-border) 74%, transparent)',
    borderRadius: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationNormal,
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 30%, transparent)',
    },
    '& strong': {
      fontSize: tokens.fontSizeBase600,
      letterSpacing: '-0.025em',
    },
    '@media (max-width: 1120px)': {
      minWidth: 'auto',
      padding: 0,
      borderBottom: 0,
    },
  },
  sidebarBrandCopy: {
    minWidth: 0,
    display: 'grid',
    gap: '1px',
  },
  sidebarBrandMark: {
    width: '40px',
    minWidth: '40px',
    display: 'grid',
    placeItems: 'center',
  },
  sidebarBrandCollapsed: {
    gridTemplateColumns: '40px',
    minWidth: '0 !important',
    maxWidth: '100%',
    padding: `14px 10px 16px`,
    justifyItems: 'stretch',
    '@media (max-width: 1120px)': {
      gridTemplateColumns: '40px minmax(0, 1fr)',
      padding: 0,
      justifyItems: 'stretch',
    },
  },
  sidebarBrandCopyCollapsed: {
    display: 'none',
    '@media (max-width: 1120px)': {
      display: 'grid',
    },
  },
  sidebarTagline: {
    '@media (max-width: 1120px)': { display: 'none' },
  },
  authBrand: {
    display: 'grid',
    gridTemplateColumns: '48px minmax(0, 1fr)',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  nav: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
    alignItems: 'stretch',
    paddingTop: tokens.spacingVerticalL,
    '& button': { justifyContent: 'flex-start' },
    '@media (max-width: 1120px)': {
      display: 'none',
    },
  },
  navCollapsed: {
    '& button': {
      width: '100%',
      minWidth: 0,
      maxWidth: '100%',
      justifyContent: 'center',
      paddingInline: 0,
    },
  },
  mobileNav: {
    display: 'none',
    minWidth: '190px',
    '@media (max-width: 1120px)': { display: 'block', marginLeft: 'auto' },
    '@media (max-width: 520px)': { width: '100%', marginLeft: 0 },
  },
  navGroup: {
    display: 'grid',
    gap: '3px',
    '@media (max-width: 1120px)': { display: 'flex' },
  },
  navLabel: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    '@media (max-width: 1120px)': { display: 'none' },
  },
  navButton: {
    minHeight: '42px',
    color: 'var(--balance-nav-foreground)',
    borderRadius: tokens.borderRadiusCircular,
    paddingInline: tokens.spacingHorizontalM,
    transitionProperty: 'transform, box-shadow',
    transitionDuration: tokens.durationNormal,
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 54%, transparent)',
    },
    '&[aria-current="page"]': {
      color: 'var(--balance-nav-active-foreground)',
      backgroundColor: 'var(--balance-nav-active-background)',
      backgroundImage: 'var(--balance-nav-active-gradient)',
      fontWeight: tokens.fontWeightSemibold,
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 10px 24px rgba(25, 87, 199, 0.22)',
    },
  },
  navIcon: {
    width: '24px',
    height: '24px',
    display: 'inline-grid',
    placeItems: 'center',
    marginRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusCircular,
    color: 'inherit',
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-highlight) 54%, transparent)',
    '& svg': { width: '17px', height: '17px' },
  },
  navIconCollapsed: {
    marginRight: 0,
  },
  sidebarCollapseControl: {
    display: 'flex',
    justifyContent: 'flex-start',
    padding: `0 12px 14px`,
    borderBottom: '1px solid color-mix(in srgb, var(--balance-glass-border) 74%, transparent)',
    '@media (max-width: 1120px)': {
      display: 'none',
    },
  },
  sidebarCollapseControlCollapsed: {
    justifyContent: 'flex-start',
  },
  sidebarCollapseButton: {
    width: '36px',
    minWidth: '36px',
    height: '36px',
    minHeight: '36px',
    boxSizing: 'border-box',
    padding: '0 !important',
    display: 'grid',
    placeItems: 'center',
    border: '1px solid var(--balance-glass-border)',
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForeground2,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass) 78%, transparent)',
    boxShadow: 'inset 0 1px 0 var(--balance-glass-highlight)',
    fontSize: '20px',
    lineHeight: 1,
    transitionProperty: 'transform, border-color, background-color, box-shadow',
    transitionDuration: tokens.durationNormal,
    '& svg': {
      width: '20px',
      height: '20px',
    },
  },
  sidebarFooter: {
    marginTop: 'auto',
    padding: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
    '@media (max-width: 1120px)': { display: 'none' },
  },
  content: {
    gridColumn: '2',
    gridRow: '2',
    width: 'min(1480px, calc(100% - 64px))',
    minWidth: 0,
    margin: '0 auto',
    padding: `40px 0 72px`,
    position: 'relative',
    zIndex: 1,
    '@media (max-width: 1120px)': {
      gridColumn: '1',
      gridRow: '3',
      width: 'min(100% - 28px, 1500px)',
    },
  },
  secondaryNav: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXL,
    padding: tokens.spacingHorizontalXS,
    '& button': { minHeight: '34px', paddingInline: tokens.spacingHorizontalM },
  },
  postUpdateNotice: {
    marginBottom: tokens.spacingVerticalXL,
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalS,
    boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke1}`,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass-strong) 88%, transparent)',
  },
  hubGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  hubCard: {
    minHeight: '168px',
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    alignContent: 'space-between',
    gap: tokens.spacingVerticalM,
  },
  hubCopy: {
    display: 'grid',
    alignContent: 'start',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    '& > *': {
      display: 'block',
      minWidth: 0,
      margin: 0,
      overflowWrap: 'anywhere',
    },
  },
  hubAction: { justifySelf: 'start' },
  pageHeader: {
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXL,
  },
  eyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalXL,
  },
  metric: {
    padding: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalS,
    borderTop: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
  },
  metricValue: {
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  setupRecommended: {
    padding: tokens.spacingHorizontalXL,
    marginBottom: tokens.spacingVerticalXL,
    display: 'grid',
    gap: tokens.spacingVerticalM,
    borderLeft: `5px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  setupGroup: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalXL,
  },
  setupGroupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalL,
    minWidth: 0,
    '& > div': {
      minWidth: 0,
      display: 'grid',
      gap: tokens.spacingVerticalXS,
    },
    '& h2, & p, & span': {
      margin: 0,
      overflowWrap: 'anywhere',
    },
    '& > span': {
      flexShrink: 0,
      paddingBottom: '2px',
    },
    '@media (max-width: 640px)': { alignItems: 'stretch', flexDirection: 'column' },
  },
  setupGroupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  setupTopic: {
    minWidth: 0,
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gridTemplateColumns: '36px minmax(0, 1fr)',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    alignContent: 'start',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    '& h3': { fontSize: tokens.fontSizeBase400, lineHeight: tokens.lineHeightBase400 },
    '& > div:last-child': { gridColumn: '2' },
  },
  setupTopicStatus: {
    width: '30px',
    height: '30px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    boxShadow: `0 7px 18px ${tokens.colorBrandBackground2}`,
    fontWeight: tokens.fontWeightBold,
  },
  setupTopicStatusOpen: {
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke2}`,
  },
  setupTopicBody: {
    minWidth: 0,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
  },
  applicabilityGrid: {
    display: 'grid',
    gap: tokens.spacingVerticalS,
  },
  applicabilityRow: {
    minWidth: 0,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: 'color-mix(in srgb, var(--balance-glass) 78%, transparent)',
    '& > div:first-child': {
      minWidth: 0,
      display: 'grid',
      gap: tokens.spacingVerticalXXS,
    },
    '@media (max-width: 520px)': {
      gridTemplateColumns: '1fr',
      alignItems: 'stretch',
    },
  },
  applicabilityChoices: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(74px, 1fr))',
    gap: tokens.spacingHorizontalXS,
  },
  applicabilityChoiceSelected: {
    color: `${tokens.colorNeutralForegroundOnBrand} !important`,
    backgroundColor: `${tokens.colorBrandBackground} !important`,
    boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke1}`,
  },
  setupCollapsible: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    marginBottom: tokens.spacingVerticalXL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    '& summary': { fontWeight: tokens.fontWeightSemibold },
  },
  setupCollapsibleBody: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
  },
  panel: {
    padding: tokens.spacingHorizontalXL,
    marginBottom: tokens.spacingVerticalXL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  positive: { color: tokens.colorPaletteGreenForeground1 },
  tableWrap: { overflowX: 'auto' },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    '& th, & td': {
      padding: tokens.spacingHorizontalS,
      borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
      textAlign: 'left',
    },
  },
  setupProgress: {
    display: 'grid',
    gap: tokens.spacingHorizontalXS,
    marginBlock: tokens.spacingVerticalS,
  },
  setupProgressStep: {
    height: '6px',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  setupProgressStepComplete: { backgroundColor: tokens.colorBrandBackground },
  setupStepMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
  },
  setupPromise: {
    padding: tokens.spacingHorizontalL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2,
  },
});

const passwordSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter a profile name').max(120),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, 'Enter a username')
      .max(128)
      .regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, periods, underscores, or hyphens'),
    password: z.string().min(12, 'Use at least 12 characters').max(128),
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
type PasswordValues = z.infer<typeof passwordSchema>;

const loginSchema = z.object({ password: z.string().min(1, 'Enter your password') });
type LoginValues = z.infer<typeof loginSchema>;

const signedMoneyText = z
  .string()
  .trim()
  .min(1, 'Enter an amount')
  .refine((value) => {
    try {
      return new Decimal(value.replaceAll(',', '')).isFinite();
    } catch {
      return false;
    }
  }, 'Enter a valid amount');
const moneyText = signedMoneyText.refine((value) => {
  try {
    return dollarsToCents(value) >= 0;
  } catch {
    return false;
  }
}, 'Amount cannot be negative');

const optionalMoneyText = z.union([z.literal(''), moneyText]);
const optionalDateText = z.union([
  z.literal(''),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date'),
]);
const optionalDayText = z.union([
  z.literal(''),
  z
    .string()
    .regex(/^\d{1,2}$/, 'Enter a day from 1 to 31')
    .refine((value) => Number(value) >= 1 && Number(value) <= 31, 'Enter a day from 1 to 31'),
]);
const optionalCardEstimatePolicy = z.union([
  z.literal(''),
  z.enum(['actual-reset', 'baseline-guardrail']),
]);
const optionalCardPaymentPolicy = z.union([
  z.literal(''),
  z.enum(['full-statement', 'minimum', 'fixed', 'manual']),
]);
const applicabilityAnswerSchema = z.enum(['', 'yes', 'no']);
const localDataConsentSchema = z.enum(['', 'accepted']);
const setupBaseSchema = z.object({
  localDataConsent: localDataConsentSchema,
  usesIncome: applicabilityAnswerSchema,
  usesBills: applicabilityAnswerSchema,
  usesCreditCards: applicabilityAnswerSchema,
  usesLoans: applicabilityAnswerSchema,
  usesMoneyOwed: applicabilityAnswerSchema,
  usesAssets: applicabilityAnswerSchema,
  balanceAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date'),
  accountName: z.string().trim().min(1, 'Enter an account name'),
  openingBalance: signedMoneyText,
  incomeLabel: z.string().trim().max(240),
  incomeDate: optionalDateText,
  incomeAmount: optionalMoneyText,
  commitmentLabel: z.string().trim().max(240),
  commitmentDate: optionalDateText,
  commitmentAmount: optionalMoneyText,
  cardName: z.string().trim().max(120),
  cardEstimate: optionalMoneyText,
  cardPaymentDay: optionalDayText,
  cardStatementCloseDay: optionalDayText,
  cardEstimatePolicy: optionalCardEstimatePolicy,
  cardPaymentPolicy: optionalCardPaymentPolicy,
  cardMinimumPayment: optionalMoneyText,
  cardFixedPayment: optionalMoneyText,
  hardFloor: moneyText,
  preferredFloor: optionalMoneyText,
});

const addOptionalGroupIssue = (
  values: readonly string[],
  label: string,
  path: string,
  context: z.RefinementCtx,
): void => {
  const present = values.map((value) => value !== '');
  if (present.some(Boolean) && !present.every(Boolean)) {
    context.addIssue({
      code: 'custom',
      path: [path],
      message: `Complete every ${label} field or leave this optional step blank`,
    });
  }
};

const addOptionalCardIssue = (
  values: Pick<
    SetupValues,
    | 'cardName'
    | 'cardEstimate'
    | 'cardPaymentDay'
    | 'cardStatementCloseDay'
    | 'cardEstimatePolicy'
    | 'cardPaymentPolicy'
    | 'cardMinimumPayment'
    | 'cardFixedPayment'
  >,
  context: z.RefinementCtx,
): void => {
  const coreValues = [
    values.cardName,
    values.cardEstimate,
    values.cardEstimatePolicy,
    values.cardPaymentPolicy,
  ];
  const timingValues = [values.cardPaymentDay, values.cardStatementCloseDay];
  const policyAmountValues = [values.cardMinimumPayment, values.cardFixedPayment];
  if ([...coreValues, ...timingValues, ...policyAmountValues].every((value) => value === ''))
    return;
  if (coreValues.some((value) => value === '')) {
    context.addIssue({
      code: 'custom',
      path: ['cardName'],
      message: 'Enter the card name, typical statement, estimate policy, and payment policy',
    });
    return;
  }
  if (values.cardPaymentPolicy === 'manual') {
    if (timingValues.some((value) => value !== '') && timingValues.some((value) => value === '')) {
      context.addIssue({
        code: 'custom',
        path: ['cardStatementCloseDay'],
        message: 'Enter both source timing days or leave both blank for a manual card',
      });
    }
    return;
  }
  if (
    values.cardPaymentPolicy === 'minimum' &&
    (values.cardMinimumPayment === '' || dollarsToCents(values.cardMinimumPayment) <= 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cardMinimumPayment'],
      message: 'Enter a minimum payment amount greater than zero',
    });
  }
  if (
    values.cardPaymentPolicy === 'fixed' &&
    (values.cardFixedPayment === '' || dollarsToCents(values.cardFixedPayment) <= 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['cardFixedPayment'],
      message: 'Enter a fixed payment amount greater than zero',
    });
  }
  if (timingValues.some((value) => value === '')) {
    context.addIssue({
      code: 'custom',
      path: ['cardStatementCloseDay'],
      message: 'Automatic payment guidance needs both the statement-close and payment days',
    });
  }
};

const addFloorIssue = (
  values: { hardFloor: string; preferredFloor: string },
  context: z.RefinementCtx,
): void => {
  if (
    values.preferredFloor !== '' &&
    dollarsToCents(values.preferredFloor) < dollarsToCents(values.hardFloor)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['preferredFloor'],
      message: 'Preferred buffer must not be below the global protected minimum',
    });
  }
};

const setupSchema = setupBaseSchema.superRefine((values, context) => {
  if (values.localDataConsent !== 'accepted') {
    context.addIssue({
      code: 'custom',
      path: ['localDataConsent'],
      message: 'Confirm how Balance Book stores the information you enter',
    });
  }
  for (const field of [
    'usesIncome',
    'usesBills',
    'usesCreditCards',
    'usesLoans',
    'usesMoneyOwed',
    'usesAssets',
  ] as const) {
    if (values[field] === '') {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Choose Yes or No',
      });
    }
  }
  const groups = [
    {
      path: 'incomeLabel',
      label: 'deposit',
      values: [values.incomeLabel, values.incomeDate, values.incomeAmount],
    },
    {
      path: 'commitmentLabel',
      label: 'bill',
      values: [values.commitmentLabel, values.commitmentDate, values.commitmentAmount],
    },
  ] as const;
  for (const group of groups) {
    if (group.path === 'incomeLabel' && values.usesIncome !== 'yes') continue;
    if (group.path === 'commitmentLabel' && values.usesBills !== 'yes') continue;
    addOptionalGroupIssue(group.values, group.label, group.path, context);
  }
  if (values.usesCreditCards === 'yes') addOptionalCardIssue(values, context);
  addFloorIssue(values, context);
});
type SetupValues = z.infer<typeof setupSchema>;

type SetupStepId = 'welcome' | 'fit' | 'cash' | 'income' | 'bill' | 'cards' | 'minimums' | 'review';

const setupStepDefinitions: Record<SetupStepId, { name: string; promise: string }> = {
  welcome: {
    name: 'Welcome',
    promise: 'A private forecast you can understand and edit.',
  },
  fit: {
    name: 'Make it yours',
    promise: 'A workspace that shows only the money tools you use.',
  },
  cash: {
    name: 'Cash',
    promise: 'A trustworthy starting balance for daily projections.',
  },
  income: {
    name: 'Deposit',
    promise: 'One upcoming deposit timed to the account where it actually arrives.',
  },
  bill: {
    name: 'Bill',
    promise: 'One upcoming bill included before anything is called safe to spend.',
  },
  cards: {
    name: 'Cards',
    promise: 'Card purchases mapped to their real future cash-payment dates.',
  },
  minimums: {
    name: 'Minimums',
    promise:
      'A global protected minimum and preferred buffer that every safe-spend answer can explain.',
  },
  review: {
    name: 'Review',
    promise: 'A first forecast you can verify before using it day to day.',
  },
};

export const activeSetupStepIds = (values: Partial<SetupValues>): SetupStepId[] => [
  'welcome',
  'fit',
  'cash',
  ...(values.usesIncome === 'yes' ? (['income'] as const) : []),
  ...(values.usesBills === 'yes' ? (['bill'] as const) : []),
  ...(values.usesCreditCards === 'yes' ? (['cards'] as const) : []),
  'minimums',
  'review',
];

const setupStepSchemas: Record<SetupStepId, z.ZodTypeAny> = {
  welcome: z.object({
    localDataConsent: z.literal('accepted', {
      message: 'Confirm how Balance Book stores the information you enter',
    }),
  }),
  fit: z.object({
    usesIncome: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
    usesBills: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
    usesCreditCards: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
    usesLoans: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
    usesMoneyOwed: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
    usesAssets: z.enum(['yes', 'no'], { message: 'Choose Yes or No' }),
  }),
  cash: setupBaseSchema.pick({ balanceAsOf: true, accountName: true, openingBalance: true }),
  income: setupBaseSchema
    .pick({ incomeLabel: true, incomeDate: true, incomeAmount: true })
    .superRefine((values, context) =>
      addOptionalGroupIssue(
        [values.incomeLabel, values.incomeDate, values.incomeAmount],
        'deposit',
        'incomeLabel',
        context,
      ),
    ),
  bill: setupBaseSchema
    .pick({ commitmentLabel: true, commitmentDate: true, commitmentAmount: true })
    .superRefine((values, context) =>
      addOptionalGroupIssue(
        [values.commitmentLabel, values.commitmentDate, values.commitmentAmount],
        'bill',
        'commitmentLabel',
        context,
      ),
    ),
  cards: setupBaseSchema
    .pick({
      cardName: true,
      cardEstimate: true,
      cardPaymentDay: true,
      cardStatementCloseDay: true,
      cardEstimatePolicy: true,
      cardPaymentPolicy: true,
      cardMinimumPayment: true,
      cardFixedPayment: true,
    })
    .superRefine(addOptionalCardIssue),
  minimums: setupBaseSchema
    .pick({ hardFloor: true, preferredFloor: true })
    .superRefine(addFloorIssue),
  review: z.object({}),
};

const scenarioSchema = z.object({
  description: z.string().trim().min(1, 'Describe the purchase'),
  amount: moneyText.refine(
    (value) => dollarsToCents(value) > 0,
    'Amount must be greater than zero',
  ),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date'),
});
type ScenarioValues = z.infer<typeof scenarioSchema>;

export type SetupReviewStatus = 'reviewed' | 'not-applicable';

export const updateSetupReviewSections = (
  current: Readonly<Record<string, SetupReviewStatus>>,
  topicId: string,
  status?: SetupReviewStatus,
): Record<string, SetupReviewStatus> => {
  const next = { ...current };
  if (status === undefined) delete next[topicId];
  else next[topicId] = status;
  return next;
};

export const setupDraftPayloadValues = (
  values: Partial<SetupValues>,
  reviewSections: Readonly<Record<string, SetupReviewStatus>>,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ),
  ...Object.fromEntries(
    Object.entries(reviewSections).map(([section, status]) => [`review_${section}`, status]),
  ),
});

export type ScenarioFundingSelection = {
  fundingType: 'cash' | 'card';
  accountId: string;
  cardId: string;
};

export const scenarioEvaluationKey = (
  values: Partial<ScenarioValues>,
  selection: ScenarioFundingSelection,
): string =>
  JSON.stringify([
    values.description?.trim() ?? '',
    values.amount?.trim() ?? '',
    values.settlementDate?.trim() ?? '',
    selection.fundingType,
    selection.fundingType === 'cash' ? selection.accountId : selection.cardId,
  ]);

const useSystemDark = (): boolean => {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return dark;
};

const ProfileAccess = ({
  profiles,
  onSession,
}: {
  profiles: ProfileSummaryDto[];
  onSession: (session: SessionDto) => void;
}): React.JSX.Element => {
  const styles = useStyles();
  const [selected, setSelected] = useState<ProfileSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordForm = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema) });
  const loginForm = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  const createPassword = passwordForm.handleSubmit(async (values) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.balanceBook.createPassword({
        profileId: selected.id,
        displayName: values.displayName,
        username: values.username,
        password: values.password,
      });
      if (!result.ok) setError(result.error);
      else onSession(result.value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  });

  const login = loginForm.handleSubmit(async (values) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.balanceBook.login({
        username: selected.username,
        password: values.password,
      });
      if (!result.ok) setError(result.error);
      else onSession(result.value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className={styles.authPage}>
      <AmbientBackdrop />
      <Card className={styles.authPanel}>
        <div className={styles.authBrand}>
          <BalanceBookMark />
          <div className={styles.brand}>
            <Title1>Balance Book</Title1>
            <Subtitle1>Private financial operations on this computer</Subtitle1>
          </div>
        </div>
        {!selected ? (
          <>
            <Title2 as="h1">Choose a profile</Title2>
            <Text>Balances are hidden until you sign in.</Text>
            <div className={styles.profileGrid}>
              {profiles.map((profile) => (
                <Button
                  className={styles.profileButton}
                  appearance="outline"
                  key={profile.id}
                  onClick={() => setSelected(profile)}
                >
                  {profile.displayName}
                </Button>
              ))}
            </div>
          </>
        ) : !selected.passwordSet ? (
          <form className={styles.form} onSubmit={createPassword} noValidate>
            <div className={styles.authHeading}>
              <Title2 as="h1">Protect {selected.displayName}</Title2>
              <Text>
                Create a local password. It cannot be recovered automatically. Moving from another
                computer? After this step, choose Restore an encrypted backup and use that file's
                separate backup password.
              </Text>
            </div>
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            <Field
              label="Profile name"
              validationMessage={passwordForm.formState.errors.displayName?.message}
            >
              <Input
                defaultValue={selected.displayName}
                {...passwordForm.register('displayName')}
              />
            </Field>
            <Field
              label="Username"
              validationMessage={passwordForm.formState.errors.username?.message}
            >
              <Input
                defaultValue={selected.username}
                autoComplete="username"
                {...passwordForm.register('username')}
              />
            </Field>
            <Field
              label="Password"
              validationMessage={passwordForm.formState.errors.password?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                {...passwordForm.register('password')}
              />
            </Field>
            <Field
              label="Confirm password"
              validationMessage={passwordForm.formState.errors.confirmPassword?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                {...passwordForm.register('confirmPassword')}
              />
            </Field>
            <div className={styles.actions}>
              <Button type="submit" appearance="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create password'}
              </Button>
              <Button type="button" onClick={() => setSelected(null)}>
                Back
              </Button>
            </div>
          </form>
        ) : (
          <form className={styles.form} onSubmit={login} noValidate>
            <div className={styles.authHeading}>
              <Title2 as="h1">Sign in to {selected.displayName}</Title2>
              <Text>Username: {selected.username}</Text>
            </div>
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            <Field
              label="Password"
              validationMessage={loginForm.formState.errors.password?.message}
            >
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                {...loginForm.register('password')}
              />
            </Field>
            <div className={styles.actions}>
              <Button type="submit" appearance="primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <Button type="button" onClick={() => setSelected(null)}>
                Back
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
};

export const primaryPathForLocation = (path: string): string => {
  if (['/forecast', '/income', '/baseline'].includes(path)) return '/forecast';
  if (['/accounts', '/bills', '/cards', '/loans', '/receivables', '/net-worth'].includes(path)) {
    return '/accounts';
  }
  if (['/planning', '/scenario', '/refinance', '/charts'].includes(path)) return '/planning';
  if (['/settings', '/data', '/reconcile', '/setup', '/records'].includes(path)) return '/settings';
  return '/';
};

export const secondaryDestinationsFor = (
  path: string,
  preferences: ProfilePreferences = defaultProfilePreferences,
) => {
  const primary = primaryPathForLocation(path);
  if (primary === '/forecast') {
    return [
      ['Cash forecast', '/forecast'],
      ...(isFinancialFeatureVisible(preferences, 'income')
        ? ([['Income and raises', '/income']] as const)
        : []),
      ['Recurring plan', '/baseline'],
    ] as const;
  }
  if (primary === '/accounts') {
    return [
      ['Accounts home', '/accounts'],
      ...(isFinancialFeatureVisible(preferences, 'bills')
        ? ([['Bills & subscriptions', '/bills']] as const)
        : []),
      ...(isFinancialFeatureVisible(preferences, 'credit-cards')
        ? ([['Credit cards', '/cards']] as const)
        : []),
      ...(isFinancialFeatureVisible(preferences, 'loans') ? ([['Loans', '/loans']] as const) : []),
      ...(isFinancialFeatureVisible(preferences, 'money-owed')
        ? ([['Money owed', '/receivables']] as const)
        : []),
      ...(isFinancialFeatureVisible(preferences, 'assets')
        ? ([['Assets and net worth', '/net-worth']] as const)
        : []),
    ] as const;
  }
  if (primary === '/planning') {
    return [
      ['Planning home', '/planning'],
      ['Scenarios', '/scenario'],
      ...(isFinancialFeatureVisible(preferences, 'loans')
        ? ([['Refinance', '/refinance']] as const)
        : []),
      ['Trends', '/charts'],
    ] as const;
  }
  if (primary === '/settings') {
    return [
      ['Settings', '/settings'],
      ['Financial check-in', '/reconcile'],
      ['Setup status', '/setup'],
      ['Advanced records', '/records'],
    ] as const;
  }
  return [] as const;
};

export const settingsSectionForLocation = (path: string, search: string): SettingsSection => {
  if (path === '/data') return 'data';
  const requested = new URLSearchParams(search).get('section');
  return requested === 'features' ||
    requested === 'forecast' ||
    requested === 'accounts' ||
    requested === 'updates' ||
    requested === 'data' ||
    requested === 'security'
    ? requested
    : 'appearance';
};

const HubPage = ({
  title,
  description,
  items,
  preferences = defaultProfilePreferences,
}: {
  title: string;
  description: string;
  items: ReadonlyArray<{
    title: string;
    description: string;
    path: string;
    feature?: FinancialFeature;
  }>;
  preferences?: ProfilePreferences;
}): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  const visibleItems = items.filter(
    (item) => item.feature === undefined || isFinancialFeatureVisible(preferences, item.feature),
  );
  return (
    <div>
      <header className={styles.pageHeader}>
        <Title1 as="h1">{title}</Title1>
        <Text>{description}</Text>
      </header>
      <div className={styles.hubGrid}>
        {visibleItems.map((item) => (
          <Card className={styles.hubCard} key={item.path}>
            <div className={styles.hubCopy} data-layout-watch="hub-card-copy">
              <Title2 as="h2">{item.title}</Title2>
              <Text as="p">{item.description}</Text>
            </div>
            <Button
              className={styles.hubAction}
              appearance="subtle"
              onClick={() => navigate(item.path)}
            >
              Open
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
};

const HiddenFeaturePage = ({ feature }: { feature: FinancialFeature }): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  return (
    <Card className={styles.panel}>
      <Text className={styles.eyebrow}>Hidden from your workspace</Text>
      <Title1 as="h1">{financialFeatureLabels[feature]}</Title1>
      <Text>
        This section is turned off for this profile. Its saved records still remain in forecasts and
        history.
      </Text>
      <div className={styles.actions}>
        <Button appearance="primary" onClick={() => navigate(featureSettingsPath(feature))}>
          Turn this section on
        </Button>
        <Button onClick={() => navigate('/')}>Back to Overview</Button>
      </div>
    </Card>
  );
};

const NativeMenuHoverEdge = (): React.JSX.Element | null => {
  const styles = useStyles();
  const [menuVisible, setMenuVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setNativeMenuVisibility = useCallback(async (visible: boolean): Promise<void> => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    const setVisibility = window.balanceBook.setMenuBarVisibility;
    if (typeof setVisibility !== 'function') return;
    setMenuVisible(visible);
    const result = await setVisibility({ visible });
    if (!result.ok && visible) setMenuVisible(false);
  }, []);

  useEffect(() => {
    if (!menuVisible) return;
    const scheduleHide = (event: PointerEvent): void => {
      if (event.clientY <= 12) return;
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        void setNativeMenuVisibility(false);
      }, 500);
    };
    document.addEventListener('pointermove', scheduleHide);
    return () => {
      document.removeEventListener('pointermove', scheduleHide);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [menuVisible, setNativeMenuVisibility]);

  if (menuVisible) return null;
  return (
    <div
      className={styles.menuRevealEdge}
      data-testid="native-menu-reveal-edge"
      aria-hidden="true"
      onPointerEnter={() => void setNativeMenuVisibility(true)}
    />
  );
};

const AppShell = ({
  session,
  systemDark,
  darkMode,
  onSession,
  onLogout,
}: {
  session: SessionDto;
  systemDark: boolean;
  darkMode: boolean;
  onSession: (session: SessionDto) => void;
  onLogout: () => void;
}): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [postUpdateNotice, setPostUpdateNotice] = useState<PostUpdateNoticeDto | null>(null);
  const [sidebarPreferenceBusy, setSidebarPreferenceBusy] = useState(false);
  const [sidebarPreferenceError, setSidebarPreferenceError] = useState<string | null>(null);
  const previousLocationRef = useRef(`${location.pathname}${location.search}`);
  const sidebarCollapsed = session.preferences.sidebarCollapsed;
  const navGroups: ReadonlyArray<{
    label: string;
    items: ReadonlyArray<readonly [string, string, NavigationIconName]>;
  }> = [
    {
      label: 'Balance Book',
      items: [
        ['Overview', '/', 'overview'],
        ['Forecast', '/forecast', 'forecast'],
        ['Accounts', '/accounts', 'accounts'],
        ['Planning', '/planning', 'planning'],
        ['Settings', '/settings', 'settings'],
      ],
    },
  ];
  const currentPrimaryPath = primaryPathForLocation(location.pathname);
  const secondaryDestinations = secondaryDestinationsFor(location.pathname, session.preferences);
  const settingsInitialSection = settingsSectionForLocation(location.pathname, location.search);
  const featurePage = (feature: FinancialFeature, page: React.JSX.Element): React.JSX.Element =>
    isFinancialFeatureVisible(session.preferences, feature) ? (
      page
    ) : (
      <HiddenFeaturePage feature={feature} />
    );

  useEffect(() => {
    const currentLocation = `${location.pathname}${location.search}`;
    if (previousLocationRef.current === currentLocation) return;
    previousLocationRef.current = currentLocation;
    mainRef.current?.focus();
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (typeof window.balanceBook.getPostUpdateNotice !== 'function') return;
    let active = true;
    void window.balanceBook.getPostUpdateNotice().then((result) => {
      if (active && result.ok) setPostUpdateNotice(result.value);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleSidebar = async (): Promise<void> => {
    if (sidebarPreferenceBusy) return;
    setSidebarPreferenceBusy(true);
    setSidebarPreferenceError(null);
    try {
      const result = await window.balanceBook.setPreferences({
        ...session.preferences,
        sidebarCollapsed: !sidebarCollapsed,
      });
      if (!result.ok) throw new Error(result.error);
      onSession(result.value);
    } catch (caught) {
      setSidebarPreferenceError(
        caught instanceof Error ? caught.message : 'Navigation preference could not be saved.',
      );
    } finally {
      setSidebarPreferenceBusy(false);
    }
  };

  return (
    <div
      className={`${styles.shell} ${sidebarCollapsed ? styles.shellCollapsed : ''}`}
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
    >
      <AmbientBackdrop />
      <a
        className={styles.skipLink}
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <Text size={200}>Local profile</Text>
          <strong>{session.profile.displayName}</strong>
        </div>
        <div className={styles.headerActions} data-layout-watch="shell-header-actions">
          <NotificationCenter
            refreshKey={`${location.pathname}${location.search}`}
            darkMode={darkMode}
          />
          <Button className={styles.logoutButton} appearance="subtle" onClick={onLogout}>
            Log out
          </Button>
        </div>
      </header>
      <aside
        id="primary-sidebar"
        className={`${styles.sidebar} ${sidebarCollapsed ? styles.sidebarCollapsed : ''}`}
      >
        <div
          className={`${styles.sidebarCollapseControl} ${
            sidebarCollapsed ? styles.sidebarCollapseControlCollapsed : ''
          }`}
        >
          <Button
            className={styles.sidebarCollapseButton}
            appearance="subtle"
            size="small"
            aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!sidebarCollapsed}
            aria-controls="primary-sidebar"
            disabled={sidebarPreferenceBusy}
            onClick={() => void toggleSidebar()}
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20">
              <path
                d={
                  sidebarCollapsed
                    ? 'M7.65 4.15a.5.5 0 0 1 .7 0l5.5 5.5a.5.5 0 0 1 0 .7l-5.5 5.5a.5.5 0 1 1-.7-.7L12.79 10 7.65 4.85a.5.5 0 0 1 0-.7Z'
                    : 'M12.35 4.15a.5.5 0 0 1 0 .7L7.21 10l5.14 5.15a.5.5 0 1 1-.7.7l-5.5-5.5a.5.5 0 0 1 0-.7l5.5-5.5a.5.5 0 0 1 .7 0Z'
                }
                fill="currentColor"
              />
            </svg>
          </Button>
        </div>
        <Button
          className={`${styles.sidebarBrand} ${
            sidebarCollapsed ? styles.sidebarBrandCollapsed : ''
          }`}
          appearance="subtle"
          aria-label={`${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation from Balance Book logo`}
          aria-expanded={!sidebarCollapsed}
          aria-controls="primary-sidebar"
          disabled={sidebarPreferenceBusy}
          onClick={() => void toggleSidebar()}
          style={sidebarCollapsed ? { width: '100%', minWidth: 0, maxWidth: '100%' } : undefined}
        >
          <span className={styles.sidebarBrandMark} data-testid="sidebar-brand-mark">
            <BalanceBookMark compact />
          </span>
          <span
            className={`${styles.sidebarBrandCopy} ${
              sidebarCollapsed ? styles.sidebarBrandCopyCollapsed : ''
            }`}
          >
            <Title2>Balance Book</Title2>
            <Text size={200} className={styles.sidebarTagline}>
              Private financial planner
            </Text>
          </span>
        </Button>
        {sidebarPreferenceError && (
          <Text size={100} role="alert">
            {sidebarPreferenceError}
          </Text>
        )}
        <Select
          className={styles.mobileNav}
          aria-label="Go to page"
          value={currentPrimaryPath}
          onChange={(_, data) => navigate(data.value)}
        >
          {navGroups.map((group) => (
            <optgroup label={group.label} key={group.label}>
              {group.items.map(([label, path]) => (
                <option value={path} key={path}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <nav
          className={`${styles.nav} ${sidebarCollapsed ? styles.navCollapsed : ''}`}
          aria-label="Primary navigation"
        >
          {navGroups.map((group) => (
            <div className={styles.navGroup} key={group.label}>
              {!sidebarCollapsed && <Text className={styles.navLabel}>{group.label}</Text>}
              {group.items.map(([label, path, icon]) => {
                const active = currentPrimaryPath === path;
                return (
                  <Button
                    key={path}
                    className={`${styles.navButton} balance-nav-button`}
                    appearance="subtle"
                    aria-label={sidebarCollapsed ? label : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => navigate(path)}
                  >
                    <span
                      className={`${styles.navIcon} ${
                        sidebarCollapsed ? styles.navIconCollapsed : ''
                      }`}
                      aria-hidden="true"
                    >
                      <NavigationIcon name={icon} />
                    </span>
                    {!sidebarCollapsed && label}
                  </Button>
                );
              })}
            </div>
          ))}
        </nav>
        {!sidebarCollapsed && (
          <Text size={200} className={styles.sidebarFooter}>
            Local-only · no bank connection
          </Text>
        )}
      </aside>
      <main className={styles.content} id="main-content" ref={mainRef} tabIndex={-1}>
        {postUpdateNotice && (
          <Card className={styles.postUpdateNotice} aria-labelledby="post-update-title">
            <Text className={styles.eyebrow}>Update complete</Text>
            <Title2 id="post-update-title" as="h2">
              Balance Book was updated
            </Title2>
            <Text>
              Version {postUpdateNotice.oldVersion} became {postUpdateNotice.newVersion}. Your local
              profile, password, settings, and financial records were retained.
            </Text>
            {postUpdateNotice.releaseNotes && <Text>{postUpdateNotice.releaseNotes}</Text>}
            <div className={styles.actions}>
              <Button appearance="primary" onClick={() => navigate('/settings?section=data')}>
                Review backup controls
              </Button>
              <Button
                onClick={() => {
                  void window.balanceBook.acknowledgePostUpdateNotice().then((result) => {
                    if (result.ok) setPostUpdateNotice(null);
                  });
                }}
              >
                Dismiss
              </Button>
            </div>
          </Card>
        )}
        {secondaryDestinations.length > 0 && (
          <nav className={styles.secondaryNav} aria-label="Section navigation">
            {secondaryDestinations.map(([label, path]) => (
              <Button
                key={path}
                size="small"
                appearance={location.pathname === path ? 'primary' : 'subtle'}
                aria-current={location.pathname === path ? 'page' : undefined}
                onClick={() => navigate(path)}
              >
                {label}
              </Button>
            ))}
          </nav>
        )}
        <Routes>
          <Route
            path="/"
            element={
              <DashboardPage
                key={`dashboard:${session.preferences.overviewForecastMode}`}
                preferences={session.preferences}
              />
            }
          />
          <Route
            path="/forecast"
            element={
              <DashboardPage
                key={`dashboard:${session.preferences.overviewForecastMode}`}
                fullForecast
                preferences={session.preferences}
              />
            }
          />
          <Route
            path="/income"
            element={featurePage(
              'income',
              <IncomePage
                experimentalCardInterestForecastEnabled={
                  session.preferences.experimentalCardInterestForecastEnabled
                }
              />,
            )}
          />
          <Route path="/baseline" element={<BaselinePage />} />
          <Route
            path="/accounts"
            element={
              <HubPage
                title="Accounts"
                preferences={session.preferences}
                description="Every balance, debt, receivable, and asset—organized by what you need to manage."
                items={[
                  {
                    title: 'Cash accounts',
                    description: 'Balances, protection, visibility, and transfer timing.',
                    path: '/settings?section=accounts',
                  },
                  {
                    title: 'Bills & subscriptions',
                    description: 'Amounts, schedules, payment sources, and shared costs.',
                    path: '/bills',
                    feature: 'bills',
                  },
                  {
                    title: 'Credit cards',
                    description: 'Runway, statements, payments, activity, and card terms.',
                    path: '/cards',
                    feature: 'credit-cards',
                  },
                  {
                    title: 'Loans',
                    description: 'Payoff progress, amortization, payments, and loan assumptions.',
                    path: '/loans',
                    feature: 'loans',
                  },
                  {
                    title: 'Money owed',
                    description: 'Current balances, future receivables, and recorded releases.',
                    path: '/receivables',
                    feature: 'money-owed',
                  },
                  {
                    title: 'Assets and net worth',
                    description: 'Investments, other assets, liabilities, and net worth.',
                    path: '/net-worth',
                    feature: 'assets',
                  },
                ]}
              />
            }
          />
          <Route
            path="/cards"
            element={featurePage(
              'credit-cards',
              <CardsPage
                experimentalCardInterestForecastEnabled={
                  session.preferences.experimentalCardInterestForecastEnabled
                }
              />,
            )}
          />
          <Route path="/bills" element={featurePage('bills', <BillsPage />)} />
          <Route path="/loans" element={featurePage('loans', <LoansPage />)} />
          <Route path="/receivables" element={featurePage('money-owed', <ReceivablesPage />)} />
          <Route path="/setup" element={<SetupPage session={session} onSession={onSession} />} />
          <Route path="/scenario" element={<ScenarioPage />} />
          <Route
            path="/planning"
            element={
              <HubPage
                title="Planning"
                preferences={session.preferences}
                description="Explore decisions without cluttering the day-to-day view."
                items={[
                  {
                    title: 'Scenarios',
                    description: 'Test purchases and saved what-if decisions.',
                    path: '/scenario',
                  },
                  {
                    title: 'Refinance',
                    description: 'Compare and commit replacement-loan plans.',
                    path: '/refinance',
                    feature: 'loans',
                  },
                  {
                    title: 'Trends',
                    description: 'Review historical and projected financial trajectories.',
                    path: '/charts',
                  },
                ]}
              />
            }
          />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/net-worth" element={featurePage('assets', <NetWorthPage />)} />
          <Route
            path="/charts"
            element={
              <ChartsPage
                experimentalCardInterestForecastEnabled={
                  session.preferences.experimentalCardInterestForecastEnabled
                }
              />
            }
          />
          <Route
            path="/refinance"
            element={featurePage(
              'loans',
              <RefinancePage
                experimentalCardInterestForecastEnabled={
                  session.preferences.experimentalCardInterestForecastEnabled
                }
              />,
            )}
          />
          <Route path="/reconcile" element={<ReconciliationPage />} />
          <Route
            path="/data"
            element={
              <DataPage
                session={session}
                systemDark={systemDark}
                onSession={onSession}
                initialSection={settingsInitialSection}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <DataPage
                session={session}
                systemDark={systemDark}
                onSession={onSession}
                initialSection={settingsInitialSection}
              />
            }
          />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </main>
    </div>
  );
};

export const SetupPage = ({
  session,
  onSession,
}: {
  session?: SessionDto;
  onSession?: (session: SessionDto) => void;
}): React.JSX.Element => {
  const styles = useStyles();
  const navigate = useNavigate();
  const today = Temporal.Now.plainDateISO();
  const form = useForm<SetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      localDataConsent: '',
      usesIncome: '',
      usesBills: '',
      usesCreditCards: '',
      usesLoans: '',
      usesMoneyOwed: '',
      usesAssets: '',
      balanceAsOf: today.toString(),
      accountName: '',
      openingBalance: '',
      incomeLabel: '',
      incomeDate: '',
      incomeAmount: '',
      commitmentLabel: '',
      commitmentDate: '',
      commitmentAmount: '',
      cardName: '',
      cardEstimate: '',
      cardPaymentDay: '',
      cardStatementCloseDay: '',
      cardEstimatePolicy: '',
      cardPaymentPolicy: '',
      cardMinimumPayment: '',
      cardFixedPayment: '',
      hardFloor: '',
      preferredFloor: '',
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [step, setStep] = useState(0);
  const [setupRecords, setSetupRecords] = useState<ManagedRecordsDto | null>(null);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [hasImportLineage, setHasImportLineage] = useState(false);
  const [reviewSections, setReviewSections] = useState<
    Record<string, 'reviewed' | 'not-applicable'>
  >({});
  const reviewSectionsRef = useRef<Record<string, SetupReviewStatus>>({});
  const [isExitingSetup, setIsExitingSetup] = useState(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const exitSetupLockRef = useRef(false);
  const watchedSetupValues = useWatch({ control: form.control });
  const activeSetupSteps = activeSetupStepIds(watchedSetupValues);
  const currentSetupStepIndex = Math.min(step, Math.max(0, activeSetupSteps.length - 1));
  const currentSetupStep = activeSetupSteps[currentSetupStepIndex] ?? 'welcome';
  const persistSetupDraft = useCallback(
    async (values: Record<string, string>, successStatus: string): Promise<boolean> => {
      const operation = draftSaveQueueRef.current.then(async () => {
        const result = await window.balanceBook.saveOnboardingDraft({ values });
        if (!result.ok) throw new Error(result.error);
      });
      draftSaveQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      try {
        await operation;
        setDraftError(null);
        setDraftStatus(successStatus);
        return true;
      } catch (caught: unknown) {
        setDraftStatus('Setup draft could not be saved. Your changes are still on this screen.');
        setDraftError(errorMessage(caught));
        return false;
      }
    },
    [],
  );
  useEffect(() => {
    void Promise.all([
      window.balanceBook.listRecords(),
      window.balanceBook.getOnboardingDraft(),
      window.balanceBook.getImportReview(),
    ])
      .then(([recordsResult, draftResult, importReviewResult]) => {
        if (recordsResult.ok) setSetupRecords(recordsResult.value);
        else setError(recordsResult.error);
        if (importReviewResult.ok) {
          setHasImportLineage(
            importReviewResult.value.batches.length > 0 ||
              importReviewResult.value.fields.length > 0,
          );
        }
        if (draftResult.ok && draftResult.value) {
          const currentValues = form.getValues();
          const formValues = Object.fromEntries(
            Object.entries(draftResult.value.values).filter(([key]) => key in currentValues),
          );
          const savedSections = Object.fromEntries(
            Object.entries(draftResult.value.values)
              .filter(
                ([key, value]) =>
                  key.startsWith('review_') && (value === 'reviewed' || value === 'not-applicable'),
              )
              .map(([key, value]) => [
                key.slice('review_'.length),
                value as 'reviewed' | 'not-applicable',
              ]),
          );
          form.reset({ ...currentValues, ...formValues } as SetupValues);
          reviewSectionsRef.current = savedSections;
          setReviewSections(savedSections);
          setDraftStatus(
            `Resumed saved setup from ${new Date(draftResult.value.updatedAt).toLocaleString()}.`,
          );
        }
        setDraftReady(true);
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
        setDraftReady(true);
      });
  }, [form]);
  useEffect(() => {
    if (!draftReady) return undefined;
    const values = setupDraftPayloadValues(watchedSetupValues, reviewSections);
    const pending = setTimeout(() => {
      if (draftTimerRef.current === pending) draftTimerRef.current = null;
      void persistSetupDraft(values, 'Setup draft saved locally.');
    }, 500);
    draftTimerRef.current = pending;
    return () => {
      clearTimeout(pending);
      if (draftTimerRef.current === pending) draftTimerRef.current = null;
    };
  }, [draftReady, persistSetupDraft, reviewSections, watchedSetupValues]);

  const exitSetup = async (): Promise<void> => {
    if (exitSetupLockRef.current) return;
    exitSetupLockRef.current = true;
    setIsExitingSetup(true);
    setDraftError(null);
    setDraftStatus('Saving your latest setup changes...');
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    try {
      const savedLatestDraft = await persistSetupDraft(
        setupDraftPayloadValues(form.getValues(), reviewSections),
        'Latest setup draft saved locally.',
      );
      if (savedLatestDraft) navigate('/');
    } finally {
      exitSetupLockRef.current = false;
      setIsExitingSetup(false);
    }
  };

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    setSaved(false);
    try {
      const result = await window.balanceBook.saveVerticalSlice({
        balanceAsOf: values.balanceAsOf,
        accountName: values.accountName,
        openingBalanceCents: dollarsToCents(values.openingBalance),
        ...(values.usesIncome === 'yes' && values.incomeLabel
          ? {
              incomeLabel: values.incomeLabel,
              incomeDate: values.incomeDate || undefined,
              incomeAmountCents: dollarsToCents(values.incomeAmount),
            }
          : {}),
        ...(values.usesBills === 'yes' && values.commitmentLabel
          ? {
              commitmentLabel: values.commitmentLabel,
              commitmentDate: values.commitmentDate || undefined,
              commitmentAmountCents: dollarsToCents(values.commitmentAmount),
            }
          : {}),
        ...(values.usesCreditCards === 'yes' && values.cardName
          ? {
              cardName: values.cardName,
              cardEstimateCents: dollarsToCents(values.cardEstimate),
              cardPaymentDayOfMonth:
                values.cardPaymentDay === '' ? undefined : Number(values.cardPaymentDay),
              cardStatementCloseDayOfMonth:
                values.cardStatementCloseDay === ''
                  ? undefined
                  : Number(values.cardStatementCloseDay),
              cardEstimatePolicy:
                values.cardEstimatePolicy === '' ? undefined : values.cardEstimatePolicy,
              cardPaymentPolicy:
                values.cardPaymentPolicy === '' ? undefined : values.cardPaymentPolicy,
              cardMinimumPaymentCents:
                values.cardPaymentPolicy === 'minimum'
                  ? dollarsToCents(values.cardMinimumPayment)
                  : undefined,
              cardFixedPaymentCents:
                values.cardPaymentPolicy === 'fixed'
                  ? dollarsToCents(values.cardFixedPayment)
                  : undefined,
            }
          : {}),
        hardFloorCents: dollarsToCents(values.hardFloor),
        preferredFloorCents:
          values.preferredFloor === '' ? undefined : dollarsToCents(values.preferredFloor),
      });
      if (!result.ok) setError(result.error);
      else {
        const currentSession =
          session ??
          (await window.balanceBook
            .getSession()
            .then((sessionResult) => (sessionResult.ok ? sessionResult.value : null)));
        if (!currentSession) throw new Error('Your profile settings could not be loaded.');
        const preferencesResult = await window.balanceBook.setPreferences({
          ...currentSession.preferences,
          showIncomeTools: values.usesIncome === 'yes',
          showBills: values.usesBills === 'yes',
          showCreditCards: values.usesCreditCards === 'yes',
          showLoans: values.usesLoans === 'yes',
          showMoneyOwed: values.usesMoneyOwed === 'yes',
          showAssetsAndNetWorth: values.usesAssets === 'yes',
        });
        if (!preferencesResult.ok) {
          throw new Error(
            `Your first forecast was saved, but section visibility could not be saved: ${preferencesResult.error}`,
          );
        }
        onSession?.(preferencesResult.value);
        const refreshed = await window.balanceBook.listRecords();
        if (!refreshed.ok) setError(refreshed.error);
        else {
          setSetupRecords(refreshed.value);
          setSaved(true);
        }
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  });

  const field = (
    name: keyof SetupValues,
    label: string,
    type: 'text' | 'date' | 'number' = 'text',
  ) => (
    <Field label={label} validationMessage={form.formState.errors[name]?.message}>
      <Input type={type} disabled={isExitingSetup} {...form.register(name)} />
    </Field>
  );
  const applicabilityQuestions: Array<{
    name:
      'usesIncome' | 'usesBills' | 'usesCreditCards' | 'usesLoans' | 'usesMoneyOwed' | 'usesAssets';
    title: string;
    detail: string;
  }> = [
    {
      name: 'usesIncome',
      title: 'Do you want to track income, raises, or bonuses?',
      detail: 'Includes regular pay, split deposits, and future pay changes.',
    },
    {
      name: 'usesBills',
      title: 'Do you pay bills or subscriptions?',
      detail: 'Includes recurring and changing expenses from cash or cards.',
    },
    {
      name: 'usesCreditCards',
      title: 'Do you use credit cards?',
      detail: 'Adds statement tracking, payment timing, and safe-to-spend guidance.',
    },
    {
      name: 'usesLoans',
      title: 'Do you have installment loans?',
      detail: 'Includes payoff progress, amortization, and refinancing.',
    },
    {
      name: 'usesMoneyOwed',
      title: 'Does anyone reimburse or repay you?',
      detail: 'Tracks current and future money owed without treating it as cash too early.',
    },
    {
      name: 'usesAssets',
      title: 'Do you want to track investments or other assets?',
      detail: 'Adds investment growth, assets, and net worth.',
    },
  ];
  const applicabilityQuestion = (
    question: (typeof applicabilityQuestions)[number],
  ): React.JSX.Element => {
    const answer = watchedSetupValues[question.name] ?? '';
    const validationMessage = form.formState.errors[question.name]?.message;
    return (
      <div className={styles.applicabilityRow} key={question.name}>
        <div>
          <strong>{question.title}</strong>
          <Text size={200}>{question.detail}</Text>
          {validationMessage && (
            <Text role="alert" className={styles.error} size={200}>
              {validationMessage}
            </Text>
          )}
        </div>
        <div className={styles.applicabilityChoices} role="group" aria-label={question.title}>
          {(['yes', 'no'] as const).map((choice) => (
            <Button
              key={choice}
              type="button"
              size="small"
              appearance={answer === choice ? 'primary' : 'outline'}
              className={answer === choice ? styles.applicabilityChoiceSelected : undefined}
              aria-pressed={answer === choice}
              disabled={isExitingSetup}
              onClick={() => {
                form.setValue(question.name, choice, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: true,
                });
                form.clearErrors(question.name);
              }}
            >
              {choice === 'yes' ? 'Yes' : 'No'}
            </Button>
          ))}
        </div>
      </div>
    );
  };
  const fieldsByStep: Record<SetupStepId, Array<keyof SetupValues>> = {
    welcome: ['localDataConsent'],
    fit: ['usesIncome', 'usesBills', 'usesCreditCards', 'usesLoans', 'usesMoneyOwed', 'usesAssets'],
    cash: ['balanceAsOf', 'accountName', 'openingBalance'],
    income: ['incomeLabel', 'incomeDate', 'incomeAmount'],
    bill: ['commitmentLabel', 'commitmentDate', 'commitmentAmount'],
    cards: [
      'cardName',
      'cardEstimate',
      'cardPaymentDay',
      'cardStatementCloseDay',
      'cardEstimatePolicy',
      'cardPaymentPolicy',
      'cardMinimumPayment',
      'cardFixedPayment',
    ],
    minimums: ['hardFloor', 'preferredFloor'],
    review: [],
  };
  const continueSetup = async () => {
    const fields = fieldsByStep[currentSetupStep];
    form.clearErrors(fields);
    const result = setupStepSchemas[currentSetupStep].safeParse(form.getValues());
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && fields.includes(field as keyof SetupValues)) {
          form.setError(field as keyof SetupValues, { type: 'manual', message: issue.message });
        }
      }
      return;
    }
    setStep(Math.min(activeSetupSteps.length - 1, currentSetupStepIndex + 1));
  };

  if (!setupRecords) {
    if (error) {
      return (
        <Card className={styles.panel}>
          <Title1 as="h1">Setup could not be loaded</Title1>
          <div role="alert" className={styles.error}>
            {error}
          </div>
          <Button appearance="primary" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Card>
      );
    }
    return <LoadingSkeleton label="Loading setup" variant="form" />;
  }
  if (setupRecords.accounts.length > 0) {
    const activeLoanCount = activeLoansForDate({
      accounts: setupRecords.accounts,
      loans: setupRecords.loans,
      plans: setupRecords.committedRefinancePlans,
      loanPaymentEvents: setupRecords.events,
      date: today.toString(),
    }).length;
    const incomingCashCount = countLogicalSetupIncomingCash(setupRecords.events);
    const directPaymentCount = setupRecords.events.filter(
      (event) => event.kind === 'direct-commitment',
    ).length;
    const payableCount = setupRecords.events.filter((event) => event.kind === 'payable').length;
    const prePaycheckCount = setupRecords.events.filter(
      (event) => event.kind === 'baseline-spending',
    ).length;
    const contributionCount = setupRecords.events.filter(
      (event) => event.kind === 'investment-contribution',
    ).length;
    const recurringOwedCount = setupRecords.receivables.filter(
      hasRecurringReceivableSchedule,
    ).length;
    const investmentCount = setupRecords.assets.filter(
      (asset) => asset.type === 'investment',
    ).length;
    const otherAssetCount = setupRecords.assets.length - investmentCount;
    const allSetupTopics = [
      {
        id: 'cash',
        section: 'A · What you own',
        title: 'Cash accounts and starting balances',
        detail: `${setupRecords.accounts.length} dated cash account balance(s)`,
        action: 'Review cash accounts',
        path: '/records?type=cash-account',
        hasData: setupRecords.accounts.length > 0,
        required: true,
      },
      {
        id: 'money-owed',
        section: 'A · What you own',
        title: 'Money owed to you',
        detail: `${setupRecords.receivables.length} current or scheduled receivable record(s)`,
        action: setupRecords.receivables.length > 0 ? 'Review money owed' : 'Add money owed',
        path: '/receivables',
        hasData: setupRecords.receivables.length > 0,
        required: false,
      },
      {
        id: 'investments',
        section: 'A · What you own',
        title: 'Investments',
        detail: `${investmentCount} investment holding(s)`,
        action: investmentCount > 0 ? 'Review investments' : 'Add investments',
        path: '/net-worth',
        hasData: investmentCount > 0,
        required: false,
      },
      {
        id: 'other-assets',
        section: 'A · What you own',
        title: 'Tangible and other assets',
        detail: `${otherAssetCount} tangible or other asset(s)`,
        action: otherAssetCount > 0 ? 'Review other assets' : 'Add other assets',
        path: '/net-worth',
        hasData: otherAssetCount > 0,
        required: false,
      },
      {
        id: 'cards',
        section: 'B · What you owe and pay',
        title: 'Credit cards and statement history',
        detail: `${setupRecords.cards.length} card(s) · ${setupRecords.cardCycles.length} statement cycle(s)`,
        action: setupRecords.cards.length > 0 ? 'Review cards' : 'Add cards',
        path: '/cards',
        hasData: setupRecords.cards.length > 0,
        required: false,
      },
      {
        id: 'loans',
        section: 'B · What you owe and pay',
        title: 'Loans and payment schedules',
        detail: `${activeLoanCount} currently active · ${setupRecords.loans.length} total loan record(s)`,
        action: setupRecords.loans.length > 0 ? 'Review loans' : 'Add loans',
        path: '/loans',
        hasData: setupRecords.loans.length > 0,
        required: false,
      },
      {
        id: 'direct-payments',
        section: 'B · What you owe and pay',
        title: 'Bills paid directly from cash',
        detail: `${directPaymentCount} bill or recurring payment record(s) paid directly from cash`,
        action: directPaymentCount > 0 ? 'Review cash-paid bills' : 'Add cash-paid bill',
        path: `/records?type=forecast-event&kind=direct-commitment${directPaymentCount > 0 ? '' : '&mode=add'}`,
        hasData: directPaymentCount > 0,
        required: false,
      },
      {
        id: 'payables',
        section: 'B · What you owe and pay',
        title: 'Other amounts you owe',
        detail: `${payableCount} other obligation record(s)`,
        action: payableCount > 0 ? 'Review other obligations' : 'Add other obligation',
        path: `/records?type=forecast-event&kind=payable${payableCount > 0 ? '' : '&mode=add'}`,
        hasData: payableCount > 0,
        required: false,
      },
      {
        id: 'income',
        section: 'C · Regular timing and policies',
        title: 'Income and recurring money coming in',
        detail: `${incomingCashCount} income source(s) or standalone inflow(s); split deposits, linked raises, and linked bonuses stay with their source`,
        action: incomingCashCount > 0 ? 'Review income plan' : 'Add income',
        path: '/income',
        hasData: incomingCashCount > 0,
        required: false,
      },
      {
        id: 'regular-owed',
        section: 'C · Regular timing and policies',
        title: 'Regular people or sources that owe you',
        detail: `${recurringOwedCount} recurring reimbursement schedule(s)`,
        action: recurringOwedCount > 0 ? 'Review recurring receipts' : 'Add recurring receipts',
        path: '/receivables',
        hasData: recurringOwedCount > 0,
        required: false,
      },
      {
        id: 'pre-paycheck',
        section: 'C · Regular timing and policies',
        title: 'Pre-paycheck spending assumptions',
        detail: `${prePaycheckCount} baseline spending assumption(s)`,
        action: prePaycheckCount > 0 ? 'Review spending assumptions' : 'Add assumptions',
        path: `/records?type=forecast-event&kind=baseline-spending${prePaycheckCount > 0 ? '' : '&mode=add'}`,
        hasData: prePaycheckCount > 0,
        required: false,
      },
      {
        id: 'contributions',
        section: 'C · Regular timing and policies',
        title: 'Retirement and investment contributions',
        detail: `${contributionCount} cash or payroll contribution record(s)`,
        action: contributionCount > 0 ? 'Review contributions' : 'Add contributions',
        path: `/records?type=forecast-event&kind=investment-contribution${contributionCount > 0 ? '' : '&mode=add'}`,
        hasData: contributionCount > 0,
        required: false,
      },
      {
        title: 'Rewards and benefits',
        id: 'rewards',
        section: 'C · Regular timing and policies',
        detail: `${setupRecords.rewardPrograms.length} rewards program(s)`,
        action: setupRecords.rewardPrograms.length > 0 ? 'Review rewards' : 'Add rewards',
        path: `/records?type=reward-program${setupRecords.rewardPrograms.length > 0 ? '' : '&mode=add'}`,
        hasData: setupRecords.rewardPrograms.length > 0,
        required: false,
      },
      {
        id: 'guardrails',
        section: 'C · Regular timing and policies',
        title: 'Global protected minimum and preferred buffer',
        detail:
          'Account minimums, the global protected minimum, preferred buffer, horizon, and conservative receipts',
        action: 'Review settings',
        path: '/data',
        hasData: Boolean(setupRecords.policy),
        required: true,
      },
      ...(hasImportLineage
        ? [
            {
              id: 'sources',
              section: 'Review',
              title: 'Sources, import mapping, and audit trail',
              detail: 'Check where imported values came from and which fields you changed',
              action: 'Review record lineage',
              path: '/records?sourceReview=1',
              hasData: false,
              required: true,
              requiresReview: true,
            },
          ]
        : []),
    ];
    const setupTopicFeatures: Partial<Record<string, FinancialFeature>> = {
      'money-owed': 'money-owed',
      'regular-owed': 'money-owed',
      investments: 'assets',
      'other-assets': 'assets',
      contributions: 'assets',
      cards: 'credit-cards',
      rewards: 'credit-cards',
      loans: 'loans',
      'direct-payments': 'bills',
      payables: 'bills',
      income: 'income',
    };
    const setupPreferences = session?.preferences ?? defaultProfilePreferences;
    const setupTopics = allSetupTopics.filter((topic) => {
      const feature = setupTopicFeatures[topic.id];
      return feature === undefined || isFinancialFeatureVisible(setupPreferences, feature);
    });
    const cardsFeatureVisible = isFinancialFeatureVisible(setupPreferences, 'credit-cards');
    const cardsWithoutCycles = cardsFeatureVisible
      ? setupRecords.cards.filter(
          (card) =>
            card.paymentPolicy !== 'manual' &&
            card.paymentDayOfMonth !== undefined &&
            card.statementCloseDayOfMonth !== undefined &&
            !setupRecords.cardCycles.some(
              (cycle) => cycle.cardId === card.id && cycle.state !== 'paid',
            ),
        ).length
      : 0;
    const cardsWithIncompleteTiming = cardsFeatureVisible
      ? setupRecords.cards.filter(
          (card) =>
            card.paymentPolicy !== 'manual' &&
            (card.paymentDayOfMonth === undefined || card.statementCloseDayOfMonth === undefined),
        ).length
      : 0;
    const cardSetupIssueCount = cardsWithoutCycles + cardsWithIncompleteTiming;
    const topicStatus = (topic: (typeof setupTopics)[number]): string => {
      if (topic.requiresReview) {
        return reviewSections[topic.id] === 'reviewed' ? 'Reviewed' : 'Review needed';
      }
      if (topic.id === 'cards' && cardSetupIssueCount > 0) return 'Needs setup';
      if (topic.hasData) return 'Ready · data entered';
      if (reviewSections[topic.id] === 'not-applicable') return 'Not applicable';
      return topic.required ? 'Needs setup' : 'Needs a decision';
    };
    const topicComplete = (topic: (typeof setupTopics)[number]): boolean =>
      (topic.id !== 'cards' || cardSetupIssueCount === 0) &&
      (topic.hasData ||
        reviewSections[topic.id] === 'not-applicable' ||
        (topic.requiresReview === true && reviewSections[topic.id] === 'reviewed'));
    const completedTopicCount = setupTopics.filter(topicComplete).length;
    const incompleteTopics = setupTopics.filter((topic) => !topicComplete(topic));
    const uncertainRecordCount =
      setupRecords.events.filter((event) => event.certainty === 'uncertain').length +
      setupRecords.receivables.filter((receivable) => receivable.certainty === 'uncertain').length;
    const duplicateEventCount = countPotentialSetupDuplicateEvents(setupRecords.events);
    const setupWarnings = [
      ...(cardsWithoutCycles > 0
        ? [`${cardsWithoutCycles} card(s) still need a current or upcoming statement cycle.`]
        : []),
      ...(cardsWithIncompleteTiming > 0
        ? [
            `${cardsWithIncompleteTiming} non-manual card(s) have incomplete statement timing; enter source dates before relying on card guidance.`,
          ]
        : []),
      ...(uncertainRecordCount > 0
        ? [`${uncertainRecordCount} record(s) are explicitly uncertain; compare forecast modes.`]
        : []),
      ...(duplicateEventCount > 0
        ? [
            `${duplicateEventCount} cash record(s) have an exact account, income stream or plan identity, record type, date, amount, direction, and label match. Review possible duplicates.`,
          ]
        : []),
    ];
    type SetupTopic = (typeof setupTopics)[number];
    type SetupGroupId = 'start' | 'accuracy' | 'advanced';
    const groupByTopicId: Record<string, SetupGroupId> = {
      cash: 'start',
      income: 'start',
      'direct-payments': 'start',
      cards: 'start',
      guardrails: 'accuracy',
      'money-owed': 'accuracy',
      'regular-owed': 'accuracy',
      payables: 'accuracy',
      'pre-paycheck': 'accuracy',
      loans: 'advanced',
      investments: 'advanced',
      'other-assets': 'advanced',
      contributions: 'advanced',
      rewards: 'advanced',
      sources: 'advanced',
    };
    const setupGroups = [
      {
        id: 'start',
        title: 'Level 1 — Start',
        description:
          'Checking balances, income, major recurring expenses, and cards create a useful Overview immediately.',
        collapsed: false,
      },
      {
        id: 'accuracy',
        title: 'Level 2 — Improve accuracy',
        description:
          'Refine statement timing, payment accounts, money owed, thresholds, and recurring timing.',
        collapsed: false,
      },
      {
        id: 'advanced',
        title: 'Level 3 — Advanced',
        description:
          'Add loans, assets, raises and bonuses, refinance planning, custom forecast behavior, rewards, and source review only when useful.',
        collapsed: true,
      },
    ] as const;
    const topicsForGroup = (groupId: SetupGroupId): SetupTopic[] =>
      setupTopics.filter((topic) => groupByTopicId[topic.id] === groupId);
    const recommendedPriority = [
      'cash',
      'guardrails',
      'income',
      'direct-payments',
      'cards',
      'money-owed',
      'regular-owed',
      'loans',
      'pre-paycheck',
      'payables',
      'investments',
      'other-assets',
      'contributions',
      'rewards',
      'sources',
    ];
    const recommendedTopic =
      (cardSetupIssueCount > 0 ? setupTopics.find((topic) => topic.id === 'cards') : undefined) ??
      recommendedPriority
        .map((topicId) => setupTopics.find((topic) => topic.id === topicId))
        .find((topic): topic is SetupTopic => Boolean(topic && !topicComplete(topic)));
    const persistTopicReview = (topicId: string, status?: SetupReviewStatus): void => {
      const nextReviewSections = updateSetupReviewSections(
        reviewSectionsRef.current,
        topicId,
        status,
      );
      reviewSectionsRef.current = nextReviewSections;
      setReviewSections(nextReviewSections);
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      setDraftError(null);
      setDraftStatus(status === undefined ? 'Saving reopened section...' : 'Saving decision...');
      void persistSetupDraft(
        setupDraftPayloadValues(form.getValues(), nextReviewSections),
        status === undefined ? 'Section reopened and saved locally.' : 'Decision saved locally.',
      );
    };
    const renderSetupTopic = (topic: SetupTopic): React.JSX.Element => {
      const status = topicStatus(topic);
      const unresolved = !topicComplete(topic);
      const primaryAttention = status === 'Needs setup' || status === 'Review needed';
      return (
        <Card
          className={styles.setupTopic}
          key={topic.id}
          aria-label={`${topic.title} setup topic`}
        >
          <span
            className={`${styles.setupTopicStatus} ${
              unresolved ? styles.setupTopicStatusOpen : ''
            }`}
            aria-hidden="true"
          >
            {unresolved ? '○' : '✓'}
          </span>
          <div className={styles.setupTopicBody}>
            <Title2 as="h3">{topic.title}</Title2>
            <Text className={unresolved ? styles.warning : styles.positive}>
              <strong>{status}</strong>
            </Text>
            <Text size={200}>{topic.detail}</Text>
          </div>
          <div className={styles.actions}>
            <Button
              appearance={primaryAttention ? 'primary' : 'secondary'}
              onClick={() => navigate(topic.path)}
            >
              {topic.action}
            </Button>
            {topic.requiresReview && reviewSections[topic.id] !== 'reviewed' && (
              <Button onClick={() => persistTopicReview(topic.id, 'reviewed')}>
                Mark reviewed
              </Button>
            )}
            {!topic.required && !topic.hasData && reviewSections[topic.id] !== 'not-applicable' && (
              <Button onClick={() => persistTopicReview(topic.id, 'not-applicable')}>
                Not applicable
              </Button>
            )}
            {reviewSections[topic.id] !== undefined && (
              <Button appearance="subtle" onClick={() => persistTopicReview(topic.id)}>
                Reopen section
              </Button>
            )}
          </div>
        </Card>
      );
    };
    return (
      <>
        <div className={styles.pageHeader}>
          <Title1 as="h1">Complete your financial picture</Title1>
          <Text>
            Your first native forecast is ready. Add only the sections that apply to you; each
            guided page writes to the same local record set used by Overview and Cash Forecast.
          </Text>
        </div>
        <Card className={styles.panel}>
          <Title2 as="h2">Guided setup checklist</Title2>
          <Text>
            {completedTopicCount} of {setupTopics.length} topics are ready, reviewed, or marked not
            applicable. Start and accuracy stay visible; advanced topics stay out of the way until
            you open them. Every guided page updates the same native records used by Overview and
            Cash Forecast.
          </Text>
          {draftError && (
            <div className={styles.error} role="alert">
              Checklist decision not saved: {draftError}
            </div>
          )}
          {draftStatus && <div role="status">{draftStatus}</div>}
          {draftError && (
            <div className={styles.actions}>
              <Button
                onClick={() => {
                  setDraftError(null);
                  setDraftStatus('Retrying checklist save...');
                  void persistSetupDraft(
                    setupDraftPayloadValues(form.getValues(), reviewSectionsRef.current),
                    'Checklist decisions saved locally.',
                  );
                }}
              >
                Retry checklist save
              </Button>
            </div>
          )}
        </Card>
        <Card className={styles.setupRecommended} aria-labelledby="recommended-setup-title">
          <Text>
            <strong>Recommended next</strong>
          </Text>
          {recommendedTopic ? (
            <>
              <Title2 id="recommended-setup-title" as="h2">
                {recommendedTopic.title}
              </Title2>
              <Text>
                {cardSetupIssueCount > 0 && recommendedTopic.id === 'cards'
                  ? `${cardSetupIssueCount} card setup item(s) still need source timing or a statement cycle before card choice and payment-date guidance are complete.`
                  : recommendedTopic.detail}
              </Text>
              <div className={styles.actions}>
                <Button appearance="primary" onClick={() => navigate(recommendedTopic.path)}>
                  {recommendedTopic.action}
                </Button>
                {!recommendedTopic.required &&
                  !recommendedTopic.hasData &&
                  reviewSections[recommendedTopic.id] !== 'not-applicable' && (
                    <Button
                      onClick={() => persistTopicReview(recommendedTopic.id, 'not-applicable')}
                    >
                      Not applicable
                    </Button>
                  )}
                {recommendedTopic.requiresReview &&
                  reviewSections[recommendedTopic.id] !== 'reviewed' && (
                    <Button onClick={() => persistTopicReview(recommendedTopic.id, 'reviewed')}>
                      Mark reviewed
                    </Button>
                  )}
              </div>
            </>
          ) : (
            <>
              <Title2 id="recommended-setup-title" as="h2">
                Verify your daily forecast
              </Title2>
              <Text>
                Every setup topic is resolved. Check the projected low, account funding, and card
                spending guidance against the daily forecast.
              </Text>
              <div className={styles.actions}>
                <Button appearance="primary" onClick={() => navigate('/')}>
                  Open Overview
                </Button>
                <Button onClick={() => navigate('/forecast')}>Open daily Cash Forecast</Button>
              </div>
            </>
          )}
        </Card>
        {setupGroups
          .filter((group) => !group.collapsed && topicsForGroup(group.id).length > 0)
          .map((group) => {
            const groupTopics = topicsForGroup(group.id);
            const resolvedCount = groupTopics.filter(topicComplete).length;
            return (
              <section
                className={styles.setupGroup}
                key={group.id}
                aria-labelledby={`setup-group-${group.id}`}
              >
                <div className={styles.setupGroupHeader}>
                  <div>
                    <Title2 id={`setup-group-${group.id}`} as="h2">
                      {group.title}
                    </Title2>
                    <Text>{group.description}</Text>
                  </div>
                  <Text>
                    <strong>
                      {resolvedCount} of {groupTopics.length} resolved
                    </strong>
                  </Text>
                </div>
                <div className={styles.setupGroupGrid}>{groupTopics.map(renderSetupTopic)}</div>
              </section>
            );
          })}
        {setupGroups
          .filter((group) => group.collapsed && topicsForGroup(group.id).length > 0)
          .map((group) => {
            const groupTopics = topicsForGroup(group.id);
            const resolvedCount = groupTopics.filter(topicComplete).length;
            return (
              <details className={styles.setupCollapsible} key={group.id}>
                <summary>
                  {group.title} · {resolvedCount} of {groupTopics.length} resolved
                </summary>
                <div className={styles.setupCollapsibleBody}>
                  <Text>{group.description}</Text>
                  <div className={styles.setupGroupGrid}>{groupTopics.map(renderSetupTopic)}</div>
                </div>
              </details>
            );
          })}
        <Card className={styles.panel}>
          <Title2 as="h2">Final setup review</Title2>
          <Text>
            {completedTopicCount} of {setupTopics.length} topics are resolved.{' '}
            {incompleteTopics.length === 0
              ? 'Every topic has data, was reviewed, or was marked not applicable.'
              : `${incompleteTopics.length} topic(s) still need setup or a decision: ${incompleteTopics.map((topic) => topic.title).join(', ')}.`}
          </Text>
          {setupWarnings.length === 0 ? (
            <p>
              <Text>No current timing, uncertainty, or exact-duplicate warnings.</Text>
            </p>
          ) : (
            <ul>
              {setupWarnings.map((warning) => (
                <li key={warning} className={styles.warning}>
                  {warning}
                </li>
              ))}
            </ul>
          )}
          <Text>
            Open the daily forecast after editing to verify timing by account. Check an actual
            balance later without rewriting the original forecast.
          </Text>
          <div className={styles.actions}>
            <Button appearance="primary" onClick={() => navigate('/')}>
              Open Overview
            </Button>
            <Button onClick={() => navigate('/forecast')}>Open cash forecast</Button>
            <Button onClick={() => navigate('/reconcile')}>Check a balance</Button>
            <Button onClick={() => navigate('/records')}>Advanced financial records</Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className={styles.pageHeader}>
        <Title1 as="h1">First forecast setup</Title1>
        <Text>
          Start with one dated cash balance and a global protected minimum. The optional quick steps
          can add one upcoming deposit, one upcoming bill, and one card; the next checklist lets you
          add every account and record that applies to you.
        </Text>
      </div>
      <Card className={styles.panel}>
        <form
          className={styles.form}
          aria-busy={isExitingSetup}
          onSubmit={(event) => {
            if (currentSetupStep !== 'review') {
              event.preventDefault();
              void continueSetup();
            } else void submit(event);
          }}
          noValidate
        >
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          {draftError && (
            <div className={styles.error} role="alert">
              Draft not saved: {draftError}
            </div>
          )}
          {saved && <div role="status">Saved locally.</div>}
          {draftStatus && <div role="status">{draftStatus}</div>}
          <div className={styles.setupStepMeta}>
            <Text>
              Step {currentSetupStepIndex + 1} of {activeSetupSteps.length} ·{' '}
              {setupStepDefinitions[currentSetupStep].name}
            </Text>
            <Text>Draft changes autosave locally</Text>
          </div>
          <div
            className={styles.setupProgress}
            role="progressbar"
            aria-label="First forecast setup progress"
            aria-valuemin={1}
            aria-valuemax={activeSetupSteps.length}
            aria-valuenow={currentSetupStepIndex + 1}
            aria-valuetext={`${setupStepDefinitions[currentSetupStep].name}, step ${currentSetupStepIndex + 1} of ${activeSetupSteps.length}`}
            style={{ gridTemplateColumns: `repeat(${activeSetupSteps.length}, minmax(0, 1fr))` }}
          >
            {activeSetupSteps.map((stepId, index) => (
              <span
                key={stepId}
                title={setupStepDefinitions[stepId].name}
                className={`${styles.setupProgressStep} ${index <= currentSetupStepIndex ? styles.setupProgressStepComplete : ''}`}
              />
            ))}
          </div>
          <div className={styles.setupPromise}>
            <Text size={200}>This step unlocks</Text>
            <strong>{setupStepDefinitions[currentSetupStep].promise}</strong>
          </div>
          {currentSetupStep === 'welcome' && (
            <>
              <Title2 as="h2">Welcome</Title2>
              <Text>
                Balance Book works locally without a bank connection. This short setup creates a
                forecast measured against your global protected minimum; it is a model rather than a
                guarantee. You can add more accounts and detailed records afterward.
              </Text>
              <Field validationMessage={form.formState.errors.localDataConsent?.message}>
                <Checkbox
                  checked={watchedSetupValues.localDataConsent === 'accepted'}
                  label="I consent to Balance Book storing the financial information I enter locally on this Windows device."
                  onChange={(_event, data) =>
                    form.setValue('localDataConsent', data.checked === true ? 'accepted' : '', {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                />
              </Field>
              <Text size={200}>
                Balance Book has no bank connection, advertising, analytics, telemetry, or cloud
                account. Data leaves the app only when you choose an export, encrypted backup, or
                external link. The app password is not a substitute for Windows device security.
              </Text>
              <div className={styles.actions}>
                <Button
                  type="button"
                  appearance="subtle"
                  onClick={() => void window.balanceBook.openPrivacyPolicy()}
                >
                  Read privacy policy
                </Button>
              </div>
            </>
          )}
          {currentSetupStep === 'fit' && (
            <>
              <Title2 as="h2">Which parts fit your finances?</Title2>
              <Text>
                Six quick answers keep the app focused. Choose No to hide a section; nothing is
                deleted, and you can turn it on later from searchable Settings.
              </Text>
              <div className={styles.applicabilityGrid}>
                {applicabilityQuestions.map(applicabilityQuestion)}
              </div>
            </>
          )}
          {currentSetupStep === 'cash' && (
            <>
              <Title2 as="h2">Cash account</Title2>
              <Text>Enter a dated balance so the forecast has a clear starting point.</Text>
              <div className={styles.formGrid}>
                {field('balanceAsOf', 'Balance as of', 'date')}
                {field('accountName', 'Account name')}
                {field('openingBalance', 'Opening balance')}
              </div>
            </>
          )}
          {currentSetupStep === 'income' && (
            <>
              <Title2 as="h2">One upcoming deposit (optional)</Title2>
              <Text>
                This quick step records one deposit into the starter account. If a paycheck splits
                across accounts or arrives early, leave this blank and use Income and raises after
                adding those accounts; there you enter one official payday and preview every actual
                deposit before saving.
              </Text>
              <div className={styles.formGrid}>
                {field('incomeLabel', 'Deposit source')}
                {field('incomeDate', 'Deposit date', 'date')}
                {field('incomeAmount', 'Net deposit amount')}
              </div>
            </>
          )}
          {currentSetupStep === 'bill' && (
            <>
              <Title2 as="h2">One upcoming bill (optional)</Title2>
              <Text>
                This quick step records one bill paid directly from the starter cash account. Leave
                the whole step blank if you do not want to add a bill yet.
              </Text>
              <div className={styles.formGrid}>
                {field('commitmentLabel', 'Bill name')}
                {field('commitmentDate', 'Payment date', 'date')}
                {field('commitmentAmount', 'Amount')}
              </div>
            </>
          )}
          {currentSetupStep === 'cards' && (
            <>
              <Title2 as="h2">Credit card (optional)</Title2>
              <Text>
                Add truthful card terms only. The next checklist will ask for the closed statement
                coming due and the separate open cycle; no statement history is invented here. Leave
                the whole step blank if you do not use a card.
              </Text>
              <Text>
                Automatic policies need both timing days. Choose whether the forecast pays the full
                statement, a minimum, or a fixed amount. Manual leaves future payments for you to
                enter explicitly.
              </Text>
              <div className={styles.formGrid}>
                {field('cardName', 'Card name')}
                {field('cardEstimate', 'Typical future statement')}
                {field(
                  'cardStatementCloseDay',
                  'Statement closes on day (optional for manual payments)',
                  'number',
                )}
                {field(
                  'cardPaymentDay',
                  'Payment happens on day (optional for manual payments)',
                  'number',
                )}
                <Field
                  label="Open-cycle estimate policy"
                  validationMessage={form.formState.errors.cardEstimatePolicy?.message}
                >
                  <Select disabled={isExitingSetup} {...form.register('cardEstimatePolicy')}>
                    <option value="">Choose a policy</option>
                    <option value="baseline-guardrail">Use at least the typical statement</option>
                    <option value="actual-reset">Use entered activity</option>
                  </Select>
                </Field>
                <Field
                  label="Payment policy"
                  validationMessage={form.formState.errors.cardPaymentPolicy?.message}
                >
                  <Select disabled={isExitingSetup} {...form.register('cardPaymentPolicy')}>
                    <option value="">Choose a policy</option>
                    <option value="full-statement">Pay full statement</option>
                    <option value="minimum">Pay a minimum amount</option>
                    <option value="fixed">Pay a fixed amount</option>
                    <option value="manual">Enter each payment manually</option>
                  </Select>
                </Field>
                {watchedSetupValues.cardPaymentPolicy === 'minimum' && (
                  <Field
                    label="Minimum payment amount"
                    validationMessage={form.formState.errors.cardMinimumPayment?.message}
                  >
                    <Input
                      inputMode="decimal"
                      disabled={isExitingSetup}
                      {...form.register('cardMinimumPayment')}
                    />
                  </Field>
                )}
                {watchedSetupValues.cardPaymentPolicy === 'fixed' && (
                  <Field
                    label="Fixed payment amount"
                    validationMessage={form.formState.errors.cardFixedPayment?.message}
                  >
                    <Input
                      inputMode="decimal"
                      disabled={isExitingSetup}
                      {...form.register('cardFixedPayment')}
                    />
                  </Field>
                )}
              </div>
            </>
          )}
          {currentSetupStep === 'minimums' && (
            <>
              <Title2 as="h2">Global minimum and buffer</Title2>
              <Text>
                The global protected minimum is the lowest consolidated cash balance you plan
                around. The preferred buffer is a separate comfort target.
              </Text>
              <div className={styles.formGrid}>
                {field('hardFloor', 'Global protected minimum')}
                {field('preferredFloor', 'Preferred buffer')}
              </div>
            </>
          )}
          {currentSetupStep === 'review' && (
            <>
              <Title2 as="h2">Review first forecast</Title2>
              <p>
                <strong>{watchedSetupValues.accountName}</strong> starts at{' '}
                {watchedSetupValues.openingBalance} as of {watchedSetupValues.balanceAsOf}.
                {watchedSetupValues.usesIncome === 'yes' && watchedSetupValues.incomeLabel
                  ? ` A deposit of ${watchedSetupValues.incomeAmount} is expected on ${watchedSetupValues.incomeDate}.`
                  : ' No deposit is being added in this first pass.'}
                {watchedSetupValues.usesBills === 'yes' && watchedSetupValues.commitmentLabel
                  ? ` The bill is ${watchedSetupValues.commitmentAmount} on ${watchedSetupValues.commitmentDate}.`
                  : ' No bill is being added in this first pass.'}
                {watchedSetupValues.usesCreditCards === 'yes' && watchedSetupValues.cardName
                  ? watchedSetupValues.cardStatementCloseDay && watchedSetupValues.cardPaymentDay
                    ? ` ${watchedSetupValues.cardName} uses a typical statement of ${watchedSetupValues.cardEstimate}, closes on day ${watchedSetupValues.cardStatementCloseDay}, and pays on day ${watchedSetupValues.cardPaymentDay}. Forecast payment policy: ${watchedSetupValues.cardPaymentPolicy === 'full-statement' ? 'full statement' : watchedSetupValues.cardPaymentPolicy === 'minimum' ? `minimum of ${watchedSetupValues.cardMinimumPayment}` : watchedSetupValues.cardPaymentPolicy === 'fixed' ? `fixed amount of ${watchedSetupValues.cardFixedPayment}` : 'manual'}. Its actual statement and current cycle will be added next.`
                    : ` ${watchedSetupValues.cardName} uses a typical statement of ${watchedSetupValues.cardEstimate} with payments entered manually. No statement-close or payment dates were inferred. Its actual statement and current cycle can be added next.`
                  : ' No card is being added in this first pass.'}
              </p>
              <Text>
                Global protected minimum: {watchedSetupValues.hardFloor} · preferred buffer:{' '}
                {watchedSetupValues.preferredFloor || 'not set'}. All values remain editable after
                confirmation.
              </Text>
            </>
          )}
          <div className={styles.actions}>
            {currentSetupStepIndex > 0 && (
              <Button
                type="button"
                disabled={isExitingSetup}
                onClick={() => setStep(currentSetupStepIndex - 1)}
              >
                Back
              </Button>
            )}
            {currentSetupStep !== 'review' ? (
              <Button
                type="button"
                appearance="primary"
                disabled={isExitingSetup}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void continueSetup();
                }}
              >
                Continue
              </Button>
            ) : (
              <Button
                type="submit"
                appearance="primary"
                disabled={form.formState.isSubmitting || isExitingSetup}
              >
                {form.formState.isSubmitting ? 'Saving…' : 'Save first forecast and continue'}
              </Button>
            )}
            <Button
              type="button"
              disabled={isExitingSetup || form.formState.isSubmitting}
              onClick={() => void exitSetup()}
            >
              {isExitingSetup ? 'Saving latest draft...' : 'Exit setup — save draft'}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
};

const ScenarioPage = (): React.JSX.Element => {
  const styles = useStyles();
  const today = Temporal.Now.plainDateISO();
  const form = useForm<ScenarioValues>({
    resolver: zodResolver(scenarioSchema),
    defaultValues: {
      description: '',
      amount: '',
      settlementDate: today.toString(),
    },
  });
  const [result, setResult] = useState<ScenarioResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [evaluatedScenario, setEvaluatedScenario] = useState<ScenarioValues | null>(null);
  const [fundingType, setFundingType] = useState<'cash' | 'card'>('cash');
  const [accountId, setAccountId] = useState('');
  const [cardId, setCardId] = useState('');
  const [evaluatedFunding, setEvaluatedFunding] = useState<{
    fundingType: 'cash' | 'card';
    accountId: string;
    cardId?: string;
    cardName?: string;
    purchaseDate?: string;
  } | null>(null);
  const [evaluatedInputKey, setEvaluatedInputKey] = useState<string | null>(null);
  const [savedEvaluationKey, setSavedEvaluationKey] = useState<string | null>(null);
  const [scenarioAction, setScenarioAction] = useState<string | null>(null);
  const [scenarioActionLock] = useState(createImmediateActionLock);
  const [records, setRecords] = useState<ManagedRecordsDto | null>(null);
  const watchedScenarioValues = useWatch({ control: form.control });
  const currentEvaluationKey = scenarioEvaluationKey(watchedScenarioValues, {
    fundingType,
    accountId,
    cardId,
  });
  const scenarioControlsBusy = form.formState.isSubmitting || scenarioAction !== null;
  useEffect(() => {
    void window.balanceBook
      .listRecords()
      .then((response) => {
        if (!response.ok) throw new Error(response.error);
        setRecords(response.value);
        setAccountId((current) => current || response.value.accounts[0]?.id || '');
        setCardId((current) => current || response.value.cards[0]?.id || '');
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, []);
  if (!records)
    return error ? (
      <Card className={styles.panel}>
        <Title1 as="h1">Purchase planner could not be loaded</Title1>
        <div role="alert" className={styles.error}>
          {error}
        </div>
      </Card>
    ) : (
      <LoadingSkeleton label="Loading purchase planner" variant="form" />
    );
  const invalidateScenarioEvaluation = (): void => {
    if (evaluatedInputKey === null) return;
    setResult(null);
    setEvaluatedScenario(null);
    setEvaluatedFunding(null);
    setEvaluatedInputKey(null);
    setSavedMessage(null);
  };
  const beginScenarioAction = (action: string): boolean => {
    if (!scenarioActionLock.acquire(action)) return false;
    setScenarioAction(action);
    setError(null);
    setSavedMessage(null);
    return true;
  };
  const finishScenarioAction = (action: string): void => {
    if (scenarioActionLock.active() !== action) return;
    scenarioActionLock.release(action);
    setScenarioAction(null);
  };
  const submit = form.handleSubmit(async (values) => {
    const action = 'evaluate-scenario';
    if (!beginScenarioAction(action)) return;
    setError(null);
    setSavedMessage(null);
    setResult(null);
    setEvaluatedScenario(null);
    setEvaluatedFunding(null);
    setEvaluatedInputKey(null);
    const requestedFunding = { fundingType, accountId, cardId };
    const requestedEvaluationKey = scenarioEvaluationKey(values, requestedFunding);
    setSavedEvaluationKey((savedKey) => (savedKey === requestedEvaluationKey ? savedKey : null));
    try {
      const response = await window.balanceBook.evaluateScenario({
        description: values.description,
        amountCents: dollarsToCents(values.amount),
        settlementDate: values.settlementDate,
        fundingType: requestedFunding.fundingType,
        forecastMode: 'conservative',
        accountId: requestedFunding.fundingType === 'cash' ? requestedFunding.accountId : undefined,
        cardId: requestedFunding.fundingType === 'card' ? requestedFunding.cardId : undefined,
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      const selectedCard = records.cards.find((card) => card.id === requestedFunding.cardId);
      setResult(response.value);
      setEvaluatedScenario({ ...values });
      setEvaluatedFunding({
        fundingType: requestedFunding.fundingType,
        accountId:
          requestedFunding.fundingType === 'card'
            ? (selectedCard?.fundingAccountId ?? '')
            : requestedFunding.accountId,
        cardId: requestedFunding.fundingType === 'card' ? selectedCard?.id : undefined,
        cardName: requestedFunding.fundingType === 'card' ? selectedCard?.name : undefined,
        purchaseDate: requestedFunding.fundingType === 'card' ? values.settlementDate : undefined,
      });
      setEvaluatedInputKey(requestedEvaluationKey);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  });
  const saveScenario = async () => {
    if (
      !evaluatedScenario ||
      !evaluatedFunding ||
      !result ||
      !evaluatedInputKey ||
      evaluatedInputKey !== currentEvaluationKey ||
      savedEvaluationKey === evaluatedInputKey
    )
      return;
    const action = 'save-evaluated-scenario';
    if (!beginScenarioAction(action)) return;
    const scenarioSnapshot = { ...evaluatedScenario };
    const fundingSnapshot = { ...evaluatedFunding };
    const resultSnapshot = result;
    const evaluationKeySnapshot = evaluatedInputKey;
    try {
      const recordsResponse = await window.balanceBook.listRecords();
      if (!recordsResponse.ok) {
        setError(recordsResponse.error);
        return;
      }
      const account = recordsResponse.value.accounts.find(
        (candidate) => candidate.id === fundingSnapshot.accountId,
      );
      if (!account) {
        setError('Add a cash account before saving a scenario.');
        return;
      }
      const response = await window.balanceBook.upsertRecord({
        entityType: 'saved-scenario',
        payload: {
          id: crypto.randomUUID(),
          description: scenarioSnapshot.description,
          amountCents: dollarsToCents(scenarioSnapshot.amount),
          settlementDate: resultSnapshot.settlementDate,
          accountId: account.id,
          fundingType: fundingSnapshot.fundingType,
          cardId: fundingSnapshot.cardId,
          purchaseDate: fundingSnapshot.purchaseDate,
          status: 'saved',
          notes: fundingSnapshot.cardName
            ? `Card-funded through ${fundingSnapshot.cardName}; purchase date ${scenarioSnapshot.settlementDate}, cash settlement ${resultSnapshot.settlementDate}.`
            : undefined,
        },
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setSavedEvaluationKey(evaluationKeySnapshot);
      setRecords(response.value);
      setSavedMessage('Scenario saved locally for this profile.');
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  type SavedScenario = ManagedRecordsDto['savedScenarios'][number];
  const saveScenarioRecord = async (scenario: SavedScenario, status: SavedScenario['status']) => {
    const action = `update-scenario:${scenario.id}`;
    if (!beginScenarioAction(action)) return;
    try {
      const response = await window.balanceBook.upsertRecord({
        entityType: 'saved-scenario',
        payload: {
          id: scenario.id,
          description: scenario.description,
          amountCents: scenario.amountCents,
          settlementDate: scenario.settlementDate,
          accountId: scenario.accountId,
          fundingType: scenario.fundingType,
          cardId: scenario.cardId,
          purchaseDate: scenario.purchaseDate,
          status,
          notes: scenario.notes,
        },
      });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setSavedMessage(
        status === 'archived'
          ? 'Scenario archived.'
          : status === 'accepted'
            ? 'Scenario accepted for combined comparison.'
            : 'Scenario returned to saved comparisons.',
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  const evaluateSavedScenarios = async (scenarioIds: string[]) => {
    const action = 'evaluate-saved-scenarios';
    if (!beginScenarioAction(action)) return;
    try {
      const response = await window.balanceBook.evaluateCombinedScenarios({ scenarioIds });
      if (!response.ok) throw new Error(response.error);
      setResult(response.value);
      setEvaluatedScenario(null);
      setEvaluatedFunding(null);
      setEvaluatedInputKey(null);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  const duplicateScenario = async (scenario: SavedScenario) => {
    const action = `duplicate-scenario:${scenario.id}`;
    if (!beginScenarioAction(action)) return;
    try {
      const response = await window.balanceBook.upsertRecord({
        entityType: 'saved-scenario',
        payload: {
          id: crypto.randomUUID(),
          description: `${scenario.description} (copy)`,
          amountCents: scenario.amountCents,
          settlementDate: scenario.settlementDate,
          accountId: scenario.accountId,
          fundingType: scenario.fundingType,
          cardId: scenario.cardId,
          purchaseDate: scenario.purchaseDate,
          status: 'saved',
          notes: scenario.notes,
        },
      });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setSavedMessage('Scenario duplicated once.');
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  const convertScenario = async (scenario: SavedScenario) => {
    const action = `convert-scenario:${scenario.id}`;
    if (!beginScenarioAction(action)) return;
    const destination =
      scenario.fundingType === 'card'
        ? 'planned card activity on its purchase date'
        : 'a real planned cash commitment';
    try {
      if (!window.confirm(`Convert this scenario into ${destination}?`)) return;
      const response = await window.balanceBook.convertScenario({ scenarioId: scenario.id });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setSavedMessage(
        scenario.fundingType === 'card'
          ? "Scenario converted into card activity; its payment now follows that card's live cycle and payment policy."
          : 'Scenario converted transactionally into a forecast commitment.',
      );
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  const deleteScenario = async (scenario: SavedScenario) => {
    const action = `delete-scenario:${scenario.id}`;
    if (!beginScenarioAction(action)) return;
    try {
      if (!window.confirm('Permanently delete this saved scenario?')) return;
      const response = await window.balanceBook.deleteRecord({
        entityType: 'saved-scenario',
        entityId: scenario.id,
        confirmed: true,
      });
      if (!response.ok) throw new Error(response.error);
      setRecords(response.value);
      setSavedMessage('Scenario deleted.');
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      finishScenarioAction(action);
    }
  };
  const displayedResult =
    evaluatedInputKey === null || evaluatedInputKey === currentEvaluationKey ? result : null;
  const verdict = displayedResult?.verdict.replaceAll('-', ' ');
  const canSaveEvaluatedScenario =
    displayedResult !== null &&
    evaluatedScenario !== null &&
    evaluatedFunding !== null &&
    evaluatedInputKey !== null &&
    savedEvaluationKey !== evaluatedInputKey;
  return (
    <>
      <div className={styles.pageHeader}>
        <Title1 as="h1">Can I afford this?</Title1>
        <Text>
          Enter when you would make the purchase. For a card, Balance Book assigns the statement
          cycle and future cash-payment date automatically.
        </Text>
      </div>
      <Card className={styles.panel}>
        <form
          className={styles.form}
          aria-busy={scenarioControlsBusy}
          onChange={invalidateScenarioEvaluation}
          onSubmit={submit}
          noValidate
        >
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          <Field label="Description" validationMessage={form.formState.errors.description?.message}>
            <Input disabled={scenarioControlsBusy} {...form.register('description')} />
          </Field>
          <div className={styles.formGrid}>
            <Field label="Amount" validationMessage={form.formState.errors.amount?.message}>
              <Input
                disabled={scenarioControlsBusy}
                inputMode="decimal"
                {...form.register('amount')}
              />
            </Field>
            <Field
              label={fundingType === 'card' ? 'Purchase date' : 'Cash payment date'}
              validationMessage={form.formState.errors.settlementDate?.message}
            >
              <Input
                type="date"
                disabled={scenarioControlsBusy}
                {...form.register('settlementDate')}
              />
            </Field>
            <Field label="Payment method">
              <Select
                disabled={scenarioControlsBusy}
                value={fundingType}
                onChange={(_, data) => setFundingType(data.value as 'cash' | 'card')}
              >
                <option value="cash">Cash account</option>
                <option value="card" disabled={(records?.cards.length ?? 0) === 0}>
                  Credit card
                </option>
              </Select>
            </Field>
            {fundingType === 'cash' ? (
              <Field label="Funding account">
                <Select
                  disabled={scenarioControlsBusy}
                  value={accountId}
                  onChange={(_, data) => setAccountId(data.value)}
                >
                  {(records?.accounts ?? []).map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Card to use">
                <Select
                  disabled={scenarioControlsBusy}
                  value={cardId}
                  onChange={(_, data) => setCardId(data.value)}
                >
                  {(records?.cards ?? []).map((card) => (
                    <option value={card.id} key={card.id}>
                      {card.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {fundingType === 'card' && (
            <Text>
              Choose the card you would actually use. Balance Book assigns the purchase to that
              card&apos;s open cycle and scheduled payment date; you do not need to calculate the
              cash date yourself.
            </Text>
          )}
          <Button type="submit" appearance="primary" disabled={scenarioControlsBusy}>
            {scenarioAction === 'evaluate-scenario' ? 'Evaluating…' : 'Evaluate purchase'}
          </Button>
        </form>
      </Card>
      {displayedResult && (
        <Card className={styles.panel} aria-live="polite">
          <Title2 as="h2">Result: {verdict}</Title2>
          <p>
            Cash settlement date: <strong>{displayedResult.settlementDate}</strong>
          </p>
          {displayedResult.cardName && evaluatedScenario && (
            <>
              <p>
                Purchase date: <strong>{evaluatedScenario.settlementDate}</strong>
              </p>
              {displayedResult.baselineCardPaymentCents !== undefined &&
                displayedResult.afterPurchaseCardPaymentCents !== undefined &&
                displayedResult.incrementalCashPaymentCents !== undefined && (
                  <p>
                    Scheduled card payment changes from{' '}
                    <strong>{formatMoney(displayedResult.baselineCardPaymentCents)}</strong> to{' '}
                    <strong>{formatMoney(displayedResult.afterPurchaseCardPaymentCents)}</strong>.
                    This purchase adds{' '}
                    <strong>{formatMoney(displayedResult.incrementalCashPaymentCents)}</strong> to
                    cash due on the settlement date.
                  </p>
                )}
            </>
          )}
          <p>
            Payment instrument:{' '}
            <strong>
              {displayedResult.cardName ? `Card: ${displayedResult.cardName}` : 'Cash account'}
            </strong>{' '}
            · funding account: <strong>{displayedResult.fundingAccountName}</strong>
          </p>
          <p>
            Conservative low changes from{' '}
            <strong>{formatMoney(displayedResult.beforeTroughCents)}</strong> to{' '}
            <strong>{formatMoney(displayedResult.afterTroughCents)}</strong>.
          </p>
          <p>
            Margin above the global protected minimum after purchase:{' '}
            <strong
              className={
                displayedResult.afterHardFloorMarginCents < 0 ? styles.error : styles.positive
              }
            >
              {formatMoney(displayedResult.afterHardFloorMarginCents)}
            </strong>
            .
          </p>
          <p>
            Available to deploy after purchase:{' '}
            <strong>{formatMoney(displayedResult.afterAvailableToDeployCents)}</strong>.
          </p>
          <p>
            Underfunded accounts: <strong>{displayedResult.accountShortfallCount}</strong>.
          </p>
          {displayedResult.transferNeeds.length > 0 && (
            <div className={styles.form}>
              <Subtitle1>Funding actions for this result</Subtitle1>
              {displayedResult.transferNeeds.map((need) => {
                const actionable = need.sourceAccountId && need.initiationDate && need.arrivalDate;
                return (
                  <Card className={styles.metric} key={need.accountId}>
                    <Text>
                      {actionable ? (
                        <>
                          Move <strong>{formatMoney(need.shortfallCents)}</strong> from{' '}
                          <strong>{need.sourceAccountName}</strong> to{' '}
                          <strong>{need.accountName}</strong> on{' '}
                          <strong>{need.initiationDate}</strong>; arrival {need.arrivalDate}, needed
                          by {need.date}.
                        </>
                      ) : (
                        <>
                          {need.accountName} needs{' '}
                          <strong>{formatMoney(need.shortfallCents)}</strong> by {need.date}, but no
                          other account can safely fund it under current minimums.
                        </>
                      )}
                    </Text>
                    {actionable && (
                      <Button
                        onClick={() => {
                          const parameters = new URLSearchParams({
                            source: need.sourceAccountId!,
                            destination: need.accountId,
                            amountCents: String(need.shortfallCents),
                            initiation: need.initiationDate!,
                            arrival: need.arrivalDate!,
                          });
                          window.location.hash = `#/baseline?${parameters.toString()}`;
                        }}
                      >
                        Prefill transfer
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
          {savedMessage && (
            <div className={styles.positive} role="status">
              {savedMessage}
            </div>
          )}
          {evaluatedScenario && evaluatedFunding && evaluatedInputKey && (
            <Button
              appearance="primary"
              disabled={!canSaveEvaluatedScenario || scenarioControlsBusy}
              onClick={() => void saveScenario()}
            >
              {scenarioAction === 'save-evaluated-scenario'
                ? 'Saving scenario...'
                : savedEvaluationKey === evaluatedInputKey
                  ? 'Scenario saved'
                  : 'Save this scenario'}
            </Button>
          )}
        </Card>
      )}
      {records && records.savedScenarios.length > 0 && (
        <Card className={styles.panel}>
          <Title2 as="h2">Saved comparisons</Title2>
          <Text>
            Saved and accepted items remain hypothetical until you explicitly convert one into a
            forecast commitment.
          </Text>
          <div className={styles.actions}>
            {records.savedScenarios.filter((scenario) => scenario.status !== 'archived').length >
              1 && (
              <Button
                appearance="primary"
                disabled={scenarioControlsBusy}
                onClick={() =>
                  void evaluateSavedScenarios(
                    records.savedScenarios
                      .filter((scenario) => scenario.status !== 'archived')
                      .map((scenario) => scenario.id),
                  )
                }
              >
                Evaluate all active together
              </Button>
            )}
          </div>
          {records.savedScenarios.map((scenario) => (
            <Card key={scenario.id} className={styles.metric}>
              <Subtitle1>{scenario.description}</Subtitle1>
              <Text>
                {scenario.fundingType === 'card' ? (
                  <>
                    {formatMoney(scenario.amountCents)} card purchase on {scenario.purchaseDate} ·
                    modeled cash payment {scenario.settlementDate} · {scenario.status}
                  </>
                ) : (
                  <>
                    {formatMoney(scenario.amountCents)} cash payment on {scenario.settlementDate} ·{' '}
                    {scenario.status}
                  </>
                )}
              </Text>
              <div className={styles.actions}>
                {scenario.status !== 'archived' && (
                  <>
                    <Button
                      disabled={scenarioControlsBusy}
                      onClick={() => void evaluateSavedScenarios([scenario.id])}
                    >
                      Evaluate
                    </Button>
                    <Button
                      disabled={scenarioControlsBusy}
                      onClick={() =>
                        void saveScenarioRecord(
                          scenario,
                          scenario.status === 'accepted' ? 'saved' : 'accepted',
                        )
                      }
                    >
                      {scenario.status === 'accepted' ? 'Return to saved' : 'Accept together'}
                    </Button>
                    <Button
                      disabled={scenarioControlsBusy}
                      onClick={() => void convertScenario(scenario)}
                    >
                      Convert to commitment
                    </Button>
                    <Button
                      disabled={scenarioControlsBusy}
                      onClick={() => void saveScenarioRecord(scenario, 'archived')}
                    >
                      Archive
                    </Button>
                  </>
                )}
                <Button
                  disabled={scenarioControlsBusy}
                  onClick={() => void duplicateScenario(scenario)}
                >
                  Duplicate
                </Button>
                <Button
                  disabled={scenarioControlsBusy}
                  onClick={() => void deleteScenario(scenario)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </Card>
      )}
    </>
  );
};

export const App = (): React.JSX.Element => {
  const styles = useStyles();
  const systemDark = useSystemDark();
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<ProfileSummaryDto[]>([]);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([window.balanceBook.listProfiles(), window.balanceBook.getSession()])
      .then(([profileResult, sessionResult]) => {
        if (!profileResult.ok) throw new Error(profileResult.error);
        if (!sessionResult.ok) throw new Error(sessionResult.error);
        setProfiles(profileResult.value);
        setSession(sessionResult.value);
      })
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  }, []);

  const themePreference = session?.themePreference;
  const resolvedDark = useMemo(
    () =>
      themePreference === undefined ||
      themePreference === 'dark' ||
      (themePreference === 'system' && systemDark),
    [systemDark, themePreference],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedDark ? 'dark' : 'light';
  }, [resolvedDark]);

  useEffect(() => {
    document.documentElement.dataset.density = session?.preferences.compactLayout
      ? 'compact'
      : 'comfortable';
    document.documentElement.dataset.reduceMotion = session?.preferences.reduceMotion
      ? 'true'
      : 'false';
  }, [session?.preferences.compactLayout, session?.preferences.reduceMotion]);

  const logout = async () => {
    await window.balanceBook.logout();
    setSession(null);
    const result = await window.balanceBook.listProfiles();
    if (result.ok) setProfiles(result.value);
  };

  return (
    <FluentProvider theme={resolvedDark ? balanceBookDarkTheme : balanceBookLightTheme}>
      <NativeMenuHoverEdge />
      {loading ? (
        <LoadingSkeleton label="Opening Balance Book" variant="launch" />
      ) : error ? (
        <div className={styles.authPage}>
          <Card className={styles.authPanel}>
            <Title1>Balance Book could not open</Title1>
            <div role="alert" className={styles.error}>
              {error}
            </div>
          </Card>
        </div>
      ) : !session ? (
        <ProfileAccess profiles={profiles} onSession={setSession} />
      ) : (
        <HashRouter>
          <AppShell
            session={session}
            systemDark={systemDark}
            darkMode={resolvedDark}
            onSession={setSession}
            onLogout={() => void logout()}
          />
        </HashRouter>
      )}
    </FluentProvider>
  );
};
