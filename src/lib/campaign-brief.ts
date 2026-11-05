/**
 * ONE TEXT PER CAMPAIGN: ITS BRIEF (owner 2026-11-05, ONE-BRIEF-1105).
 *
 * A funnel campaign's `brief` is the one text the client reads and edits on the dashboard, and every LLM
 * working for the campaign reads it (`/start-run` serves it to every run). The legacy `instruction` (Copilot
 * person follow-ups, 2026-10-11) is folded INTO the brief and retired once its last reader is gone: never a
 * second text, never a text the client cannot see.
 *
 * Fold rule (pure): the brief first, the instruction appended as its own paragraph; a brief that already holds
 * the instruction is left as is (idempotent); no brief = the instruction becomes it. Migration 0086 applies the
 * same rule in SQL to the rows that existed.
 */
export function foldInstructionIntoBrief(brief: string | null | undefined, instruction: string | null | undefined): string | null {
  const b = brief ?? null;
  const i = instruction?.trim() ? instruction : null;
  if (i === null) return b;
  if (b === null || b.trim() === "") return i;
  if (b.includes(i)) return b;
  return `${b}\n\n${i}`;
}
