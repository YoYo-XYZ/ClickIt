const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

test('Cloudflare D1 executes the migration and serializes competing reservations and budget holds', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  // D1 exec treats each line as a SQL program. Preserve trigger bodies in one program.
  const migrations = path.resolve(__dirname, '../server/migrations');
  for (const name of fs.readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
    if (name === '0004_remove_unused_billing_state.sql') await db.batch([
      db.prepare("INSERT INTO installations VALUES('existing','hash-existing','ip','demo',0,0)"),
      db.prepare("INSERT INTO credit_lots(id,installation_id,granted,created_at) VALUES('existing','existing',10,0)"),
      db.prepare("INSERT INTO billing_accounts(installation_id,customer_id,checkout_session,checkout_url,checkout_expires_at) VALUES('existing','cus_existing','cs_existing','https://checkout.stripe.com/old',100)"),
      db.prepare("INSERT INTO subscriptions(id,installation_id,status,plan_id,period_start,period_end,schedule_id,scheduled_plan,updated_at) VALUES('sub_existing','existing','active','plus',0,100,'sched_existing','basic',0)")
    ]);
    await db.exec(fs.readFileSync(path.join(migrations, name), 'utf8').replace(/\r?\n/g, ' '));
  }
  assert.equal((await db.prepare("SELECT granted FROM credit_lots WHERE installation_id='existing'").first()).granted, 10);
  assert.equal((await db.prepare("SELECT customer_id FROM billing_accounts WHERE installation_id='existing'").first()).customer_id, 'cus_existing');
  assert.equal((await db.prepare("SELECT scheduled_plan FROM subscriptions WHERE installation_id='existing'").first()).scheduled_plan, 'basic');
  for (const [table, removed] of [['billing_accounts', ['checkout_url', 'checkout_expires_at']], ['subscriptions', ['schedule_id']]]) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    assert.ok(removed.every(name => !results.some(column => column.name === name)));
  }
  await db.batch([
    db.prepare("INSERT INTO installations VALUES('a','hash-a','ip','demo',0,0)"),
    db.prepare("INSERT INTO installations VALUES('b','hash-b','ip','demo',0,0)"),
    db.prepare("INSERT INTO credit_lots(id,installation_id,granted,created_at) VALUES('a','a',1,0)"),
    db.prepare("INSERT INTO credit_lots(id,installation_id,granted,created_at) VALUES('b','b',1,0)")
  ]);
  const reserve = (requestId, owner) => db.prepare("INSERT INTO requests(id,installation_id,lot_id,mode,created_at,expires_at,cost_nano) VALUES(?,?,?,'text',0,100,11010048)").bind(requestId, owner, owner).run();
  const competed = await Promise.allSettled([reserve('r1','a'), reserve('r2','a')]);
  assert.equal(competed.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.prepare("SELECT reserved FROM credit_lots WHERE id='a'").first()).reserved, 1);
  await db.prepare("UPDATE requests SET status='released' WHERE installation_id='a'").run();
  assert.equal((await db.prepare("SELECT reserved FROM credit_lots WHERE id='a'").first()).reserved, 0);
  await db.prepare('UPDATE budget SET limit_nano=22020096').run();
  const lastBudget = await Promise.allSettled([reserve('r3','a'), reserve('r4','b')]);
  assert.equal(lastBudget.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.prepare('SELECT spent_nano FROM budget').first()).spent_nano, 22020096);
  await db.batch([
    db.prepare("INSERT INTO installations VALUES('c','hash-c','ip','demo',0,0)"),
    db.prepare("INSERT INTO credit_lots(id,installation_id,granted,created_at,expires_at) VALUES('monthly-c','c',500,0,10)"),
    db.prepare('UPDATE budget SET limit_nano=10000000000'),
    db.prepare("INSERT INTO billing_accounts(installation_id) VALUES('c')")
  ]);
  await assert.rejects(() => db.prepare("INSERT INTO requests(id,installation_id,lot_id,mode,created_at,expires_at,cost_nano) VALUES('expired-c','c','monthly-c','text',10,100,11010048)").run(), /no_credits/);
  const leases=await Promise.all(['first','second'].map(lease=>db.prepare("UPDATE billing_accounts SET lease_id=?,lease_until=100 WHERE installation_id='c' AND lease_until<=0").bind(lease).run()));
  assert.equal(leases.reduce((sum,result)=>sum+result.meta.changes,0),1);
  // An old handler cannot release a lease that a newer handler acquired.
  const owner=(await db.prepare("SELECT lease_id FROM billing_accounts WHERE installation_id='c'").first()).lease_id;
  const stale=await db.prepare("UPDATE billing_accounts SET lease_until=0 WHERE installation_id='c' AND lease_id=?").bind(owner==='first'?'second':'first').run();
  assert.equal(stale.meta.changes,0);
});
