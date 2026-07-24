import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isProhibitedSourceFile } from '../tools/privacy-check/rules.mjs';

describe('public-mirror privacy file rules', () => {
  it.each([
    'private/profile.json',
    'local-data/balance-book.sqlite',
    'local-backups/snapshot.backup',
    'local-release-work/release-metadata.json',
    'local-releases/candidates/Balance Book Setup.exe',
    'local-screenshots/dashboard.txt',
    'out/make/setup.exe',
    '.vite/build/main.js',
    'dist/renderer.js',
    'coverage/coverage-final.json',
    'node_modules/example/index.js',
    '.pnpm-store/cache.json',
    'playwright-report/index.html',
    'test-results/results.json',
    'exports/custom-name.json',
    'screenshots/private-view.txt',
    'release/Balance Book Setup.exe',
    'release/balance_book_mvp-1.1.0-full.nupkg',
    'release/portable.zip',
    'release/app.asar',
    'release/resources.pak',
    'release/RELEASES',
    'release/profile.json',
    'release/better_sqlite3.node',
    'release/profile.backup',
    'release/statement.pdf',
    'release/application.log',
    'release/accounts-export.csv',
    'release/balance.sqlite-wal',
    'notes/accounts.csv',
  ])('rejects private or generated source path %s', (file) => {
    expect(isProhibitedSourceFile(file)).toBe(true);
  });

  it.each([
    'apps/desktop/src/main.ts',
    'packages/domain/src/money.ts',
    'assets/balance-book.ico',
    '.github/workflows/verify.yml',
    'docs/INSTALLATION.md',
    'tests/privacy-check.test.ts',
  ])('allows reviewed source path %s', (file) => {
    expect(isProhibitedSourceFile(file)).toBe(false);
  });

  it('normalizes Windows separators before applying path rules', () => {
    expect(isProhibitedSourceFile('local-release-work\\candidate\\metadata.json')).toBe(true);
  });
});

const privacyCheckPath = fileURLToPath(
  new URL('../tools/privacy-check/index.mjs', import.meta.url),
);
const syntheticEmail = ['synthetic.publisher', 'example.invalid'].join('@');
const temporaryRoots = new Set<string>();
const childProcessesAvailable = (() => {
  const result = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
})();
const gitAvailable =
  childProcessesAvailable &&
  (() => {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  })();
const describeWithChildProcesses = childProcessesAvailable ? describe : describe.skip;
const describeWithGit = gitAvailable ? describe : describe.skip;

