PRAGMA foreign_keys = ON;

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX trial_ip ON installations(ip_hash, created_at);

CREATE TABLE budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spent_nano INTEGER NOT NULL DEFAULT 0 CHECK (spent_nano >= 0),
  limit_nano INTEGER NOT NULL DEFAULT 10000000000 CHECK (limit_nano >= 0)
);
INSERT INTO budget(id) VALUES (1);

CREATE TABLE orders (
  session_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  payment_intent TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount = 499),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  credits INTEGER NOT NULL CHECK (credits = 500),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL CHECK (total_amount >= amount),
  tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  stripe_fee INTEGER,
  stripe_fee_currency TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE credit_lots (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  order_id TEXT UNIQUE REFERENCES orders(session_id),
  granted INTEGER NOT NULL CHECK (granted > 0),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked BETWEEN 0 AND granted),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  created_at INTEGER NOT NULL,
  CHECK (consumed + reserved <= granted)
);
CREATE INDEX lots_owner ON credit_lots(installation_id, created_at);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  lot_id TEXT NOT NULL REFERENCES credit_lots(id),
  mode TEXT NOT NULL CHECK (mode IN ('text', 'vision')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'ready', 'settled', 'released')),
  cost_nano INTEGER NOT NULL DEFAULT 2688000,
  cost_final INTEGER NOT NULL DEFAULT 0 CHECK (cost_final IN (0, 1)),
  input_tokens INTEGER,
  api_ms INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX one_active_request ON requests(installation_id) WHERE status IN ('reserved', 'ready');
CREATE INDEX expired_requests ON requests(status, expires_at);

CREATE TRIGGER reserve_credit BEFORE INSERT ON requests BEGIN
  SELECT CASE WHEN NEW.status != 'reserved' OR NEW.cost_nano != 2688000 OR NEW.cost_final != 0
    THEN RAISE(ABORT, 'invalid_reservation') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM credit_lots WHERE id = NEW.lot_id AND installation_id = NEW.installation_id
      AND granted - revoked - consumed - reserved > 0
  ) THEN RAISE(ABORT, 'no_credits') END;
  SELECT CASE WHEN (SELECT spent_nano + NEW.cost_nano > limit_nano FROM budget WHERE id = 1)
    THEN RAISE(ABORT, 'budget_exhausted') END;
END;
CREATE TRIGGER credit_reserved AFTER INSERT ON requests BEGIN
  UPDATE credit_lots SET reserved = reserved + 1 WHERE id = NEW.lot_id;
  UPDATE budget SET spent_nano = spent_nano + NEW.cost_nano WHERE id = 1;
END;
CREATE TRIGGER valid_request_update BEFORE UPDATE ON requests BEGIN
  SELECT CASE WHEN NEW.id != OLD.id OR NEW.installation_id != OLD.installation_id OR NEW.lot_id != OLD.lot_id
    THEN RAISE(ABORT, 'immutable_request') END;
  SELECT CASE WHEN NEW.status != OLD.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('ready', 'released')) OR
    (OLD.status = 'ready' AND NEW.status IN ('settled', 'released'))
  ) THEN RAISE(ABORT, 'invalid_transition') END;
END;
CREATE TRIGGER credit_completed AFTER UPDATE OF status ON requests
WHEN NEW.status != OLD.status AND NEW.status IN ('settled', 'released') BEGIN
  UPDATE credit_lots SET reserved = reserved - 1,
    consumed = consumed + CASE WHEN NEW.status = 'settled' THEN 1 ELSE 0 END
    WHERE id = NEW.lot_id;
END;
CREATE TRIGGER reconcile_cost AFTER UPDATE OF cost_final ON requests
WHEN OLD.cost_final = 0 AND NEW.cost_final = 1 BEGIN
  UPDATE budget SET spent_nano = spent_nano - OLD.cost_nano + NEW.cost_nano WHERE id = 1;
END;

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX checkout_rate ON checkouts(installation_id, created_at);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  installation_id TEXT REFERENCES installations(id),
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_kind ON events(kind, created_at);
CREATE TABLE support_actions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  minutes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
