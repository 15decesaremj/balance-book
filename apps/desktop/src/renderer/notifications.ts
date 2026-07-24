import { Temporal } from '@js-temporal/polyfill';
import type {
  ForecastSnapshotDto,
  ManagedRecordsDto,
  NotificationPresentationDto,
} from '../shared/contracts';
import { buildAccountPositionReadModel, buildCardPositionReadModel } from './financial-read-models';
import { formatMoney } from './utils';

export type FinancialNotificationSection = 'needs-action' | 'updates';
export type FinancialNotificationAction =
  | 'confirm-account-balance'
  | 'confirm-card-balance'
  | 'confirm-card-payment'
  | 'confirm-expected-event'
  | 'receive-money-owed'
  | 'open';

export interface FinancialNotification {
  id: string;
  fingerprint: string;
  section: FinancialNotificationSection;
  title: string;
  subject: string;
  explanation: string;
  amountCents?: number;
  date?: string;
  primaryActionLabel: string;
  primaryAction: FinancialNotificationAction;
  openPath?: string;
  entityId?: string;
  fundingAccountId?: string;
  unread: boolean;
}

const addDays = (date: string, days: number): string =>
  Temporal.PlainDate.from(date).add({ days }).toString();

const presentationFor = (
  presentations: NotificationPresentationDto[],
  notificationId: string,
): NotificationPresentationDto | undefined =>
  presentations.find((presentation) => presentation.notificationId === notificationId);

const fingerprint = (...parts: Array<string | number | undefined>): string => {
  const source = parts.map((part) => String(part ?? '')).join('|');
  let first = 2_166_136_261;
  let second = 5381;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return `v2:${source.length}:${first.toString(16)}:${second.toString(16)}`;
};

const finalize = (
  notifications: Omit<FinancialNotification, 'unread'>[],
  presentations: NotificationPresentationDto[],
  now: string,
): FinancialNotification[] => {
  const deduplicated = new Map<string, Omit<FinancialNotification, 'unread'>>();
  for (const notification of notifications) deduplicated.set(notification.id, notification);
  return [...deduplicated.values()]
    .filter((notification) => {
      const presentation = presentationFor(presentations, notification.id);
      const applies = presentation?.conditionFingerprint === notification.fingerprint;
      if (!applies) return true;
      if (
        notification.section === 'updates' &&
        presentation?.snoozedUntil &&
        presentation.snoozedUntil > now
      ) {
        return false;
      }
      return !(notification.section === 'updates' && presentation?.dismissedAt);
    })
    .map((notification) => ({
      ...notification,
      unread:
        presentationFor(presentations, notification.id)?.conditionFingerprint !==
          notification.fingerprint || !presentationFor(presentations, notification.id)?.readAt,
    }))
    .sort((left, right) => {
      const section = Number(left.section === 'updates') - Number(right.section === 'updates');
      if (section !== 0) return section;
      return (
        (left.date ?? '').localeCompare(right.date ?? '') || left.title.localeCompare(right.title)
      );
    });
};

export const unresolvedNotificationCount = (notifications: FinancialNotification[]): number =>
  notifications.filter((notification) => notification.section === 'needs-action').length;

