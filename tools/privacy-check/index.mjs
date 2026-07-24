import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { isProhibitedSourceFile, normalizeSourcePath } from './rules.mjs';
const emailAddressPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const trustedGitHubAutomationMetadataEmails = new Set([
  ['49699333+dependabot[bot]', 'users.noreply.github.com'].join('@'),
  ['41898282+github-actions[bot]', 'users.noreply.github.com'].join('@'),
  ['noreply', 'github.com'].join('@'),
  ['support', 'github.com'].join('@'),
]);
const secretPatterns = [
  {
    label: 'token or private key',
    pattern: /(gh[opsu]_[A-Za-z0-9_]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)/i,
  },
  {
    label: 'literal password',
    pattern: /password\s*[:=]\s*['"][^'"]{6,}/i,
    allow: (file) => file.startsWith('tests/'),
  },
  {
    label: 'personal Windows path',
    pattern:
      /C:\\Users\\(?!Example(?:\\|$)|Public(?:\\|$)|Default(?:\\|$)|<user>(?:\\|$))[^\\\s"']+/i,
  },
  {
    label: 'email address',
    pattern: emailAddressPattern,
    // Package-manager deprecation metadata can include upstream maintainer addresses.
    allow: (file) => file === 'pnpm-lock.yaml',
  },
];

const parseNullList = (value) => value.split('\0').filter(Boolean);
const git = (arguments_, options = {}) =>
  execFileSync('git', arguments_, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const gitBuffer = (arguments_, options = {}) =>
  execFileSync('git', arguments_, {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const decodeUtf8Path = (value, context) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error(`${context} contains a path that is not valid UTF-8.`);
  }
};

const parseNullTerminatedBuffer = (value, context) => {
  if (value.length === 0) return [];
  if (value[value.length - 1] !== 0) {
    throw new Error(`${context} was not NUL-terminated.`);
  }

  const records = [];
  let start = 0;
  while (start < value.length) {
    const end = value.indexOf(0, start);
    if (end < 0) throw new Error(`${context} could not be parsed safely.`);
    if (end > start) records.push(decodeUtf8Path(value.subarray(start, end), context));
    start = end + 1;
  }
  return records;
};

const parseObjectIds = (value) => {
  const objectIds = value.split(/\r?\n/).filter(Boolean);
  if (objectIds.length === 0 || objectIds.some((objectId) => !objectIdPattern.test(objectId))) {
    throw new Error('The reachable Git object list was empty or malformed.');
  }
  return new Set(objectIds.map((objectId) => objectId.toLowerCase()));
};

const parseObjectTypes = (value, expectedObjectIds) => {
  const objectTypes = new Map();
  for (const line of value.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit|tag|tree)$/i);
    if (!match) throw new Error('The reachable Git object metadata was malformed.');
    const objectId = match[1].toLowerCase();
    if (!expectedObjectIds.has(objectId) || objectTypes.has(objectId)) {
      throw new Error('The reachable Git object metadata was inconsistent.');
    }
    objectTypes.set(objectId, match[2].toLowerCase());
  }
  if (objectTypes.size !== expectedObjectIds.size) {
    throw new Error('Not every reachable Git object could be classified.');
  }
  return objectTypes;
};

const parseRefNames = (value) => {
  const refNames = value.split(/\r?\n/).filter(Boolean);
  if (
    refNames.length === 0 ||
    refNames.some(
      (refName) =>
        !refName.startsWith('refs/') ||
        [...refName].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
        }),
    )
  ) {
    throw new Error('The reachable Git ref-name list was empty or malformed.');
  }
  return refNames;
};

const parseTreeEntry = (record) => {
  const separator = record.indexOf('\t');
  if (separator < 0) throw new Error('A historical Git tree entry was not safely delimited.');
  const header = record.slice(0, separator);
  const file = record.slice(separator + 1);
  const match = header.match(/^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})$/i);
  if (!match || !file) throw new Error('A historical Git tree entry was malformed.');
  return { mode: match[1], type: match[2].toLowerCase(), objectId: match[3].toLowerCase(), file };
};

const mode = process.argv.includes('--history')
  ? 'history'
  : process.argv.includes('--staged')
    ? 'staged'
    : 'tracked';
const fileListIndex = process.argv.indexOf('--file-list');
const patternFileIndex = process.argv.indexOf('--pattern-file');
const localPatternPath =
  patternFileIndex >= 0 ? process.argv[patternFileIndex + 1] : '.privacy-patterns.local';
if (patternFileIndex >= 0 && (!localPatternPath || localPatternPath.startsWith('--'))) {
  console.error('Privacy check failed:\n--pattern-file requires a path.');
  process.exit(1);
}
if (patternFileIndex >= 0 && !existsSync(localPatternPath)) {
  console.error('Privacy check failed:\nThe explicit pattern file does not exist.');
  process.exit(1);
}

let localPatterns = [];
if (existsSync(localPatternPath)) {
  try {
    localPatterns = readFileSync(localPatternPath, 'utf8')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith('#'));
  } catch {
    console.error('Privacy check failed:\nThe pattern file could not be read safely.');
    process.exit(1);
  }
}
if (patternFileIndex >= 0 && localPatterns.length === 0) {
  console.error('Privacy check failed:\nThe explicit pattern file must be nonempty.');
  process.exit(1);
}

