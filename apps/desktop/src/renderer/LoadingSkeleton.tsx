import type { ReactNode } from 'react';

export type LoadingSkeletonVariant = 'launch' | 'dashboard' | 'form' | 'list' | 'inline-form';

interface LoadingSkeletonProps {
  label: string;
  variant?: LoadingSkeletonVariant;
}

const Bar = ({ size = 'body' }: { size?: 'eyebrow' | 'title' | 'body' | 'value' | 'control' }) => (
  <span className={`balance-skeleton__bar balance-skeleton__bar--${size}`} />
);

const Header = () => (
  <div className="balance-skeleton__header">
    <Bar size="eyebrow" />
    <Bar size="title" />
    <Bar />
  </div>
);

const MetricCard = () => (
  <div className="balance-skeleton__card balance-skeleton__metric">
    <Bar size="eyebrow" />
    <Bar size="value" />
    <Bar />
  </div>
);

const FieldPlaceholder = () => (
  <div className="balance-skeleton__field">
    <Bar size="eyebrow" />
    <Bar size="control" />
  </div>
);

const FormBody = ({ inline = false }: { inline?: boolean }) => (
  <div className={inline ? 'balance-skeleton__inline' : 'balance-skeleton__card'}>
    <div className="balance-skeleton__form-grid">
      {Array.from({ length: inline ? 3 : 6 }, (_, index) => (
        <FieldPlaceholder key={index} />
      ))}
    </div>
    <div className="balance-skeleton__actions">
      <Bar size="control" />
      <Bar size="control" />
    </div>
  </div>
);

const LaunchLayout = () => (
  <div className="balance-skeleton__launch-card">
    <span className="balance-skeleton__mark" />
    <Bar size="title" />
    <Bar />
    <div className="balance-skeleton__launch-fields">
      <Bar size="control" />
      <Bar size="control" />
    </div>
  </div>
);

const DashboardLayout = () => (
  <>
    <Header />
    <div className="balance-skeleton__metrics">
      {Array.from({ length: 4 }, (_, index) => (
        <MetricCard key={index} />
      ))}
    </div>
    <div className="balance-skeleton__columns">
      <div className="balance-skeleton__card balance-skeleton__chart">
        <Bar size="eyebrow" />
        <span className="balance-skeleton__chart-line" />
      </div>
      <div className="balance-skeleton__card balance-skeleton__rows">
        <Bar size="title" />
        <Bar size="control" />
        <Bar size="control" />
        <Bar size="control" />
      </div>
    </div>
  </>
);

const FormLayout = () => (
  <>
    <Header />
    <FormBody />
  </>
);

const ListLayout = () => (
  <>
    <Header />
    <div className="balance-skeleton__toolbar">
      <Bar size="control" />
      <Bar size="control" />
    </div>
    <div className="balance-skeleton__list">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="balance-skeleton__card balance-skeleton__list-card" key={index}>
          <Bar size="title" />
          <Bar />
          <Bar />
          <div className="balance-skeleton__actions">
            <Bar size="control" />
          </div>
        </div>
      ))}
    </div>
  </>
);

const layoutFor = (variant: LoadingSkeletonVariant): ReactNode => {
  switch (variant) {
    case 'launch':
      return <LaunchLayout />;
    case 'dashboard':
      return <DashboardLayout />;
    case 'form':
      return <FormLayout />;
    case 'list':
      return <ListLayout />;
    case 'inline-form':
      return <FormBody inline />;
  }
};

/**
 * Stable, non-interactive loading geometry for data-backed screens. Decorative
 * bars are hidden from assistive technology; the status label is announced once.
 */
export const LoadingSkeleton = ({
  label,
  variant = 'form',
}: LoadingSkeletonProps): React.JSX.Element => (
  <div
    className={`balance-skeleton balance-skeleton--${variant}`}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span className="balance-visually-hidden">{label}</span>
    <div className="balance-skeleton__content" aria-hidden="true" aria-busy="true">
      {layoutFor(variant)}
    </div>
  </div>
);
