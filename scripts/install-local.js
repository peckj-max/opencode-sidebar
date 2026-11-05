'use strict';

/**
 * Copy this extension into the VS Code extensions folder it is installed in,
 * so a change made here is what the running editor loads.
 *
 * The extension is installed unpacked (`local.opencode-sidebar-<version>`), so
 * there is no vsce package step: the shipping files are mirrored in place.
 * Run from an npm script (`npm run sync:local`) after editing, then reload the
 * window — the extension host does not pick a new extension.js up on its own.
 *
 * `--extensions-dir <path>` overrides the target (e.g. a portable or Insiders
 * install); `--dry-run` reports what would change without writing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

/** Everything the extension needs at runtime; tests and docs stay behind. */
const SHIP = [
  'extension.js',
  'package.json',
  'README.md',
  '.vscodeignore',
  'media',
  'src',
  'LICENSE'
];

function parseArgs(argv) {
  const opts = { dryRun: false, extensionsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--extensions-dir') opts.extensionsDir = argv[++i];
    else if (arg.startsWith('--extensions-dir=')) opts.extensionsDir = arg.slice('--extensions-dir='.length);
  }
  return opts;
}

function defaultExtensionsDir() {
  // Same location VS Code uses on each platform for a user install.
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(home, '.vscode', 'extensions');
  if (process.platform === 'darwin') return path.join(home, '.vscode', 'extensions');
  return path.join(home, '.vscode', 'extensions');
}

function folderName(pkg) {
  // What VS Code names an unpacked extension: publisher.name-version.
  return `${pkg.publisher}.${pkg.name}-${pkg.version}`;
}

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    out.push(rel);
    return out;
  }
  for (const entry of fs.readdirSync(abs)) {
    walk(path.join(rel, entry), out);
  }
  return out;
}

function sameFile(a, b) {
  if (!fs.existsSync(b)) return false;
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extensionsDir = opts.extensionsDir || defaultExtensionsDir();
  const target = path.join(extensionsDir, folderName(pkg));

  if (!fs.existsSync(target)) {
    console.error(`Not installed: ${target}`);
    console.error('Install it once (copy the folder, or "Install from VSIX"), then re-run this.');
    process.exit(1);
  }

  const files = SHIP.reduce((acc, rel) => walk(rel, acc), []);
  let written = 0;
  let unchanged = 0;

  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(target, rel);
    if (sameFile(from, to)) {
      unchanged++;
      continue;
    }
    console.log(`${opts.dryRun ? 'would update' : 'updated'}  ${rel}`);
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    written++;
  }

  const verb = opts.dryRun ? 'would change' : 'changed';
  console.log(`\n${pkg.publisher}.${pkg.name} ${pkg.version} → ${target}`);
  console.log(`${written} file(s) ${verb}, ${unchanged} already up to date.`);
  if (written && !opts.dryRun) {
    console.log('Reload the window (Developer: Reload Window) to load the new code.');
  }
}

main();