let files;
let historyEntries = [];
let historyObjectTypes = new Map();
let historyRefNames = [];
try {
  if (mode === 'history') {
    const shallowState = git(['rev-parse', '--is-shallow-repository']).trim();
    if (shallowState !== 'false') {
      throw new Error(
        shallowState === 'true'
          ? 'Shallow repositories cannot prove complete reachable-history privacy.'
          : 'The repository depth could not be established safely.',
      );
    }

    const objectIds = parseObjectIds(git(['rev-list', '--objects', '--no-object-names', '--all']));
    historyRefNames = parseRefNames(git(['for-each-ref', '--format=%(refname)']));
    historyObjectTypes = parseObjectTypes(
      git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        input: `${[...objectIds].join('\n')}\n`,
      }),
      objectIds,
    );

    const entryKeys = new Set();
    for (const [commitId, type] of historyObjectTypes) {
      if (type !== 'commit') continue;
      const records = parseNullTerminatedBuffer(
        gitBuffer(['ls-tree', '-r', '-z', '--full-tree', commitId]),
        `Git tree ${commitId}`,
      );
      for (const record of records) {
        const entry = parseTreeEntry(record);
        if (entry.type === 'blob' && historyObjectTypes.get(entry.objectId) !== 'blob') {
          throw new Error('A historical blob was missing from the reachable object set.');
        }
        const entryKey = `${entry.objectId}\0${entry.type}\0${entry.file}`;
        if (!entryKeys.has(entryKey)) {
          historyEntries.push(entry);
          entryKeys.add(entryKey);
        }
      }
    }
    files = new Set(historyEntries.map(({ file }) => file));
  } else if (fileListIndex >= 0) {
    const listPath = process.argv[fileListIndex + 1];
    if (!listPath) throw new Error('--file-list requires a path');
    const list = readFileSync(listPath === '-' ? 0 : listPath, 'utf8');
    files = new Set(
      list.includes('\0') ? parseNullList(list) : list.split(/\r?\n/).filter(Boolean),
    );
  } else {
    files = new Set(
      parseNullList(
        mode === 'staged'
          ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
          : git(['ls-files', '-z']),
      ),
    );
    if (mode === 'tracked') {
      for (const file of parseNullList(
        git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
      )) {
        files.add(file);
      }
    }
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : 'Unknown Git inspection error.';
  console.error(
    mode === 'history'
      ? `Privacy check failed:\nGit history could not be inspected safely: ${detail}`
      : 'Privacy check requires a Git repository.',
  );
  process.exit(1);
}

const failures = [];
const scanContent = (file, content) => {
  const normalized = normalizeSourcePath(file);
  for (const { label, pattern, allow } of secretPatterns) {
    const trustedAutomationMetadata =
      label === 'email address' &&
      /^(?:Git commit|Git tag) /u.test(normalized) &&
      (content.match(new RegExp(emailAddressPattern.source, 'gi')) ?? []).every((email) =>
        trustedGitHubAutomationMetadataEmails.has(email.toLowerCase()),
      );
    if (!allow?.(normalized) && !trustedAutomationMetadata && pattern.test(content)) {
      failures.push(`${file}: possible ${label}`);
    }
  }
  if (localPatterns.some((pattern) => content.toLowerCase().includes(pattern.toLowerCase()))) {
    failures.push(`${file}: matches a local private-content pattern`);
  }
};

const scanPath = (file) => {
  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(file)) failures.push(`${file}: path contains possible ${label}`);
  }
  if (localPatterns.some((pattern) => file.toLowerCase().includes(pattern.toLowerCase()))) {
    failures.push(`${file}: path matches a local private-content pattern`);
  }
};

for (const file of files) scanPath(file);

if (mode === 'history') {
  const blobPaths = new Map();
  for (const { objectId, type, file } of historyEntries) {
    const normalized = normalizeSourcePath(file);
    if (isProhibitedSourceFile(normalized)) {
      failures.push(
        `${file}: prohibited private file type, export name, or location in Git history`,
      );
    }
    if (type === 'blob') {
      const paths = blobPaths.get(objectId) ?? new Set();
      paths.add(file);
      blobPaths.set(objectId, paths);
    }
  }

  for (const refName of historyRefNames) {
    scanContent(`Git ref ${refName}`, refName);
  }

  for (const [objectId, type] of historyObjectTypes) {
    if (type !== 'commit' && type !== 'tag') continue;
    try {
      const metadata = decodeUtf8Path(
        gitBuffer(['cat-file', type, objectId]),
        `Git ${type} ${objectId}`,
      );
      scanContent(`Git ${type} ${objectId}`, metadata);
    } catch {
      failures.push(`Git ${type} ${objectId}: metadata could not be inspected safely`);
    }
  }

  for (const [objectId, type] of historyObjectTypes) {
    if (type !== 'blob') continue;
    try {
      const content = gitBuffer(['cat-file', 'blob', objectId]).toString('utf8');
      const paths = blobPaths.get(objectId);
      if (!paths || paths.size === 0) {
        scanContent(`Git blob ${objectId}`, content);
      } else {
        for (const file of paths) scanContent(file, content);
      }
    } catch {
      failures.push(`Git blob ${objectId}: history object could not be inspected safely`);
    }
  }
} else {
  for (const file of files) {
    const normalized = normalizeSourcePath(file);
    if (isProhibitedSourceFile(normalized)) {
      failures.push(`${file}: prohibited private file type, export name, or location`);
      continue;
    }
    if (!existsSync(file)) continue;
    try {
      scanContent(file, readFileSync(file, 'utf8'));
    } catch {
      // Binary files are covered by extension and location rules above.
    }
  }
}

if (failures.length > 0) {
  console.error(`Privacy check failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(
  `Privacy check passed for ${files.size} ${mode === 'history' ? 'historical paths' : mode === 'staged' ? 'staged' : 'tracked and staged'} file(s).`,
);
