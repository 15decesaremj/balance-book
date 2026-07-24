export type NavigationIconName = 'overview' | 'forecast' | 'accounts' | 'planning' | 'settings';
export type FinancialGlyphName = 'cash' | 'card' | 'bill' | 'notice';

const paths: Record<NavigationIconName | FinancialGlyphName, React.JSX.Element> = {
  overview: (
    <>
      <path d="M4 11.4 12 4l8 7.4" />
      <path d="M6.5 10.5V20h11v-9.5M9.3 20v-5.7h5.4V20" />
    </>
  ),
  forecast: (
    <>
      <path d="M4 17.5 8.2 13l3 2.7 5.7-7.1" />
      <path d="M14.2 8.6h2.7v2.8" />
      <path d="M4 5v15h16" />
    </>
  ),
  accounts: (
    <>
      <rect x="3.5" y="5.2" width="17" height="13.6" rx="3" />
      <path d="M3.5 9h17M7 14h4M16.5 14h.1" />
    </>
  ),
  planning: (
    <>
      <path d="M5 19V8.4L12 4l7 4.4V19" />
      <path d="M8.5 19v-5h7v5M8 9.8h.1M12 9.8h.1M16 9.8h.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.1-1.2L14 3h-4l-.4 2.7a7 7 0 0 0-2.1 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.1 1.2L10 21h4l.4-2.7a7 7 0 0 0 2.1-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
    </>
  ),
  cash: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 9h18M7 14h4M17 14h.1" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 9.5h18M7 15h3" />
    </>
  ),
  bill: (
    <>
      <path d="M6 3.5h12V21l-3-1.8-3 1.8-3-1.8L6 21Z" />
      <path d="M9 8h6M9 12h6M9 16h3.5" />
    </>
  ),
  notice: (
    <>
      <path d="M12 3.5 21 20H3Z" />
      <path d="M12 9v4.5M12 17h.1" />
    </>
  ),
};

const LineIcon = ({
  name,
  className,
}: {
  name: NavigationIconName | FinancialGlyphName;
  className?: string;
}): React.JSX.Element => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {paths[name]}
  </svg>
);

export const NavigationIcon = ({ name }: { name: NavigationIconName }): React.JSX.Element => (
  <LineIcon name={name} />
);

export const FinancialGlyph = ({
  name,
  className,
}: {
  name: FinancialGlyphName;
  className?: string;
}): React.JSX.Element => <LineIcon name={name} className={className} />;

const balanceBookLogoUrl = new URL('../../../../assets/balance-book.svg', import.meta.url).href;

export const BalanceBookMark = ({ compact = false }: { compact?: boolean }): React.JSX.Element => (
  <span
    className={`balance-brand-mark${compact ? ' balance-brand-mark--compact' : ''}`}
    aria-hidden
  >
    <img src={balanceBookLogoUrl} alt="" draggable={false} data-balance-book-logo="app-icon" />
  </span>
);

export const AmbientBackdrop = (): React.JSX.Element => (
  <div className="balance-ambient" aria-hidden="true">
    <span className="balance-ambient__orb balance-ambient__orb--one" />
    <span className="balance-ambient__orb balance-ambient__orb--two" />
    <svg className="balance-ambient__trace" viewBox="0 0 1200 500" preserveAspectRatio="none">
      <path
        className="balance-ambient__trace-shadow"
        d="M-80 420C80 390 160 440 270 340s205-46 300-142 185 24 295-68 210-60 395-142"
      />
      <path
        className="balance-ambient__trace-line"
        d="M-80 420C80 390 160 440 270 340s205-46 300-142 185 24 295-68 210-60 395-142"
      />
    </svg>
  </div>
);
