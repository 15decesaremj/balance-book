export const FINANCIAL_STATE_CHANGED_EVENT = 'balance-book:financial-state-changed';

export const announceCanonicalDataChanged = (): void => {
  window.dispatchEvent(new CustomEvent(FINANCIAL_STATE_CHANGED_EVENT));
};
