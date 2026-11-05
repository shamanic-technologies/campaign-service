import type { Request, Response, NextFunction } from "express";

/**
 * `instruction` — a funnel campaign's second text (Copilot person follow-ups, 2026-10-11) — is RETIRED (owner
 * 2026-11-05, ONE-BRIEF-1105-REMOVE: « C'est quoi ce truc "instruction" qui overlap la campaign stratégie ? »).
 *
 * A campaign has ONE text, its `brief`, which the client edits on the dashboard and every LLM of every run reads
 * (`/start-run` `brief`). Migration 0086 folded the 20 prod instructions into their briefs; migration 0087 dropped
 * the column (snapshot kept). A caller still stating `instruction` gets a NAMED refusal rather than a bare
 * "unrecognized key", so nobody believes a second text still exists. Never re-add a second campaign text.
 *
 * Runs BEFORE `validateBody`.
 */
export function refuseRetiredInstruction(req: Request, res: Response, next: NextFunction) {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && body.instruction !== undefined) {
    return res.status(400).json({
      error: "instruction is retired: write what the campaign must say in its brief, the one text every AI of the campaign reads.",
      reason: "instruction_retired",
    });
  }
  next();
}
