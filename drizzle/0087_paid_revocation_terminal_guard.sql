-- Canonical production D1 deny-first protection against stale payment,
-- refunded-order and protected-media writers. These guards do not themselves
-- grant paid authorization or replace the strongly consistent legal owner.
CREATE TRIGGER IF NOT EXISTS entitlements_revocation_is_terminal
BEFORE UPDATE OF status ON entitlements
WHEN OLD.status='revoked' AND NEW.status<>'revoked'
BEGIN
  SELECT RAISE(ABORT,'A revoked entitlement requires a fresh independently authorized purchase');
END;

CREATE TRIGGER IF NOT EXISTS commercial_delivery_grants_no_terminal_reuse
BEFORE UPDATE OF status ON commercial_delivery_grants
WHEN (OLD.status='revoked' AND NEW.status<>'revoked')
  OR (OLD.status IN ('expired','exhausted') AND NEW.status='active')
BEGIN
  SELECT RAISE(ABORT,'A revoked or consumed delivery grant cannot be reopened');
END;

CREATE TRIGGER IF NOT EXISTS commerce_orders_no_terminal_revival
BEFORE UPDATE OF status ON commerce_orders
WHEN OLD.status IN ('canceled','refunded','chargeback_lost')
  AND NEW.status NOT IN ('canceled','refunded','chargeback_lost')
BEGIN
  SELECT RAISE(ABORT,'A canceled or refunded order cannot return to payable status');
END;
