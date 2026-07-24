export type BalanceBookBuildChannel = 'direct' | 'store';

export const balanceBookBuildChannel: BalanceBookBuildChannel =
  __BALANCE_BOOK_BUILD_CHANNEL__ === 'store' ? 'store' : 'direct';

export const isMicrosoftStoreBuild = balanceBookBuildChannel === 'store';

export const storeDataDirectoryName = __BALANCE_BOOK_STORE_DATA_DIRECTORY__;

export const legacyDataDirectoryName = __BALANCE_BOOK_LEGACY_DATA_DIRECTORY__;

export const microsoftStoreProductId = __BALANCE_BOOK_STORE_PRODUCT_ID__ || undefined;

export const microsoftStoreUri = microsoftStoreProductId
  ? `ms-windows-store://pdp/?productid=${encodeURIComponent(microsoftStoreProductId)}`
  : undefined;
