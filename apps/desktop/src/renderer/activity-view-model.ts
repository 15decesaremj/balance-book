import type { AuditHistoryEntryDto, ImportReviewDto, ManagedRecordsDto } from '../shared/contracts';

export type ActivityKind =
  | 'balance'
  | 'cash'
  | 'card'
  | 'statement'
  | 'payment'
  | 'income'
  | 'bill'
  | 'receivable'
  | 'loan'
  | 'asset'
  | 'reconciliation'
  | 'import'
  | 'reversal'
  | 'audit';

export interface ActivityRow {
  id: string;
  date: string;
  kind: ActivityKind;
  status: string;
  title: string;
  detail: string;
  amountCents?: number;
  direction?: 'inflow' | 'outflow';
  accountId?: string;
  cardId?: string;
  entityType: string;
  entityId: string;
  sourceRecordIds: string[];
}

const eventKind = (event: ManagedRecordsDto['events'][number]): ActivityKind => {
  if (event.sourceRecordId) return 'reversal';
  if (event.kind === 'income') return 'income';
  if (event.kind === 'card-payment') return 'payment';
  if (event.kind === 'loan-payment') return 'loan';
  if (event.kind === 'receivable-settlement') return 'receivable';
  if (event.paymentMethod === 'credit-card') return 'card';
  if (
    event.kind === 'direct-commitment' ||
    event.kind === 'payable' ||
    event.kind === 'baseline-spending'
  ) {
    return 'bill';
  }
  return 'cash';
};

