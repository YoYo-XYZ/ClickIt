// Build a release in dist without editing the developer installation.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const root = path.resolve(__dirname, '..');
const { values: { 'api-url': rawUrl = '', 'support-url': supportUrl } } = parseArgs({
  options: { 'api-url': { type: 'string' }, 'support-url': { type: 'string', default: 'mailto:thammatorn.j@gmail.com' } }
});
let apiUrl = '';
if (rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('--api-url must be an HTTPS origin, with no path or credentials.');
  apiUrl = parsed.origin;
}
if (!/^(mailto:[^\s]+@[^\s]+|https:\/\/[^\s]+)$/.test(supportUrl)) throw new Error('Use a valid support email link or HTTPS URL.');
const output = path.join(root, 'dist', 'extension');
// Remove only this generated directory so stale files never enter a release ZIP.
if (path.relative(path.join(root, 'dist'), output) !== 'extension') throw new Error('Unexpected package output path.');
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(root, 'extension'), output, { recursive: true });
fs.writeFileSync(path.join(output, 'config.js'), `globalThis.ClickItConfig = Object.freeze(${JSON.stringify({ apiUrl, supportUrl })});\n`);
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
if (apiUrl) manifest.host_permissions.push(`${apiUrl}/*`);
if (apiUrl) manifest.homepage_url = apiUrl;
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (process.platform === 'win32') {
  // Both paths are fixed inside dist; no shell interpolation of user arguments.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Compress-Archive -Path './dist/extension/*' -DestinationPath './dist/clickit-extension.zip' -Force"], { cwd: root, stdio: 'pipe' });
  console.log('Created dist/clickit-extension.zip');
}
console.log(`Created ${output}${apiUrl ? ` for ${apiUrl}` : ' in BYOK development mode; hosted service is unconfigured'}.`);
