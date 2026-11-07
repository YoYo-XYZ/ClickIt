// Run only after independently verifying Stripe payment ownership.
// Produces a credential file and a SQL file containing only its hash, never stdout secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const installationId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(installationId || '')) throw new Error('Usage: node scripts/recover.cjs <verified-installation-id>');
const directory = path.resolve(__dirname, '..', '.clickit-private', crypto.randomUUID());
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const credential = `ci_${crypto.randomBytes(32).toString('hex')}`;
const credentialHash = crypto.createHash('sha256').update(credential).digest('hex');
const keyPath = path.join(directory, 'access-key.txt');
fs.writeFileSync(keyPath, credential, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(directory, 'rotate.sql'), `UPDATE installations SET credential_hash='${credentialHash}' WHERE id='${installationId}';\nINSERT INTO support_actions(kind,installation_id,created_at) VALUES('access_recovery','${installationId}',unixepoch()*1000);\n`);
console.log(`Prepared recovery SQL and private access key in ${directory}. Apply rotate.sql to D1, then send access-key.txt only to the verified owner. The previous key will stop working.`);
