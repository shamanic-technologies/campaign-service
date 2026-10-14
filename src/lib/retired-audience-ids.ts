import type { Request, Response, NextFunction } from "express";

/**
 * `audienceIds` — the per-campaign audience SUBSET — is RETIRED (owner 2026-10-14, LEAK-1012).
 *
 * Who a pipe finds or contacts is that pipe's lead strategy (features-service plays, stated by the
 * workflow), never an audience list stored on a campaign. The field left the contract on every
 * write and read; a caller still stating a list gets a NAMED refusal rather than a silently dropped
 * field, so nobody believes a campaign is scoped when it is not. `null` (the old "inherit the
 * brand") is what every campaign now does, so it is accepted and ignored.
 *
 * Runs BEFORE `validateBody`, which strips unknown keys and would otherwise drop the list unseen.
 */
export function refuseRetiredAudienceIds(req: Request, res: Response, next: NextFunction) {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && body.audienceIds !== undefined && body.audienceIds !== null) {
    return res.status(400).json({
      error:
        "audienceIds is retired: a campaign no longer states an audience list. Who a pipe reaches is " +
        "decided by its lead strategy.",
      reason: "audience_ids_retired",
    });
  }
  next();
}
