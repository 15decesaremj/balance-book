import {
  addCents,
  moneyCentsSchema,
  type Asset,
  type CashAccount,
  type Loan,
  type MoneyCents,
  type Receivable,
} from '@balance-book/domain';

export const calculateNetWorth = (input: {
  cashAccounts: CashAccount[];
  assets: Asset[];
  receivables: Receivable[];
  loans: Loan[];
  /** Posted revolving debt only; planned purchases and future estimates are not current debt. */
  revolvingDebtCents?: MoneyCents;
  liquidCashCentsOverride?: MoneyCents;
  allCashCentsOverride?: MoneyCents;
  receivablesCentsOverride?: MoneyCents;
  restrictedRefinanceSettlementCents?: MoneyCents;
  economicRestrictedRefinanceSettlementCents?: MoneyCents;
}): {
  liquidNetPositionCents: MoneyCents;
  contractualNetWorthCents: MoneyCents;
  economicNetWorthCents: MoneyCents;
  contractualLiabilitiesCents: MoneyCents;
} => {
  const liquidCash =
    input.liquidCashCentsOverride ??
    addCents(
      ...input.cashAccounts
        .filter((account) => account.includedInLiquidity)
        .map((account) => account.openingBalanceCents),
    );
  const allCash =
    input.allCashCentsOverride ??
    (input.liquidCashCentsOverride === undefined
      ? addCents(...input.cashAccounts.map((account) => account.openingBalanceCents))
      : addCents(
          input.liquidCashCentsOverride,
          ...input.cashAccounts
            .filter((account) => !account.includedInLiquidity)
            .map((account) => account.openingBalanceCents),
        ));
  const includedAssets = addCents(
    ...input.assets.filter((asset) => asset.includedInNetWorth).map((asset) => asset.valueCents),
  );
  const liquidAssets = addCents(
    ...input.assets.filter((asset) => asset.includedInLiquidity).map((asset) => asset.valueCents),
  );
  const receivables =
    input.receivablesCentsOverride ??
    addCents(...input.receivables.map((item) => item.remainingAmountCents));
  const restrictedRefinanceSettlementCents = moneyCentsSchema
    .nonnegative()
    .parse(input.restrictedRefinanceSettlementCents ?? 0);
  const economicRestrictedRefinanceSettlementCents = moneyCentsSchema
    .nonnegative()
    .parse(input.economicRestrictedRefinanceSettlementCents ?? restrictedRefinanceSettlementCents);
  const activeLoans = input.loans.filter((loan) => (loan.status ?? 'active') === 'active');
  const revolvingDebtCents = moneyCentsSchema.nonnegative().parse(input.revolvingDebtCents ?? 0);
  const contractualLiabilities = addCents(
    revolvingDebtCents,
    ...activeLoans.map((loan) => loan.principalCents + loan.accruedInterestCents),
  );
  const economicLiabilities = addCents(
    revolvingDebtCents,
    ...activeLoans
      .filter((loan) => !loan.excludeFromEconomicNetWorthDoubleCount)
      .map((loan) => loan.principalCents + loan.accruedInterestCents),
  );
  return {
    liquidNetPositionCents: moneyCentsSchema.parse(liquidCash + liquidAssets),
    contractualNetWorthCents: moneyCentsSchema.parse(
      allCash +
        includedAssets +
        receivables +
        restrictedRefinanceSettlementCents -
        contractualLiabilities,
    ),
    economicNetWorthCents: moneyCentsSchema.parse(
      allCash +
        includedAssets +
        receivables +
        economicRestrictedRefinanceSettlementCents -
        economicLiabilities,
    ),
    contractualLiabilitiesCents: contractualLiabilities,
  };
};
