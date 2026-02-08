-- Normalize campaign status to only 'ongoing' or 'stopped'
-- ongoing stays as-is, everything else (draft, paused, active, null) -> stopped
UPDATE campaigns SET status = 'stopped' WHERE status IS NULL OR status NOT IN ('ongoing');
