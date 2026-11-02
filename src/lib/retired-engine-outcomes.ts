import type { Request, Response, NextFunction } from "express";

/**
 * `engineOutcomes` — the per-campaign list of results handed over to features-service's Engine — is RETIRED
 * (owner 2026-11-02, ENGINE-HANDOVER-RETIRE-1102: « mets sur tout partout pour tous les clients, il est temps de
 * migrer fully »).
 *
 * features-service's Engine drives every result of every live funnel campaign (ENGINE-FULL-MIGRATION-1102); there is
 * no hand-over, no opt-in, no opt-out. The field left the contract on every write and read and its column is dropped
 * (migration 0085). A caller still stating it gets a NAMED refusal rather than a bare "unrecognized key", so nobody
 * believes a campaign can switch the Engine on or off.
 *
 * Runs BEFORE `validateBody`.
 */
export function refuseRetiredEngineOutcomes(req: Request, res: Response, next: NextFunction) {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && body.engineOutcomes !== undefined) {
    return res.status(400).json({
      error: "engineOutcomes is retired: the Engine now chooses the workflow for every result of every campaign.",
      reason: "engine_outcomes_retired",
    });
  }
  next();
}
