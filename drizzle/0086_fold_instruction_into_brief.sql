-- ONE-BRIEF-1105 (owner 2026-11-05): a campaign has ONE text, its brief. Every funnel campaign's legacy
-- `instruction` is folded into its brief (lib/campaign-brief.ts `foldInstructionIntoBrief`): the brief first,
-- the instruction appended as its own paragraph; no brief = the instruction becomes it. Idempotent: a brief
-- already holding the instruction is skipped. The edit is dated (brief_updated_at) and attributed to nobody
-- (a system fold, no person typed it). `instruction` itself is kept until its last reader is gone.
UPDATE sales_funnel_campaigns
SET brief = CASE
      WHEN brief IS NULL OR btrim(brief) = '' THEN instruction
      ELSE brief || E'\n\n' || instruction
    END,
    brief_updated_at = now(),
    brief_updated_by_user_id = NULL,
    updated_at = now()
WHERE instruction IS NOT NULL
  AND btrim(instruction) <> ''
  AND (brief IS NULL OR strpos(brief, instruction) = 0);
