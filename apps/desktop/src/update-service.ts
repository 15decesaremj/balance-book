import type { UpdateChannel, UpdateStatusDto } from './shared/contracts';

export const updateFeedUrl = (channel: UpdateChannel): string =>
  `https://15decesaremj.github.io/balance-book/updates/${channel}/win32/x64`;

type AutoUpdaterAdapter = {
  checkForUpdates(): Promise<unknown> | void;
  on(eventName: string, listener: (...arguments_: unknown[]) => void): unknown;
  quitAndInstall(): void;
  removeListener(eventName: string, listener: (...arguments_: unknown[]) => void): unknown;
  setFeedURL(options: { url: string }): void;
};

type UpdateServiceOptions = {
  enabled: boolean;
  currentVersion: string;
  initialChannel: UpdateChannel;
  firstRun: boolean;
  onStatus: (status: UpdateStatusDto) => void;
  prepareInstall: (status: UpdateStatusDto) => Promise<void>;
  initialDelayMs?: number;
  intervalMs?: number;
};

const safeUpdateError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n]+/g, ' ').slice(0, 220) || 'The update check failed.';
};

export class BalanceBookUpdateService {
  private status: UpdateStatusDto;
  private timer: NodeJS.Timeout | undefined;
  private operationInFlight = false;
  private installInFlight = false;

  private readonly onError = (...arguments_: unknown[]): void => {
    const error = arguments_[0];
    this.operationInFlight = false;
    const errorMessage = safeUpdateError(error);
    const offline =
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ENETUNREACH|ENOTFOUND|offline/iu.test(
        errorMessage,
      );
    this.publish({
      state: offline ? 'offline' : 'failed',
      message: offline
        ? 'You appear to be offline. Balance Book will try again later.'
        : `Could not check for updates. ${errorMessage}`,
      checkedAt: new Date().toISOString(),
    });
  };

  private readonly onChecking = (): void => {
    this.publish({ state: 'checking', message: 'Checking for updates…' });
  };

  private readonly onAvailable = (): void => {
    this.publish({ state: 'downloading', message: 'Downloading the verified update…' });
  };

  private readonly onNotAvailable = (): void => {
    this.operationInFlight = false;
    this.publish({
      state: 'current',
      message: 'Balance Book is up to date.',
      checkedAt: new Date().toISOString(),
      releaseName: undefined,
      releaseDate: undefined,
    });
  };

  private readonly onDownloaded = (...arguments_: unknown[]): void => {
    const releaseNotes = typeof arguments_[1] === 'string' ? arguments_[1] : '';
    const releaseName = typeof arguments_[2] === 'string' ? arguments_[2] : '';
    const releaseDate = arguments_[3];
    this.operationInFlight = false;
    this.publish({
      state: 'ready',
      message: `${releaseName || 'A new version'} is ready to install.`,
      checkedAt: new Date().toISOString(),
      releaseName: releaseName || undefined,
      releaseDate:
        releaseDate instanceof Date && !Number.isNaN(releaseDate.valueOf())
          ? releaseDate.toISOString()
          : undefined,
      releaseNotes: releaseNotes.slice(0, 2_000) || undefined,
    });
  };

  constructor(
    private readonly updater: AutoUpdaterAdapter,
    private readonly options: UpdateServiceOptions,
  ) {
    this.status = {
      enabled: options.enabled,
      state: options.enabled ? 'idle' : 'disabled',
      channel: options.initialChannel,
      currentVersion: options.currentVersion,
      message: options.enabled
        ? 'Updates are ready to check.'
        : 'Automatic updates are disabled in this local test build.',
    };
    updater.on('error', this.onError);
    updater.on('checking-for-update', this.onChecking);
    updater.on('update-available', this.onAvailable);
    updater.on('update-not-available', this.onNotAvailable);
    updater.on('update-downloaded', this.onDownloaded);
  }

  getStatus(): UpdateStatusDto {
    return { ...this.status };
  }

  setChannel(channel: UpdateChannel): UpdateStatusDto {
    if (this.status.channel === channel) return this.getStatus();
    this.status = {
      ...this.status,
      channel,
      state: this.options.enabled ? 'idle' : 'disabled',
      message: this.options.enabled
        ? `Ready to check the ${channel === 'beta' ? 'Beta' : 'Stable'} channel.`
        : this.status.message,
      releaseName: undefined,
      releaseDate: undefined,
    };
    this.options.onStatus(this.getStatus());
    return this.getStatus();
  }

  start(): void {
    this.options.onStatus(this.getStatus());
    if (!this.options.enabled || this.timer) return;
    const delay = this.options.firstRun
      ? Math.max(this.options.initialDelayMs ?? 12_000, 10_000)
      : (this.options.initialDelayMs ?? 8_000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
      this.timer = setInterval(
        () => void this.check(),
        this.options.intervalMs ?? 6 * 60 * 60 * 1_000,
      );
    }, delay);
  }

  async check(): Promise<UpdateStatusDto> {
    if (!this.options.enabled) return this.getStatus();
    if (this.operationInFlight || this.installInFlight) return this.getStatus();
    this.operationInFlight = true;
    this.publish({ state: 'checking', message: 'Checking for updates…' });
    try {
      this.updater.setFeedURL({ url: updateFeedUrl(this.status.channel) });
      await this.updater.checkForUpdates();
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
    return this.getStatus();
  }

  defer(): UpdateStatusDto {
    if (this.status.state !== 'ready') return this.getStatus();
    this.publish({
      state: 'deferred',
      message: 'Update postponed. You can install it later from Settings.',
    });
    return this.getStatus();
  }

  async restartAndInstall(): Promise<UpdateStatusDto> {
    if (!this.options.enabled || !['ready', 'deferred'].includes(this.status.state)) {
      return this.getStatus();
    }
    if (this.installInFlight) return this.getStatus();
    this.installInFlight = true;
    try {
      await this.options.prepareInstall(this.getStatus());
      this.publish({ state: 'installing', message: 'Restarting to install the update…' });
      this.updater.quitAndInstall();
    } catch (error) {
      this.installInFlight = false;
      this.publish({
        state: 'ready',
        message: safeUpdateError(error),
      });
    }
    return this.getStatus();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.updater.removeListener('error', this.onError);
    this.updater.removeListener('checking-for-update', this.onChecking);
    this.updater.removeListener('update-available', this.onAvailable);
    this.updater.removeListener('update-not-available', this.onNotAvailable);
    this.updater.removeListener('update-downloaded', this.onDownloaded);
  }

  private publish(patch: Partial<UpdateStatusDto>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus(this.getStatus());
  }
}
