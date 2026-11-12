const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('packaging preserves the production source and rejects build overrides', t => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clickit-package-test-'));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('clickit-package-test-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  fs.cpSync(path.join(root, 'extension'), path.join(temporary, 'extension'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/package.cjs'), path.join(temporary, 'scripts/package.cjs'));
  const run = args => spawnSync(process.execPath, ['scripts/package.cjs', ...args], { cwd: temporary, encoding: 'utf8' });

  for (const args of [['--api-url', 'https://example.com'], ['--public-key-file', 'key.pem'], ['--support-url', 'mailto:test@example.com'], ['unexpected']]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Build configuration arguments are no longer supported/);
    assert.equal(fs.existsSync(path.join(temporary, 'dist')), false);
  }

  const output = path.join(temporary, 'dist/extension');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'stale.js'), 'obsolete');
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const source = path.join(root, 'extension');
  const files = fs.readdirSync(source, { recursive: true }).filter(file => fs.statSync(path.join(source, file)).isFile()).sort();
  const packaged = fs.readdirSync(output, { recursive: true }).filter(file => fs.statSync(path.join(output, file)).isFile()).sort();
  assert.deepEqual(packaged, files);
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(source, file)), file);
  if (process.platform === 'win32') assert.ok(fs.statSync(path.join(temporary, 'dist/clickit-extension.zip')).size > 0);

  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(output, 'config.js'), 'utf8'), context);
  const url = 'https://clickit.thammatorn-clickit.workers.dev';
  assert.equal(context.ClickItConfig.apiUrl, url);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes(`${url}/*`));
  assert.equal(manifest.homepage_url, url);
  assert.equal(manifest.version, require('../package.json').version);
  assert.equal(manifest.version, require('../package-lock.json').version);
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(root, 'docs/chrome-web-store-public-key.pem')));
  assert.equal(manifest.key, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(id, 'dfpglkafpdbnfecohhgmhkpceinhhpjl');
});
