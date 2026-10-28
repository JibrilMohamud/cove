-- A terminated/superseded license version can never become the positive
-- authority again through a stale administrative edit or publication replay.
-- New independently approved permissions require a new contract version.
-- This trigger does not authorize any positive rights or change owner cutover.
CREATE TRIGGER IF NOT EXISTS rights_contract_versions_no_terminal_resurrection
BEFORE UPDATE OF status ON rights_contract_versions
WHEN OLD.status IN ('superseded','terminated')
  AND NEW.status IN ('draft','active')
BEGIN
  SELECT RAISE(ABORT,'Superseded or terminated contract versions require fresh independent approval');
END;
