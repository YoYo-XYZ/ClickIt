DROP TRIGGER reserve_credit;
CREATE TRIGGER reserve_credit BEFORE INSERT ON requests BEGIN
  SELECT CASE WHEN NEW.status != 'reserved' OR NEW.cost_nano != 11010048 OR NEW.cost_final != 0
    THEN RAISE(ABORT, 'invalid_reservation') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM credit_lots WHERE id = NEW.lot_id AND installation_id = NEW.installation_id
      AND granted - revoked - consumed - reserved > 0
  ) THEN RAISE(ABORT, 'no_credits') END;
  SELECT CASE WHEN (SELECT spent_nano + NEW.cost_nano > limit_nano FROM budget WHERE id = 1)
    THEN RAISE(ABORT, 'budget_exhausted') END;
END;
