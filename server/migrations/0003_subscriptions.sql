/* Existing orders and non-expiring credit lots retain their original contract. */
ALTER TABLE credit_lots ADD COLUMN expires_at INTEGER;
ALTER TABLE credit_lots ADD COLUMN subscription_invoice_id TEXT;
CREATE UNIQUE INDEX invoice_credit_grant ON credit_lots(subscription_invoice_id) WHERE subscription_invoice_id IS NOT NULL;

CREATE TABLE billing_accounts (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id),
  customer_id TEXT UNIQUE,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  checkout_id TEXT,
  checkout_session TEXT UNIQUE,
  checkout_plan TEXT,
  checkout_url TEXT,
  checkout_expires_at INTEGER,
  reconciled_at INTEGER NOT NULL DEFAULT 0,
  reconcile_error INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  status TEXT NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('basic','plus')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  scheduled_plan TEXT,
  schedule_id TEXT,
  pending_upgrade INTEGER NOT NULL DEFAULT 0,
  payment_url TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_live_subscription ON subscriptions(installation_id) WHERE status NOT IN ('canceled','incomplete_expired');
CREATE TABLE subscription_periods (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  allowance INTEGER NOT NULL CHECK(allowance IN (500,1200)),
  PRIMARY KEY(subscription_id,period_start),
  UNIQUE(subscription_id,period_end)
);
CREATE TABLE subscription_invoices (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  payment_intent TEXT UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('monthly','upgrade')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL CHECK(total_amount>=0),
  tax_amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL CHECK(currency='usd'),
  credits INTEGER NOT NULL CHECK(credits>=0),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  stripe_fee INTEGER,
  stripe_fee_currency TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE billing_operations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  result TEXT
);

DROP TRIGGER reserve_credit;
CREATE TRIGGER reserve_credit BEFORE INSERT ON requests BEGIN
  SELECT CASE WHEN NEW.status != 'reserved' OR NEW.cost_nano != 11010048 OR NEW.cost_final != 0
    THEN RAISE(ABORT, 'invalid_reservation') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM credit_lots WHERE id=NEW.lot_id AND installation_id=NEW.installation_id
      AND granted-revoked-consumed-reserved>0
      AND (expires_at IS NULL OR expires_at>NEW.created_at)
  ) THEN RAISE(ABORT, 'no_credits') END;
  SELECT CASE WHEN (SELECT spent_nano+NEW.cost_nano>limit_nano FROM budget WHERE id=1)
    THEN RAISE(ABORT, 'budget_exhausted') END;
END;
