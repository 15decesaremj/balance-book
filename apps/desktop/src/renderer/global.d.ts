import type { BalanceBookApi } from '../shared/contracts';

declare global {
  interface Window {
    balanceBook: BalanceBookApi;
  }
}

export {};