export const buildActivityTimeline = (
  records: ManagedRecordsDto,
  importReview?: ImportReviewDto | null,
  auditHistory: AuditHistoryEntryDto[] = [],
): ActivityRow[] => {
  const accountNames = new Map(records.accounts.map((account) => [account.id, account.name]));
  const cardNames = new Map(records.cards.map((card) => [card.id, card.name]));
  const rows: ActivityRow[] = [
    ...records.accounts.map((account): ActivityRow => ({
      id: `balance:${account.id}:${account.balanceAsOf}`,
      date: account.balanceAsOf,
      kind: 'balance',
      status: 'authoritative',
      title: `${account.name} balance reported`,
      detail: 'Authoritative cash-account source balance',
      amountCents: account.openingBalanceCents,
      accountId: account.id,
      entityType: 'cash-account',
      entityId: account.id,
      sourceRecordIds: [account.id],
    })),
    ...records.events
      .filter(
        (event) =>
          !(
            event.kind === 'card-payment' &&
            event.sourceRecordId &&
            records.cardCycles.some((cycle) => cycle.id === event.sourceRecordId)
          ),
      )
      .map((event): ActivityRow => ({
        id: `event:${event.id}`,
        date: event.date,
        kind: eventKind(event),
        status: event.status,
        title: event.label,
        detail: [
          accountNames.get(event.accountId),
          event.cardId ? cardNames.get(event.cardId) : undefined,
          event.sourceRecordId ? `Reverses ${event.sourceRecordId}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        amountCents: event.amountCents,
        direction: event.direction,
        accountId: event.accountId,
        cardId: event.cardId,
        entityType: 'forecast-event',
        entityId: event.id,
        sourceRecordIds: [event.id, ...(event.sourceRecordId ? [event.sourceRecordId] : [])],
      })),
    ...records.cardCycles.flatMap((cycle): ActivityRow[] => {
      const statement: ActivityRow = {
        id: `statement:${cycle.id}`,
        date: cycle.closesOn,
        kind: 'statement',
        status: cycle.state,
        title: `${cardNames.get(cycle.cardId) ?? 'Card'} statement`,
        detail: `Due ${cycle.dueOn}`,
        amountCents:
          cycle.lockedStatementCents ??
          (cycle.actualActivityCents + cycle.plannedActivityCents > 0
            ? cycle.actualActivityCents + cycle.plannedActivityCents
            : cycle.defaultEstimateCents),
        cardId: cycle.cardId,
        entityType: 'card-cycle',
        entityId: cycle.id,
        sourceRecordIds: [cycle.id],
      };
      if (!cycle.paymentOn) return [statement];
      return [
        statement,
        {
          id: `payment:${cycle.id}`,
          date: cycle.paymentOn,
          kind: 'payment',
          status: cycle.state === 'paid' ? 'confirmed' : 'scheduled',
          title: `${cardNames.get(cycle.cardId) ?? 'Card'} payment`,
          detail: cycle.actualPaymentAccountId
            ? (accountNames.get(cycle.actualPaymentAccountId) ?? 'Recorded payment account')
            : 'Scheduled funding account',
          amountCents: cycle.actualPaymentCents ?? cycle.lockedStatementCents,
          direction: 'outflow',
          accountId: cycle.actualPaymentAccountId,
          cardId: cycle.cardId,
          entityType: 'card-cycle',
          entityId: cycle.id,
          sourceRecordIds: [cycle.id],
        },
      ];
    }),
    ...records.receivables.map((receivable): ActivityRow => ({
      id: `receivable:${receivable.id}`,
      date: receivable.expectedDate,
      kind: 'receivable',
      status: receivable.remainingAmountCents > 0 ? receivable.certainty : 'received',
      title: receivable.description,
      detail: receivable.source,
      amountCents: receivable.remainingAmountCents,
      accountId: receivable.destinationAccountId,
      entityType: 'receivable',
      entityId: receivable.id,
      sourceRecordIds: [receivable.id],
    })),
    ...records.loans.map((loan): ActivityRow => ({
      id: `loan:${loan.id}:${loan.balanceDate}`,
      date: loan.balanceDate,
      kind: 'loan',
      status: loan.status ?? 'active',
      title: `${loan.name} balance`,
      detail: 'Installment-loan source balance',
      amountCents: loan.principalCents,
      accountId: loan.fundingAccountId,
      entityType: 'loan',
      entityId: loan.id,
      sourceRecordIds: [loan.id],
    })),
    ...records.assets.map((asset): ActivityRow => ({
      id: `asset:${asset.id}:${asset.valuationDate}`,
      date: asset.valuationDate,
      kind: 'asset',
      status: asset.includedInNetWorth ? 'included' : 'excluded',
      title: `${asset.name} valuation`,
      detail: asset.type,
      amountCents: asset.valueCents,
      entityType: 'asset',
      entityId: asset.id,
      sourceRecordIds: [asset.id],
    })),
    ...records.reconciliations.map((reconciliation): ActivityRow => ({
      id: `reconciliation:${reconciliation.id}`,
      date: reconciliation.date,
      kind: 'reconciliation',
      status: reconciliation.resolution,
      title: `${accountNames.get(reconciliation.accountId) ?? 'Cash account'} reconciliation`,
      detail: `Variance ${reconciliation.varianceCents < 0 ? 'below' : 'above'} forecast`,
      amountCents: Math.abs(reconciliation.varianceCents),
      accountId: reconciliation.accountId,
      entityType: 'reconciliation',
      entityId: reconciliation.id,
      sourceRecordIds: [reconciliation.id],
    })),
    ...(importReview?.batches ?? []).map((batch): ActivityRow => ({
      id: `import:${batch.id}`,
      date: batch.createdAt.slice(0, 10),
      kind: 'import',
      status: batch.status,
      title: 'Workbook import',
      detail: 'Imported source evidence and field lineage',
      entityType: 'import-batch',
      entityId: batch.id,
      sourceRecordIds: [batch.id],
    })),
    ...auditHistory
      .filter((event) => !['create', 'update', 'upsert', 'settle'].includes(event.action))
      .map((event): ActivityRow => ({
        id: `audit:${event.id}`,
        date: event.createdAt.slice(0, 10),
        kind: 'audit',
        status: 'recorded',
        title: `${event.action.replaceAll('-', ' ')} ${event.entityType.replaceAll('-', ' ')}`,
        detail: `Immutable audit event · ${event.entityId}`,
        entityType: event.entityType,
        entityId: event.entityId,
        sourceRecordIds: [event.entityId, event.id],
      })),
  ];
  return rows.sort(
    (left, right) =>
      right.date.localeCompare(left.date) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
};

export const filterActivityTimeline = (
  rows: ActivityRow[],
  filter: {
    query?: string;
    accountOrCardId?: string;
    kind?: ActivityKind | 'all';
    status?: string;
    from?: string;
    through?: string;
  },
): ActivityRow[] => {
  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  return rows.filter(
    (row) =>
      (!filter.accountOrCardId ||
        row.accountId === filter.accountOrCardId ||
        row.cardId === filter.accountOrCardId) &&
      (!filter.kind || filter.kind === 'all' || row.kind === filter.kind) &&
      (!filter.status || row.status === filter.status) &&
      (!filter.from || row.date >= filter.from) &&
      (!filter.through || row.date <= filter.through) &&
      (!query ||
        `${row.title} ${row.detail} ${row.kind} ${row.status} ${row.entityId}`
          .toLocaleLowerCase()
          .includes(query)),
  );
};