export const generateFinancialNotifications = (input: {
  snapshot: ForecastSnapshotDto;
  records: ManagedRecordsDto;
  presentations?: NotificationPresentationDto[];
  today: string;
  now?: string;
  staleAfterDays?: number;
}): FinancialNotification[] => {
  const {
    snapshot,
    records,
    presentations = [],
    today,
    now = `${today}T12:00:00.000Z`,
    staleAfterDays = 14,
  } = input;
  const notifications: Omit<FinancialNotification, 'unread'>[] = [];

  for (const account of snapshot.cashAccounts ?? []) {
    const position = buildAccountPositionReadModel(account, staleAfterDays);
    if (position.freshness !== 'stale') continue;
    notifications.push({
      id: `stale-account:${account.id}`,
      fingerprint: fingerprint(
        account.id,
        position.sourceBalanceDate,
        position.sourceBalanceCents,
        position.calculatedBalanceCents,
      ),
      section: 'needs-action',
      title: 'Refresh cash balance',
      subject: account.name,
      explanation: `Source balance is ${position.sourceAgeDays} days old; net activity since then is ${formatMoney(position.postSourceChangeCents)}.`,
      amountCents: position.calculatedBalanceCents,
      date: position.calculatedThroughDate,
      primaryActionLabel: 'Confirm calculated balance',
      primaryAction: 'confirm-account-balance',
      openPath: `/?detail=account:${encodeURIComponent(account.id)}`,
      entityId: account.id,
    });
  }

  const cardById = new Map(records.cards.map((card) => [card.id, card]));
  for (const debt of snapshot.revolvingDebtByCard ?? []) {
    const card = cardById.get(debt.cardId);
    if (!card) continue;
    const position = buildCardPositionReadModel(debt, staleAfterDays);
    if (position.freshness === 'stale') {
      notifications.push({
        id: `stale-card:${card.id}`,
        fingerprint: fingerprint(
          card.id,
          position.sourceBalanceDate,
          position.sourceBalanceCents,
          position.calculatedBalanceCents,
        ),
        section: 'needs-action',
        title: 'Refresh card balance',
        subject: card.name,
        explanation: `Issuer balance is ${position.sourceAgeDays} days old; current calculated debt is ready to review.`,
        amountCents: position.calculatedBalanceCents,
        date: position.calculatedThroughDate,
        primaryActionLabel: 'Confirm calculated balance',
        primaryAction: 'confirm-card-balance',
        openPath: `/?detail=card:${encodeURIComponent(card.id)}`,
        entityId: card.id,
      });
    }
  }

  for (const power of snapshot.cardSpendingPower ?? []) {
    if (
      power.spendingPowerStatus === 'determinate' ||
      power.spendingPowerStatus === 'conditional-existing-shortfall'
    ) {
      continue;
    }
    notifications.push({
      id: `card-answer-missing:${power.cardId}`,
      fingerprint: fingerprint(power.cardId, power.spendingPowerStatus),
      section: 'needs-action',
      title: 'Card answer needs information',
      subject: power.cardName,
      explanation:
        'Payment policy, statement timing, or funding-account data prevents a reliable safe-spend answer.',
      primaryActionLabel: 'Finish card setup',
      primaryAction: 'open',
      openPath: `/cards?card=${encodeURIComponent(power.cardId)}&focus=setup`,
      entityId: power.cardId,
    });
  }

  const threeDaysOut = addDays(today, 3);
  for (const cycle of records.cardCycles) {
    if (
      cycle.state !== 'scheduled-payment' ||
      cycle.actualPaymentCents !== undefined ||
      !cycle.lockedStatementCents ||
      cycle.dueOn > threeDaysOut
    ) {
      continue;
    }
    const card = cardById.get(cycle.cardId);
    if (!card) continue;
    const paymentDate = cycle.paymentOn ?? cycle.dueOn;
    const canConfirmNow = paymentDate <= today;
    notifications.push({
      id: `card-payment:${cycle.id}`,
      fingerprint: fingerprint(
        cycle.id,
        cycle.state,
        cycle.lockedStatementCents,
        paymentDate,
        card.fundingAccountId,
      ),
      section: 'needs-action',
      title: canConfirmNow ? 'Confirm scheduled card payment' : 'Card payment is approaching',
      subject: card.name,
      explanation: canConfirmNow
        ? 'Confirm only after the displayed payment has left the selected account.'
        : 'Review the locked amount and funding account before the payment date.',
      amountCents: cycle.lockedStatementCents,
      date: paymentDate,
      primaryActionLabel: canConfirmNow ? 'Confirm payment' : 'Review payment',
      primaryAction: canConfirmNow ? 'confirm-card-payment' : 'open',
      openPath: `/cards?card=${encodeURIComponent(card.id)}&focus=payment`,
      entityId: cycle.id,
      fundingAccountId: card.fundingAccountId,
    });
  }

  for (const receivable of records.receivables) {
    if (receivable.remainingAmountCents <= 0 || receivable.expectedDate > today) continue;
    notifications.push({
      id: `receivable-ready:${receivable.id}`,
      fingerprint: fingerprint(
        receivable.id,
        receivable.remainingAmountCents,
        receivable.expectedDate,
        receivable.destinationAccountId,
      ),
      section: 'needs-action',
      title: 'Money is ready to receive',
      subject: receivable.source,
      explanation: receivable.description,
      amountCents: receivable.remainingAmountCents,
      date: today,
      primaryActionLabel: 'Receive money',
      primaryAction: 'receive-money-owed',
      openPath: `/receivables?receivable=${encodeURIComponent(receivable.id)}&focus=release`,
      entityId: receivable.id,
      fundingAccountId: receivable.destinationAccountId,
    });
  }

  for (const event of records.events) {
    if (
      event.date > today ||
      event.recurrenceRule ||
      event.hypothetical ||
      event.status === 'confirmed' ||
      event.status === 'paid' ||
      event.status === 'cancelled' ||
      event.status === 'skipped' ||
      event.kind === 'transfer-debit' ||
      event.kind === 'transfer-credit' ||
      event.kind === 'card-payment' ||
      event.kind === 'loan-payment' ||
      event.kind === 'receivable-settlement'
    ) {
      continue;
    }
    notifications.push({
      id: `expected-event:${event.id}`,
      fingerprint: fingerprint(
        event.id,
        event.date,
        event.amountCents,
        event.direction,
        event.status,
        event.accountId,
      ),
      section: 'needs-action',
      title: event.date < today ? 'Expected action is overdue' : 'Confirm today’s expected action',
      subject: event.label,
      explanation:
        'Confirm only if this exact one-time event occurred; recurring items continue automatically.',
      amountCents: event.amountCents,
      date: event.date,
      primaryActionLabel: 'Mark completed',
      primaryAction: 'confirm-expected-event',
      openPath: `/records?entityType=forecast-event&entityId=${encodeURIComponent(event.id)}`,
      entityId: event.id,
      fundingAccountId: event.accountId,
    });
  }

  for (const need of snapshot.expectedTransferNeeds ?? snapshot.transferNeeds ?? []) {
    const accountFloor =
      snapshot.cashAccounts?.find((account) => account.id === need.accountId)?.hardFloorCents ?? 0;
    const projectedCashCents = accountFloor - need.shortfallCents;
    const deepestShortfallCents = need.horizonDeepestShortfallCents ?? need.shortfallCents;
    const depthExplanation =
      deepestShortfallCents > need.shortfallCents
        ? ` The same below-floor run reaches a ${formatMoney(deepestShortfallCents)} cash shortfall.`
        : '';
    const receivableExplanation = need.receivableReleaseNeededCents
      ? ` Releasing ${formatMoney(need.receivableReleaseNeededCents)} of dated Money Owed would cover ${
          need.uncoveredAfterReceivablesCents ? 'part of' : 'all of'
        } the first gap.`
      : '';
    notifications.push({
      id: `funding-need:${need.accountId}`,
      fingerprint: fingerprint(
        need.accountId,
        need.date,
        need.shortfallCents,
        need.horizonDeepestShortfallDate,
        need.horizonDeepestShortfallCents,
        need.receivableReleaseNeededCents,
      ),
      section: 'needs-action',
      title: 'Cash shortfall',
      subject: need.accountName,
      explanation: `Cash is projected to close at ${formatMoney(projectedCashCents)}, ${formatMoney(
        need.shortfallCents,
      )} below the ${formatMoney(accountFloor)} account minimum.${depthExplanation}${receivableExplanation}`,
      amountCents: need.shortfallCents,
      date: need.date,
      primaryActionLabel: 'Review funding',
      primaryAction: 'open',
      openPath: '/forecast',
      entityId: need.accountId,
    });
  }

  for (const reconciliation of records.reconciliations.filter(
    (item) => item.resolution === 'unresolved',
  )) {
    const account = records.accounts.find((candidate) => candidate.id === reconciliation.accountId);
    notifications.push({
      id: `reconciliation:${reconciliation.id}`,
      fingerprint: fingerprint(
        reconciliation.id,
        reconciliation.resolution,
        reconciliation.date,
        reconciliation.varianceCents,
      ),
      section: 'needs-action',
      title: 'Balance check needs review',
      subject: account?.name ?? 'Cash account',
      explanation: 'The recorded balance differs from the forecast and remains unresolved.',
      amountCents: Math.abs(reconciliation.varianceCents),
      date: reconciliation.date,
      primaryActionLabel: 'Resolve difference',
      primaryAction: 'open',
      openPath: `/reconcile?reconciliation=${encodeURIComponent(reconciliation.id)}`,
      entityId: reconciliation.id,
    });
  }

  const recentCutoff = addDays(today, -3);
  for (const cycle of records.cardCycles) {
    if (cycle.state !== 'paid' || !cycle.paymentOn || cycle.paymentOn < recentCutoff) continue;
    const card = cardById.get(cycle.cardId);
    if (!card) continue;
    notifications.push({
      id: `card-payment-recorded:${cycle.id}`,
      fingerprint: fingerprint(
        cycle.id,
        cycle.state,
        cycle.paymentOn,
        cycle.actualPaymentCents,
        cycle.lockedStatementCents,
      ),
      section: 'updates',
      title: 'Card payment recorded',
      subject: card.name,
      explanation: 'The payment is reflected in cash, statement history, and future card guidance.',
      amountCents: cycle.actualPaymentCents ?? cycle.lockedStatementCents,
      date: cycle.paymentOn,
      primaryActionLabel: 'Open card',
      primaryAction: 'open',
      openPath: `/cards?card=${encodeURIComponent(card.id)}`,
      entityId: cycle.id,
    });
  }

  return finalize(notifications, presentations, now);
};
