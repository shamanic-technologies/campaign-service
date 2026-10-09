import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { detectableTriggers, liveScopesBehind, planDelayScope, readDelayParams } from "./delay-trigger-detector.js";
import { pollDueTriggers, type PollTickSummary } from "./poll-trigger-detector.js";

/**
 * THE GENERIC TRIGGER DETECTORS' LOOP (owner 2026-10-09): `delay` and `poll` trigger types are
 * declared as DATA at features-service; this loop detects every one of them, no code per trigger.
 *
 * In-process, never a GitHub cron (a declared cadence is not a delivered one): a first tick
 * `TRIGGER_DETECTOR_FIRST_TICK_MS` after boot (deploys recreate the container more often than a long
 * interval fires), then every `TRIGGER_DETECTOR_INTERVAL_MS`, under a mutex (an overlapping tick is
 * skipped, never doubled). The idle probe is the catalogue read: no delay/poll trigger behind a live
 * campaign = nothing else is read. One log line per tick says what it did.
 *
 * The delay half PLANS events (lib/delay-trigger-detector.ts) and wakes the scheduler, whose
 * due-event tick is the one door that fires them; the poll half reads each due source and fires its
 * new items through the same door's dispatch (lib/poll-trigger-detector.ts).
 */

export const TRIGGER_DETECTOR_INTERVAL_MS = 5 * 60_000;
export const TRIGGER_DETECTOR_FIRST_TICK_MS = 60_000;

let running = false;

export interface DetectorTickSummary {
  delay: { triggers: number; scopes: number; planned: number };
  poll: PollTickSummary;
}

/** One detector pass. Null = skipped (a tick is already running, or the catalogue is unreadable). */
export async function runTriggerDetectorsTick(
  now: Date = new Date(),
  onPlanned: () => void = () => {},
): Promise<DetectorTickSummary | null> {
  if (running) return null;
  running = true;
  try {
    const catalogue = await fetchChannelCatalogue();
    if (!catalogue.ok) {
      console.warn(`[campaign-service] trigger detectors tick skipped: catalogue unreadable (${catalogue.detail})`);
      return null;
    }

    const delay = { triggers: 0, scopes: 0, planned: 0 };
    for (const trigger of detectableTriggers(catalogue, "delay", readDelayParams)) {
      delay.triggers += 1;
      for (const scope of await liveScopesBehind(trigger.transitions)) {
        delay.scopes += 1;
        delay.planned += await planDelayScope({ id: trigger.type.id, params: trigger.params }, scope, now);
      }
    }
    if (delay.planned > 0) onPlanned();

    const poll = await pollDueTriggers(catalogue, now);

    const idle = delay.triggers === 0 && poll.triggers === 0;
    console.log(
      idle
        ? "[campaign-service] trigger detectors tick: idle (no delay or poll trigger behind a live campaign)"
        : `[campaign-service] trigger detectors tick: delay triggers=${delay.triggers} scopes=${delay.scopes} planned=${delay.planned}; ` +
          `poll triggers=${poll.triggers} scopes=${poll.scopes} polled=${poll.polled} baseline=${poll.baseline} fired=${poll.fired} held=${poll.held} failed=${poll.failed}`,
    );
    return { delay, poll };
  } finally {
    running = false;
  }
}

/** Start the loop. Returns a stop function. */
export function startTriggerDetectors(onPlanned: () => void): () => void {
  const tick = () => {
    void runTriggerDetectorsTick(new Date(), onPlanned).catch((err) => {
      console.error("[campaign-service] trigger detectors tick error:", err);
    });
  };
  console.log(
    `[campaign-service] Trigger detectors starting (first tick in ${TRIGGER_DETECTOR_FIRST_TICK_MS}ms, then every ${TRIGGER_DETECTOR_INTERVAL_MS}ms)`,
  );
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, TRIGGER_DETECTOR_INTERVAL_MS);
  }, TRIGGER_DETECTOR_FIRST_TICK_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
