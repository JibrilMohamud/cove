-- Deny-first invariant for the canonical production D1 authority.
-- Revocation, expiry and suspension cannot become new positive permission
-- simply because a stale publishing job/admin upsert replays the same ID.
-- Fresh independent approval must create a new grant/contract/royalty ID.
-- No grant creation is authorized here; positive owner migration remains gated.
CREATE TRIGGER IF NOT EXISTS rights_grants_no_terminal_resurrection
BEFORE UPDATE OF status ON rights_grants
WHEN OLD.status IN ('suspended','revoked','expired')
  AND NEW.status IN ('draft','active')
BEGIN
  SELECT RAISE(ABORT,'A withdrawn rights grant requires new independently verified authority');
END;

CREATE TRIGGER IF NOT EXISTS rights_contracts_no_terminal_resurrection
BEFORE UPDATE OF status ON rights_contracts
WHEN OLD.status IN ('suspended','expired','terminated')
  AND NEW.status IN ('draft','active')
BEGIN
  SELECT RAISE(ABORT,'A withdrawn rights contract requires new independently verified authority');
END;

CREATE TRIGGER IF NOT EXISTS finance_royalty_contracts_no_retired_resurrection
BEFORE UPDATE OF status ON finance_royalty_contracts
WHEN OLD.status='retired' AND NEW.status IN ('draft','active')
BEGIN
  SELECT RAISE(ABORT,'A retired royalty contract must not be reopened');
END;
