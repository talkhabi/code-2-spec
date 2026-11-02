import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * code2spec needs node:sqlite: built in from Node 22.5, but only behind --experimental-sqlite before 22.13.
 * Legacy projects often pin an older Node (Volta/nvm), and the Claude Code plugin starts inside the project,
 * so instead of failing we relaunch with the flag, or with a newer Node found on this machine.
 * Must not import anything that loads node:sqlite.
 */
export async function runWithSqlite(main: () => Promise<unknown>) {
  try {
    await import('node:sqlite');
  } catch {
    if (process.env.CODE2SPEC_RELAUNCHED) fail();
    const own = parseVersion(process.versions.node);
    if (supportsSqlite(own)) return relaunch(process.execPath, own);
    const other = findNewerNode();
    if (other) return relaunch(other.path, other.version);
    fail();
  }
  await main();
}

type Version = [number, number, number];

function parseVersion(v: string): Version {
  const [a, b, c] = v.replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  return [a, b, c];
}

const supportsSqlite = ([major, minor]: Version) => major > 22 || (major === 22 && minor >= 5);
const needsFlag = ([major, minor]: Version) => major === 22 && minor < 13;

function relaunch(nodePath: string, version: Version) {
  const flags = needsFlag(version) ? ['--experimental-sqlite', '--no-warnings'] : [];
  const child = spawn(nodePath, [...flags, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, CODE2SPEC_RELAUNCHED: '1' },
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
}

/** Newest Node >= 22.5 installed through Volta, nvm, fnm, asdf, Homebrew or the system. */
function findNewerNode(): { path: string; version: Version } | undefined {
  const home = homedir();
  const versionDirs: [string, string][] = [
    [join(home, '.volta/tools/image/node'), 'bin/node'],
    [join(process.env.NVM_DIR ?? join(home, '.nvm'), 'versions/node'), 'bin/node'],
    [join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin/node'],
    [join(home, '.local/share/fnm/node-versions'), 'installation/bin/node'],
    [join(home, '.asdf/installs/nodejs'), 'bin/node'],
  ];
  const found: { path: string; version: Version }[] = [];
  for (const [dir, bin] of versionDirs) {
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir)) {
      const path = join(dir, v, bin);
      if (existsSync(path)) found.push({ path, version: parseVersion(v) });
    }
  }
  for (const path of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (existsSync(path) && path !== process.execPath) found.push({ path, version: [0, 0, 0] });
  }
  // versioned installs first (newest wins); unversioned system paths are only a fallback
  const versioned = found.filter((f) => supportsSqlite(f.version)).sort((a, b) => compare(b.version, a.version));
  return versioned[0] ?? found.find((f) => f.version[0] === 0);
}

function compare(a: Version, b: Version) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function fail(): never {
  console.error(`code2spec needs Node.js 22.5 or newer (24 LTS recommended); this is Node ${process.versions.node} at ${process.execPath}.
Install Node 24 (e.g. "volta install node@24" or "nvm install 24"); code2spec finds it even when your project pins an older Node.`);
  process.exit(1);
}
