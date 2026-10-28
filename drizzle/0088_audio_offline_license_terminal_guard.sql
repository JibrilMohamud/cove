-- A revoked or expired seven-day audio license is never reactivated.
-- Renewals must issue a new license row and token (the existing refresh path
-- already revokes the previous license and mints a new independent ID).
-- This guard does not extend offline revocation to disconnected devices:
-- previously downloaded keys remain bounded by license expiry/reconnect.
CREATE TRIGGER IF NOT EXISTS audio_offline_licenses_no_terminal_resurrection
BEFORE UPDATE OF status ON audio_offline_licenses
WHEN (OLD.status='revoked' AND NEW.status<>'revoked')
  OR (OLD.status='expired' AND NEW.status='active')
BEGIN
  SELECT RAISE(ABORT,'A revoked or expired audio license requires a newly issued token');
END;
