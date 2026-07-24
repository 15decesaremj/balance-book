import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BalanceBookUpdateService, updateFeedUrl } from '../apps/desktop/src/update-service';
import type { UpdateStatusDto } from '../apps/desktop/src/shared/contracts';

class FakeUpdater extends EventEmitter {
  readonly setFeedURL = vi.fn();
  readonly checkForUpdates = vi.fn(async () => undefined);
  readonly quitAndInstall = vi.fn();
}

const services: BalanceBookUpdateService[] = [];

const makeService = ({
  enabled = true,
  firstRun = false,
  initialDelayMs = 60_000,
  prepareInstall = vi.fn(async () => undefined),
}: {
  enabled?: boolean;
  firstRun?: boolean;
  initialDelayMs?: number;
  prepareInstall?: () => Promise<void>;
} = {}) => {
  const updater = new FakeUpdater();
  const statuses: UpdateStatusDto[] = [];
  const service = new BalanceBookUpdateService(updater, {
    enabled,
    delivery: enabled ? 'balance-book' : 'none',
    storeLinkAvailable: false,
    currentVersion: '2.0.6',
    initialChannel: 'beta',
    firstRun,
    onStatus: (status) => statuses.push(status),
    prepareInstall,
    initialDelayMs,
  });
  services.push(service);
  return { updater, statuses, service, prepareInstall };
};

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.restoreAllMocks();
});

describe('Balance Book updater', () => {
  it('uses deterministic channel feeds', () => {
    expect(updateFeedUrl('beta')).toBe(
      'https://15decesaremj.github.io/balance-book/updates/beta/win32/x64',
    );
    expect(updateFeedUrl('stable')).toBe(
      'https://15decesaremj.github.io/balance-book/updates/stable/win32/x64',
    );
  });

  it('never contacts the network when the build gate is disabled', async () => {
    const { updater, service } = makeService({ enabled: false });
    await service.check();
    expect(service.getStatus()).toMatchObject({ enabled: false, state: 'disabled' });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('describes Store-managed delivery without contacting the GitHub update feed', async () => {
    const updater = new FakeUpdater();
    const service = new BalanceBookUpdateService(updater, {
      enabled: false,
      delivery: 'microsoft-store',
      storeLinkAvailable: true,
      currentVersion: '2.0.7',
      initialChannel: 'stable',
      firstRun: false,
      onStatus: () => undefined,
      prepareInstall: async () => undefined,
    });
    services.push(service);

    await service.check();

    expect(service.getStatus()).toMatchObject({
      enabled: false,
      delivery: 'microsoft-store',
      storeLinkAvailable: true,
      state: 'disabled',
      message: 'Updates are managed automatically by Microsoft Store.',
    });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('waits through the Squirrel first-run lock before its automatic check', async () => {
    vi.useFakeTimers();
    const { updater, service } = makeService({ firstRun: true, initialDelayMs: 10_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('deduplicates checks and follows the selected release channel', async () => {
    const { updater, service } = makeService();
    await service.check();
    await service.check();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.setFeedURL).toHaveBeenCalledWith({ url: updateFeedUrl('beta') });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.emit('update-not-available');
    service.setChannel('stable');
    await service.check();
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({ url: updateFeedUrl('stable') });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('can defer a downloaded update and prepares recovery before restart', async () => {
    const prepareInstall = vi.fn(async () => undefined);
    const { updater, service } = makeService({ prepareInstall });
    updater.emit(
      'update-downloaded',
      {},
      '',
      'Balance Book 2.0.7',
      new Date('2026-07-24T00:00:00.000Z'),
      updateFeedUrl('beta'),
    );
    expect(service.getStatus()).toMatchObject({
      state: 'ready',
      releaseName: 'Balance Book 2.0.7',
    });

    expect(service.defer()).toMatchObject({ state: 'deferred' });
    await service.restartAndInstall();
    expect(prepareInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('keeps an update ready when restart safety preparation fails', async () => {
    const { updater, service } = makeService({
      prepareInstall: vi.fn(async () => {
        throw new Error('Save or cancel any open edits.');
      }),
    });
    updater.emit('update-downloaded', {}, '', '2.0.7', new Date(), updateFeedUrl('beta'));
    await service.restartAndInstall();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      state: 'ready',
      message: 'Save or cancel any open edits.',
    });
  });

  it('uses a quiet offline state without inventing download progress', async () => {
    const { updater, service } = makeService();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await service.check();
    expect(service.getStatus()).toMatchObject({
      state: 'offline',
      message: 'You appear to be offline. Balance Book will try again later.',
    });
  });
});
