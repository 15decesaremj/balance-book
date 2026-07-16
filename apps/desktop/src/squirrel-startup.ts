import path from 'node:path';
import { spawn } from 'node:child_process';

type SquirrelStartupAction = 'create-shortcut' | 'remove-shortcut' | 'quit';

export interface SquirrelProcess {
  on(event: 'close' | 'error', listener: () => void): SquirrelProcess;
}

export type SquirrelProcessSpawner = (
  command: string,
  arguments_: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true },
) => SquirrelProcess;

const spawnSquirrelProcess: SquirrelProcessSpawner = (command, arguments_, options) =>
  spawn(command, arguments_, options);

export const resolveSquirrelStartupAction = (
  platform: NodeJS.Platform,
  arguments_: readonly string[],
): SquirrelStartupAction | null => {
  if (platform !== 'win32') return null;

  switch (arguments_[1]) {
    case '--squirrel-install':
    case '--squirrel-updated':
      return 'create-shortcut';
    case '--squirrel-uninstall':
      return 'remove-shortcut';
    case '--squirrel-obsolete':
      return 'quit';
    default:
      return null;
  }
};

export const handleSquirrelStartupEvent = (input: {
  platform: NodeJS.Platform;
  arguments_: readonly string[];
  executablePath: string;
  quit: () => void;
  spawnProcess?: SquirrelProcessSpawner;
}): boolean => {
  const action = resolveSquirrelStartupAction(input.platform, input.arguments_);
  if (!action) return false;
  if (action === 'quit') {
    input.quit();
    return true;
  }

  const updateExecutable = path.resolve(path.dirname(input.executablePath), '..', 'Update.exe');
  const shortcutAction = action === 'create-shortcut' ? '--createShortcut' : '--removeShortcut';
  let quitRequested = false;
  const quitOnce = (): void => {
    if (quitRequested) return;
    quitRequested = true;
    input.quit();
  };

  try {
    const child = (input.spawnProcess ?? spawnSquirrelProcess)(
      updateExecutable,
      [shortcutAction, path.basename(input.executablePath)],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', quitOnce);
    child.on('close', quitOnce);
  } catch {
    quitOnce();
  }

  return true;
};