const runGit = (cwd: string | undefined, arguments_: string[]) => {
  const result = spawnSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Synthetic Git command failed: ${result.error?.message ?? result.stderr ?? 'unknown error'}`,
    );
  }
  return result;
};

const createTemporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'balance-book-privacy-history-'));
  temporaryRoots.add(root);
  return root;
};

const createRepository = () => {
  const root = createTemporaryRoot();
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'Balance Book contributors']);
  runGit(root, ['config', 'user.email', 'noreply']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);
  runGit(root, ['config', 'tag.gpgsign', 'false']);
  writeFileSync(join(root, 'README.md'), '# Synthetic privacy fixture\n', 'utf8');
  runGit(root, ['add', '--', 'README.md']);
  runGit(root, ['commit', '-m', 'Create synthetic fixture']);
  const patternFile = join(root, '.synthetic-privacy-patterns');
  writeFileSync(patternFile, 'SYNTHETIC_PATTERN_NOT_PRESENT_9174\n', 'utf8');
  return { root, patternFile };
};

const runHistoryCheck = (root: string, patternFile: string) =>
  spawnSync(process.execPath, [privacyCheckPath, '--history', '--pattern-file', patternFile], {
    cwd: root,
    encoding: 'utf8',
  });

const runFileListCheck = (root: string, files: string[], patternFile: string) => {
  const fileList = join(root, '.synthetic-file-list');
  writeFileSync(fileList, `${files.join('\n')}\n`, 'utf8');
  return spawnSync(
    process.execPath,
    [privacyCheckPath, '--file-list', fileList, '--pattern-file', patternFile],
    { cwd: root, encoding: 'utf8' },
  );
};

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describeWithChildProcesses('privacy path-content scanner', () => {
  it('finds a protected fingerprint in an exact file-list path', () => {
    const root = createTemporaryRoot();
    const fingerprint = 'SYNTHETIC_PATH_FINGERPRINT_62B4';
    const patternFile = join(root, '.synthetic-privacy-patterns');
    const file = `docs/${fingerprint}.md`;
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, file), '# Synthetic path fixture\n', 'utf8');
    writeFileSync(patternFile, `${fingerprint}\n`, 'utf8');

    const result = runFileListCheck(root, [file], patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path matches a local private-content pattern');
  });

  it('finds a generic email-like identifier in an exact file-list path', () => {
    const root = createTemporaryRoot();
    const patternFile = join(root, '.synthetic-privacy-patterns');
    const file = `records/${syntheticEmail}.txt`;
    mkdirSync(join(root, 'records'));
    writeFileSync(join(root, file), 'Synthetic path fixture\n', 'utf8');
    writeFileSync(patternFile, 'SYNTHETIC_PATTERN_NOT_PRESENT_9174\n', 'utf8');

    const result = runFileListCheck(root, [file], patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path contains possible email address');
  });
});

describeWithGit('privacy history scanner', { timeout: 15_000 }, () => {
  it('passes complete synthetic history with a safe identity and raw Unicode path', () => {
    const { root, patternFile } = createRepository();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'résumé.md'), '# Synthetic document\n', 'utf8');
    runGit(root, ['add', '--', 'docs/résumé.md']);
    runGit(root, ['commit', '-m', 'Add synthetic Unicode path']);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Privacy check passed');
  });

  it('finds protected fingerprints in commit metadata', () => {
    const { root, patternFile } = createRepository();
    const fingerprint = 'SYNTHETIC_COMMIT_METADATA_FINGERPRINT_73A9';
    writeFileSync(patternFile, `${fingerprint}\n`, 'utf8');
    runGit(root, ['commit', '--allow-empty', '-m', `Synthetic note ${fingerprint}`]);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git commit');
    expect(result.stderr).toContain('matches a local private-content pattern');
  });

  it('finds generic private metadata in commit headers', () => {
    const { root, patternFile } = createRepository();
    runGit(root, [
      '-c',
      `user.email=${syntheticEmail}`,
      'commit',
      '--allow-empty',
      '-m',
      'Create synthetic provenance fixture',
    ]);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git commit');
    expect(result.stderr).toContain('possible email address');
  });

  it.each([
    ['49699333+dependabot[bot]', 'users.noreply.github.com'].join('@'),
    ['41898282+github-actions[bot]', 'users.noreply.github.com'].join('@'),
    ['noreply', 'github.com'].join('@'),
    ['support', 'github.com'].join('@'),
  ])('allows the exact public GitHub automation identity %s in commit metadata', (email) => {
    const { root, patternFile } = createRepository();
    runGit(root, [
      '-c',
      `user.email=${email}`,
      'commit',
      '--allow-empty',
      '-m',
      'Create synthetic automation provenance fixture',
    ]);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Privacy check passed');
  });

  it('does not trust an arbitrary GitHub no-reply identity in commit metadata', () => {
    const { root, patternFile } = createRepository();
    runGit(root, [
      '-c',
      `user.email=${['12345678+synthetic-user', 'users.noreply.github.com'].join('@')}`,
      'commit',
      '--allow-empty',
      '-m',
      'Create synthetic untrusted provenance fixture',
    ]);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git commit');
    expect(result.stderr).toContain('possible email address');
  });

  it('finds protected fingerprints in annotated-tag metadata', () => {
    const { root, patternFile } = createRepository();
    const fingerprint = 'SYNTHETIC_TAG_METADATA_FINGERPRINT_51C8';
    writeFileSync(patternFile, `${fingerprint}\n`, 'utf8');
    runGit(root, ['tag', '-a', 'v1.0.0-synthetic', '-m', `Synthetic tag ${fingerprint}`]);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git tag');
    expect(result.stderr).toContain('matches a local private-content pattern');
  }, 15_000);

  it('finds a protected fingerprint in a historical path name', () => {
    const { root, patternFile } = createRepository();
    const fingerprint = 'SYNTHETIC_HISTORY_PATH_FINGERPRINT_19E7';
    const file = `notes/${fingerprint}.md`;
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, file), '# Synthetic history path fixture\n', 'utf8');
    writeFileSync(patternFile, `${fingerprint}\n`, 'utf8');
    runGit(root, ['add', '--', file]);
    runGit(root, ['commit', '-m', 'Add synthetic protected path fixture']);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path matches a local private-content pattern');
  }, 15_000);

  it('finds a generic email-like identifier in a historical path name', () => {
    const { root, patternFile } = createRepository();
    const file = `records/${syntheticEmail}.txt`;
    mkdirSync(join(root, 'records'));
    writeFileSync(join(root, file), 'Synthetic history path fixture\n', 'utf8');
    runGit(root, ['add', '--', file]);
    runGit(root, ['commit', '-m', 'Add synthetic generic path fixture']);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path contains possible email address');
  });

  it.each([
    ['branch', 'refs/heads'],
    ['tag', 'refs/tags'],
    ['remote-tracking', 'refs/remotes/origin'],
    ['pull audit', 'refs/pull/123'],
  ])(
    'finds protected fingerprints in %s ref names',
    (_label, namespace) => {
      const { root, patternFile } = createRepository();
      const fingerprint = 'SYNTHETIC_REF_NAME_FINGERPRINT_84D2';
      writeFileSync(patternFile, `${fingerprint}\n`, 'utf8');
      runGit(root, ['update-ref', `${namespace}/${fingerprint}`, 'HEAD']);

      const result = runHistoryCheck(root, patternFile);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Git ref');
      expect(result.stderr).toContain('matches a local private-content pattern');
    },
    15_000,
  );

  it('applies generic privacy rules to ref names', () => {
    const { root, patternFile } = createRepository();
    runGit(root, ['update-ref', `refs/heads/${syntheticEmail}`, 'HEAD']);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git ref');
    expect(result.stderr).toContain('possible email address');
  });

  it('rejects shallow repositories before claiming complete-history review', () => {
    const { root: source } = createRepository();
    writeFileSync(join(source, 'README.md'), '# Synthetic second revision\n', 'utf8');
    runGit(source, ['add', '--', 'README.md']);
    runGit(source, ['commit', '-m', 'Create second synthetic revision']);
    const cloneParent = createTemporaryRoot();
    const shallowRoot = join(cloneParent, 'shallow');
    runGit(undefined, ['clone', '--depth=1', pathToFileURL(source).href, shallowRoot]);
    const patternFile = join(shallowRoot, '.synthetic-privacy-patterns');
    writeFileSync(patternFile, 'SYNTHETIC_PATTERN_NOT_PRESENT_9174\n', 'utf8');

    const result = runHistoryCheck(shallowRoot, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Shallow repositories cannot prove complete');
  });

  it('rejects a prohibited Unicode historical path without relying on quoted Git output', () => {
    const { root, patternFile } = createRepository();
    writeFileSync(join(root, 'résumé.xlsx'), 'Synthetic prohibited artifact\n', 'utf8');
    runGit(root, ['add', '--', 'résumé.xlsx']);
    runGit(root, ['commit', '-m', 'Add synthetic prohibited path']);

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('résumé.xlsx');
    expect(result.stderr).toContain('prohibited private file type');
  });

  it('rejects a missing explicit pattern file', () => {
    const { root } = createRepository();

    const result = runHistoryCheck(root, join(root, 'missing-patterns'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicit pattern file does not exist');
  });

  it('rejects an empty explicit pattern file', () => {
    const { root, patternFile } = createRepository();
    writeFileSync(patternFile, '# Comments are not protected patterns\n\n', 'utf8');

    const result = runHistoryCheck(root, patternFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicit pattern file must be nonempty');
  });
});
