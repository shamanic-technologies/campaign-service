import { describe, it, expect } from "vitest";
import { NO_WORK_RECHECK_MS, idleNextRunAt } from "../../src/lib/idle-run.js";

// OLIVE-OWED-STARVED-1029: occurrence runs refused their person every minute and each pushed the owed-queue turn
// ten minutes away, so a client owed a check-in was never claimed during the day.
describe("idleNextRunAt", () => {
  const now = new Date("2026-10-29T13:30:00.000Z");
  const idle = new Date(now.getTime() + NO_WORK_RECHECK_MS);

  it("keeps a turn already scheduled sooner", () => {
    const sooner = new Date("2026-10-29T13:34:00.000Z");
    expect(idleNextRunAt(now, sooner)).toEqual(sooner);
  });

  it("waits the idle cadence when nothing sooner is scheduled", () => {
    expect(idleNextRunAt(now, null)).toEqual(idle);
    expect(idleNextRunAt(now, new Date("2026-10-29T15:00:00.000Z"))).toEqual(idle);
  });

  it("treats a turn already due as the one that just ran", () => {
    expect(idleNextRunAt(now, new Date("2026-10-29T13:20:00.000Z"))).toEqual(idle);
  });

  it("a burst of idle occurrence runs never moves the turn later", () => {
    let next: Date | null = null;
    for (let minute = 0; minute < 9; minute++) {
      const t = new Date(now.getTime() + minute * 60_000);
      next = idleNextRunAt(t, next);
    }
    expect(next).toEqual(idle);
  });
});
