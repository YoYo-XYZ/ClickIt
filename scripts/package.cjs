// Package the production extension in dist without changing its source.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (process.argv.length > 2) throw new Error('Build configuration arguments are no longer supported. Run npm run package:extension without arguments.');
const output = path.join(root, 'dist', 'extension');
// Remove only this generated directory so stale files never enter a release ZIP.
if (path.relative(path.join(root, 'dist'), output) !== 'extension') throw new Error('Unexpected package output path.');
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(root, 'extension'), output, { recursive: true });
if (process.platform === 'win32') {
  // Both paths are fixed inside dist; no shell interpolation of user arguments.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Compress-Archive -Path './dist/extension/*' -DestinationPath './dist/clickit-extension.zip' -Force"], { cwd: root, stdio: 'pipe' });
  console.log('Created dist/clickit-extension.zip');
}
console.log(`Created ${output}.`);
