/**
 * Unit tests for the FORMAT-SWITCH SCHEDULE arithmetic
 * (src/lib/format-switch-time.ts).
 *
 * THE INCIDENT (2026-09-08, Sutton FC, live)
 * ------------------------------------------
 * Each format is its own Activity with its own London wall-clock `time`:
 *
 *     tuesday-7aside   time = "21:30"   playersPerTeam = 7
 *     tuesday-5aside   time = "21:15"   playersPerTeam = 5
 *
 * `switchMatchFormat` re-pointed `activityId` and reset `maxPlayers` but
 * never touched `Match.date`. So a match switched to 5-a-side kept the
 * 7-a-side kickoff (21:30) while pointing at an Activity configured for
 * 21:15 — and EVERY downstream post (chase, announcement, team sheet,
 * the 2-hour pre-kickoff message) reads `Match.date`. The owner spotted
 * the wrong kickoff himself, four hours before a real match.
 *
 * These tests pin the arithmetic that fixes it. All of it is London
 * WALL-CLOCK arithmetic resolved per calendar day via
 * `london-time.ts` — never the server clock, which on Vercel is UTC and
 * an hour out for half the year.
 */
import { describe, it, expect } from "vitest";
import {
  planFormatSwitchSchedule,
  renderKickoffMoveLine,
} from "@/lib/format-switch-time";

const HOUR = 60 * 60 * 1000;

/** Sutton prod, Tue 8 Sep 2026 (BST): 21:30 London = 20:30 UTC. */
const TUE_2130_BST = new Date("2026-09-08T20:30:00.000Z");
/** Same evening at 21:15 London = 20:15 UTC. */
const TUE_2115_BST = new Date("2026-09-08T20:15:00.000Z");

describe("planFormatSwitchSchedule — the headline case", () => {
  it("7-a-side 21:30 → 5-a-side 21:15 lands at 21:15 London on the SAME day", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });

    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-09-08T20:15:00.000Z");
    expect(plan.previousKickoff.toISOString()).toBe("2026-09-08T20:30:00.000Z");
    expect(plan.reason).toBe("moved");
  });

  it("the reverse direction, 5-a-side 21:15 → 7-a-side 21:30, moves LATER", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2115_BST,
      currentActivityTime: "21:15",
      newActivityTime: "21:30",
      newDeadlineHours: 0,
    });

    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-09-08T20:30:00.000Z");
  });
});

describe("planFormatSwitchSchedule — same-time formats are a NO-OP", () => {
  it("does not move when both activities carry the same time", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:30",
      newDeadlineHours: 5,
    });

    expect(plan.move).toBe(false);
    expect(plan.reason).toBe("same-time");
  });

  it("still a no-op when the two activities differ only in deadlineHours", () => {
    // The deadline is derived from the kickoff. If the kickoff is not
    // moving, nothing about the schedule is rewritten — a switch must
    // not silently re-cut sign-up time on a match whose kickoff is
    // unchanged.
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:30",
      newDeadlineHours: 24,
    });
    expect(plan.move).toBe(false);
  });
});

describe("planFormatSwitchSchedule — a manually-set kickoff is NOT stamped over", () => {
  it("leaves the kickoff alone when the match does not sit on its activity's default time", () => {
    // Reachable in-product: `createBlockBooking` takes an optional `time`
    // that overrides the Activity default for that whole block. An admin
    // who booked the pitch for 20:00 chose 20:00; a format switch must
    // not silently move the match to the new format's default.
    const bookedAt2000 = new Date("2026-09-08T19:00:00.000Z"); // 20:00 BST
    const plan = planFormatSwitchSchedule({
      currentKickoff: bookedAt2000,
      currentActivityTime: "21:30", // the activity default it does NOT sit on
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });

    expect(plan.move).toBe(false);
    expect(plan.reason).toBe("manual-override");
  });

  it("a one-minute divergence is still an override (no fuzzy matching)", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date(TUE_2130_BST.getTime() + 60 * 1000),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(false);
    expect(plan.reason).toBe("manual-override");
  });
});

