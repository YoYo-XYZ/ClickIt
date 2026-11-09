// Explicit, billed operator smoke test. Never runs as part of npm test.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
(async () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server/wrangler.jsonc'), 'utf8'));
  const base = config.vars.PUBLIC_URL;
  if (!/^https:\/\//.test(base) || base.includes('REPLACE_')) throw new Error('Configure the deployed HTTPS origin first.');
  const origin = config.vars.EXTENSION_ORIGINS.split(',')[0];
  const headers = { 'Content-Type':'application/json', Origin:origin };
  async function api(route, body, credential) {
    const response = await fetch(base+'/v1/'+route, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{...headers,...(credential ? {Authorization:'Bearer '+credential} : {})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(20000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Hosted ${route} failed (HTTP ${response.status}): ${result.error || 'service unavailable'}`);
    return result;
  }
  const directory = path.resolve(__dirname, '../.clickit-private');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const filename = path.join(directory,'operator-smoke-'+crypto.createHash('sha256').update(base).digest('hex').slice(0,12)+'.json');
  let access;
  if (fs.existsSync(filename)) access = JSON.parse(fs.readFileSync(filename,'utf8'));
  else {
    const installation = await api('installations',{adultConsent:true,dataConsent:true,source:'direct'});
    access = {credential:installation.credential};
    fs.writeFileSync(filename,JSON.stringify(access),{flag:'wx',mode:0o600});
  }
  const before = await api('balance',undefined,access.credential);
  const requestId = crypto.randomUUID();
  const result = await api('answers',{requestId,mode:'text',question:{question:'What is 2 + 2?',options:['3','4']}},access.credential);
  const balance = await api('answers/complete',{requestId,delivered:true},access.credential);
  const correct = result.result?.index === 1;
  const settled = balance.credits === before.credits-1 && balance.reserved === 0;
  console.log(JSON.stringify({base,liveOpenRouterSmokePassed:correct && settled,correctAnswer:correct,
    creditSettled:settled,creditsRemaining:balance.credits,providerMs:result.apiMs,
    checkoutEnabled:balance.checkoutEnabled,visionEnabled:balance.visionEnabled}));
  if (!correct || !settled) process.exitCode=1;
})().catch(error => { console.error(error.message); process.exitCode=1; });
