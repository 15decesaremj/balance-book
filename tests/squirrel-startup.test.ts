import { describe, expect, it, vi } from 'vitest';
import {
  handleSquirrelStartupEvent,
  resolveSquirrelStartupAction,
  type SquirrelProcess,
  type SquirrelProcessSpawner,
} from '../apps/desktop/src/squirrel-startup';

describe('Squirrel startup handling', () => {
  it('recognizes only Windows installer lifecycle arguments', () => {
    expect(resolveSquirrelStartupAction('win32', ['BalanceBook.exe', '--squirrel-install'])).toBe(
      'create-shortcut',
    );
    expect(resolveSquirrelStartupAction('win32', ['BalanceBook.exe', '--squirrel-updated'])).toBe(
      'create-shortcut',
    );
    expect(resolveSquirrelStartupAction('win32', ['BalanceBook.exe', '--squirrel-uninstall'])).toBe(
      'remove-shortcut',
    );
    expect(resolveSquirrelStartupAction('win32', ['BalanceBook.exe', '--squirrel-obsolete'])).toBe(
      'quit',
    );
    expect(
      resolveSquirrelStartupAction('win32', ['BalanceBook.exe', '--squirrel-firstrun']),
    ).toBeNull();
    expect(resolveSquirrelStartupAction('linux', ['BalanceBook', '--squirrel-install'])).toBeNull();
  });

  it('creates the stable installed shortcut and quits after the helper exits', () => {
    const listeners = new Map<'close' | 'error', () => void>();
    const child: SquirrelProcess = {
      on(event, listener) {
        listeners.set(event, listener);
        return child;
      },
    };
    const spawnProcess = vi.fn(() => child) as SquirrelProcessSpawner;
    const quit = vi.fn();

    expect(
      handleSquirrelStartupEvent({
        platform: 'win32',
        arguments_: ['BalanceBook.exe', '--squirrel-install', '0.4.0'],
        executablePath:
          'C:\\Users\\Example\\AppData\\Local\\balance_book_mvp\\app-0.4.0\\BalanceBook.exe',
        quit,
        spawnProcess,
      }),
    ).toBe(true);

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Users\\Example\\AppData\\Local\\balance_book_mvp\\Update.exe',
      ['--createShortcut', 'BalanceBook.exe'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    expect(quit).not.toHaveBeenCalled();
    listeners.get('close')?.();
    listeners.get('error')?.();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('does not initialize or spawn helpers during a normal launch', () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('not expected');
    }) as SquirrelProcessSpawner;
    const quit = vi.fn();

    expect(
      handleSquirrelStartupEvent({
        platform: 'win32',
        arguments_: ['BalanceBook.exe'],
        executablePath: 'C:\\BalanceBook.exe',
        quit,
        spawnProcess,
      }),
    ).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
