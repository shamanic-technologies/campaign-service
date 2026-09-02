/**
 * WHO OPERATES AN ACQUISITION CHANNEL — features-service's statement, asked rather than held.
 *
 * A funnel is sold LEG BY LEG, and the legs the platform does not automate are performed by a human
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
 * The same catalogue is also the ONE place that says WHICH LEGS a channel performs. A leg is what
 * a customer buys — one leg belongs to several funnels at once, so the funnel never identified the
 * purchase — and the identifiers are minted and published there. They are carried verbatim: no leg
 * vocabulary, list or matrix exists in this service, and the identifier is never SPLIT back into
 * the two steps it connects (they ride beside it on the very same payload).
 *
 * Contract (features-service): GET /public/channels (no auth, no identity)
 *   -> { channels: [{ slug, operatedBy: "platform" | "customer",
 *                     stepTransitions: [{ legKey, from, to }], ... }], legs: [...], steps: [...] }
 *
 * A channel the catalogue does not publish, and a catalogue that cannot be READ, both resolve to
 * "platform" at the call site — i.e. to today's behaviour exactly. That direction is deliberate:
 * an outage of this read must never stop a platform channel being provisioned, and it must never
 * stand up a workflow-less campaign on a guess. The customer-operated pair simply waits for the
 * next sweep.
 */
export type ChannelOperator = "platform" | "customer";

/**
 * ONE leg of the published vocabulary, narrowed to what this service reads: the identifier it
 * carries verbatim, the step a lead is taken OUT of (`null` is "from nothing" — this leg starts a
 * funnel), and every declared funnel the leg is a leg of. The steps ride BESIDE the identifier on
 * the catalogue precisely so nobody splits it, so they are read here and never derived.
 */
export interface CatalogueLeg {
  legKey: string;
  fromStepKey: string | null;
  funnelKeys: ReadonlySet<string>;
}

export type ChannelCatalogueRead =
  | {
      ok: true;
      operatorBySlug: Map<string, ChannelOperator>;
      /**
       * channel slug -> the legs that channel PERFORMS, as features-service's own identifiers.
       * A slug the catalogue does not publish is absent, which is a different statement from a
       * channel that publishes an empty set, and the call site treats it as such.
       */
      legsBySlug: Map<string, ReadonlySet<string>>;
      /**
       * EVERY leg of every declared funnel, published beside the channels. Read so a caller naming
       * the step a lead just reached can be answered with the leg OUT of it, without this service
       * holding a leg vocabulary of its own.
       */
      legs: readonly CatalogueLeg[];
      /**
       * Every step key the catalogue publishes. A caller naming a step that is not one of these is
       * naming nothing, and is told so rather than answered with an empty result — the two are
       * different statements and only one of them is a caller's mistake.
       */
      stepKeys: ReadonlySet<string>;
    }
  | { ok: false; detail: string };

export async function fetchChannelCatalogue(): Promise<ChannelCatalogueRead> {
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
      channels?: Array<{
        slug?: unknown;
        operatedBy?: unknown;
        stepTransitions?: Array<{ legKey?: unknown }>;
      }>;
      legs?: Array<{
        legKey?: unknown;
        fromStep?: { key?: unknown } | null;
        funnelKeys?: unknown;
      }>;
      steps?: Array<{ key?: unknown }>;
    };
    if (!Array.isArray(data.channels)) {
      return { ok: false, detail: "response states no channels array" };
    }

    const operatorBySlug = new Map<string, ChannelOperator>();
    const legsBySlug = new Map<string, ReadonlySet<string>>();
    for (const channel of data.channels) {
      if (typeof channel?.slug !== "string" || channel.slug.length === 0) continue;
      // Which legs this channel performs. A channel that publishes none states an EMPTY set,
      // which is a truthful answer ("this channel performs no leg of any declared funnel") and
      // not the same thing as a slug the catalogue never names.
      const legs = new Set<string>();
      if (Array.isArray(channel.stepTransitions)) {
        for (const transition of channel.stepTransitions) {
          if (typeof transition?.legKey === "string" && transition.legKey.length > 0) {
            legs.add(transition.legKey);
          }
        }
      }
      legsBySlug.set(channel.slug, legs);
      // Only the two published values are read. A third one this service has never heard of is
      // NOT guessed at: it is left out of the map, so the call site treats that channel exactly
      // as it treats one the catalogue does not publish.
      if (channel.operatedBy !== "platform" && channel.operatedBy !== "customer") continue;
      operatorBySlug.set(channel.slug, channel.operatedBy);
    }
    const legs: CatalogueLeg[] = [];
    if (Array.isArray(data.legs)) {
      for (const leg of data.legs) {
        if (typeof leg?.legKey !== "string" || leg.legKey.length === 0) continue;
        const funnelKeys = new Set<string>();
        if (Array.isArray(leg.funnelKeys)) {
          for (const key of leg.funnelKeys) {
            if (typeof key === "string" && key.length > 0) funnelKeys.add(key);
          }
        }
        const fromKey = leg.fromStep?.key;
        legs.push({
          legKey: leg.legKey,
          // An ENTRY leg states no step before it, and that is an ordinary leg — the absence is
          // data, not a special spelling to branch on.
          fromStepKey: typeof fromKey === "string" && fromKey.length > 0 ? fromKey : null,
          funnelKeys,
        });
      }
    }

    const stepKeys = new Set<string>();
    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (typeof step?.key === "string" && step.key.length > 0) stepKeys.add(step.key);
      }
    }

    return { ok: true, operatorBySlug, legsBySlug, legs, stepKeys };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
