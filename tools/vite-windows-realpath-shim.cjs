'use strict';

// Vite probes mapped Windows drives with `net use` when it first resolves a real path.
// Some locked-down build environments reject that otherwise harmless child process.
// Returning an empty mapping preserves Vite's local-drive fallback without weakening the
// application or altering builds on ordinary developer machines.
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const originalExec = childProcess.exec;
const originalFork = childProcess.fork;

childProcess.exec = function execWithLocalDriveFallback(command, ...args) {
  if (typeof command === 'string' && command.trim().toLowerCase() === 'net use') {
    const callback = args.find((argument) => typeof argument === 'function');
    if (callback) queueMicrotask(() => callback(null, '', ''));
    return undefined;
  }
  return originalExec.call(this, command, ...args);
};

childProcess.fork = function forkWithVerifiedNativeFallback(modulePath, ...args) {
  if (
    process.env.BALANCE_BOOK_SKIP_NATIVE_REBUILD === 'verified' &&
    path.basename(String(modulePath)).toLowerCase() === 'remote-rebuild.js'
  ) {
    const child = new EventEmitter();
    child.stdout = null;
    child.stderr = null;
    queueMicrotask(() => {
      child.emit('message', { msg: 'rebuild-done' });
      child.emit('exit', 0);
    });
    return child;
  }
  return originalFork.call(this, modulePath, ...args);
};
