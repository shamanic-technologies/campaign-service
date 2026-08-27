/**
 * WHO OPERATES AN ACQUISITION CHANNEL — features-service's statement, asked rather than held.
 *
 * A chain is sold LEG BY LEG, and the legs the platform does not automate are performed by a human
 * at the CUSTOMER's side: they work the replies, they run the meeting, they close the deal. There
 * is no DAG for that and there must not be one — the work happens off-platform and the customer
 * reports what happened, lead by lead. So "this channel has no active workflow" means two opposite
 * things depending on who operates it: for a PLATFORM channel it means nothing can run it yet
 * (skip, exactly as before), and for a CUSTOMER-operated one it is the point.
 *
 * features-service publishes the answer on its PUBLIC acquisition-channel catalogue, which is why
 * this read carries no identity at all: no customer identity ever appears on that path (the
 * marketing site is generated from it). It is also why nothing here holds a list of manual slugs —
 * a ninth customer-operated channel published upstream works with no change in this repo, the same
 * posture this service holds for the goal, the funnel and the channel vocabularies.
 *
 * Contract (features-service): GET /public/channels (no auth, no identity)
 *   -> { channels: [{ slug, operatedBy: "platform" | "customer", ... }], steps: [...] }
 *
 * A channel the catalogue does not publish, and a catalogue that cannot be READ, both resolve to
 * "platform" at the call site — i.e. to today's behaviour exactly. That direction is deliberate:
 * an outage of this read must never stop a platform channel being provisioned, and it must never
 * stand up a workflow-less campaign on a guess. The customer-operated pair simply waits for the
 * next sweep.
 */
export type ChannelOperator = "platform" | "customer";

export type ChannelCatalogueRead =
  | { ok: true; operatorBySlug: Map<string, ChannelOperator> }
  | { ok: false; detail: string };

export async function fetchChannelOperators(): Promise<ChannelCatalogueRead> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  if (!baseUrl) {
    return { ok: false, detail: "FEATURES_SERVICE_URL not configured" };
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/public/channels`);
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = "";
      }
      return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
    }

    const data = await res.json() as {
      channels?: Array<{ slug?: unknown; operatedBy?: unknown }>;
    };
    if (!Array.isArray(data.channels)) {
      return { ok: false, detail: "response states no channels array" };
    }

    const operatorBySlug = new Map<string, ChannelOperator>();
    for (const channel of data.channels) {
      if (typeof channel?.slug !== "string" || channel.slug.length === 0) continue;
      // Only the two published values are read. A third one this service has never heard of is
      // NOT guessed at: it is left out of the map, so the call site treats that channel exactly
      // as it treats one the catalogue does not publish.
      if (channel.operatedBy !== "platform" && channel.operatedBy !== "customer") continue;
      operatorBySlug.set(channel.slug, channel.operatedBy);
    }
    return { ok: true, operatorBySlug };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