describe("planFormatSwitchSchedule — attendanceDeadline", () => {
  it("is re-derived from the NEW kickoff and the NEW activity's deadlineHours", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 5,
    });

    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.attendanceDeadline.toISOString()).toBe(
      new Date(plan.kickoff.getTime() - 5 * HOUR).toISOString(),
    );
    expect(plan.attendanceDeadline.toISOString()).toBe("2026-09-08T15:15:00.000Z");
  });

  it("deadlineHours = 0 is a REAL value (Sutton prod) — deadline equals kickoff", () => {
    // The bug magnet: `deadlineHours || 5` would read Sutton's live 0 as
    // "unset" and silently close sign-ups five hours early.
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });

    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.attendanceDeadline.getTime()).toBe(plan.kickoff.getTime());
  });
});

describe("planFormatSwitchSchedule — DST", () => {
  it("late MARCH, before the BST switch: 21:30 GMT → 21:15 GMT (both UTC+0)", () => {
    // BST 2026 starts Sun 29 Mar. Tue 24 Mar is still GMT.
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-03-24T21:30:00.000Z"),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-03-24T21:15:00.000Z");
  });

  it("late MARCH, after the BST switch: 21:30 BST → 21:15 BST (both UTC+1)", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-03-31T20:30:00.000Z"),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-03-31T20:15:00.000Z");
  });

  it("late OCTOBER, before the GMT switch: 21:30 BST → 21:15 BST", () => {
    // BST 2026 ends Sun 25 Oct. Tue 20 Oct is still BST.
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-10-20T20:30:00.000Z"),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-10-20T20:15:00.000Z");
  });

  it("late OCTOBER, after the GMT switch: 21:30 GMT → 21:15 GMT", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-10-27T21:30:00.000Z"),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-10-27T21:15:00.000Z");
  });

  it("ON the BST→GMT changeover day itself (Sun 25 Oct 2026), evening kickoffs are GMT", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-10-25T21:30:00.000Z"),
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-10-25T21:15:00.000Z");
  });

  it("the calendar day is LONDON's, not UTC's — a post-midnight London kickoff stays on its London day", () => {
    // 2026-04-01 00:30 London (BST) = 2026-03-31T23:30Z. The London
    // calendar day is 1 Apr; the UTC calendar day is 31 Mar. Anchoring
    // on the UTC day would land the match 24h early.
    const plan = planFormatSwitchSchedule({
      currentKickoff: new Date("2026-03-31T23:30:00.000Z"),
      currentActivityTime: "00:30",
      newActivityTime: "00:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(plan.kickoff.toISOString()).toBe("2026-03-31T23:15:00.000Z");
  });
});

describe("planFormatSwitchSchedule — defensive", () => {
  it("a malformed activity time is a no-op, never a throw (this runs in a live admin path)", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "half nine",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(false);
    expect(plan.reason).toBe("unreadable-time");
  });

  it("a malformed CURRENT activity time is a no-op too", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "",
      newActivityTime: "21:15",
      newDeadlineHours: 0,
    });
    expect(plan.move).toBe(false);
    expect(plan.reason).toBe("unreadable-time");
  });

  it("a non-finite deadlineHours degrades to deadline = kickoff, never NaN", () => {
    const plan = planFormatSwitchSchedule({
      currentKickoff: TUE_2130_BST,
      currentActivityTime: "21:30",
      newActivityTime: "21:15",
      newDeadlineHours: Number.NaN,
    });
    expect(plan.move).toBe(true);
    if (!plan.move) throw new Error("unreachable");
    expect(Number.isNaN(plan.attendanceDeadline.getTime())).toBe(false);
    expect(plan.attendanceDeadline.getTime()).toBe(plan.kickoff.getTime());
  });
});

describe("renderKickoffMoveLine", () => {
  it("is empty when the kickoff did not move", () => {
    expect(
      renderKickoffMoveLine(
        planFormatSwitchSchedule({
          currentKickoff: TUE_2130_BST,
          currentActivityTime: "21:30",
          newActivityTime: "21:30",
          newDeadlineHours: 0,
        }),
      ),
    ).toBe("");
  });

  it("states the new London kickoff and the old one when it moved", () => {
    const line = renderKickoffMoveLine(
      planFormatSwitchSchedule({
        currentKickoff: TUE_2130_BST,
        currentActivityTime: "21:30",
        newActivityTime: "21:15",
        newDeadlineHours: 0,
      }),
    );
    expect(line).toContain("21:15");
    expect(line).toContain("21:30");
    // London wall clock, not UTC — the UTC hour (20:15) must not leak.
    expect(line).not.toContain("20:15");
  });
});
