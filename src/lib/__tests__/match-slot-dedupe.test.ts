/**
 * Unit tests for the SLOT-BASED dedupe used by the weekly match generator
 * (`/api/cron/generate-matches`).
 *
 * Bug #1 (2026-06-27, Sutton FC): an admin switched the Tuesday match from
 * 7-a-side → 5-a-side. `switchMatchFormat` only re-points the Match's
 * `activityId` to the 5-a-side Activity; it does NOT deactivate the old
 * 7-a-side Activity, which stays `isActive: true`. The generator deduped
 * by `activityId` ONLY, so when it ran for the still-active 7-a-side
 * Activity it CREATED A BRAND-NEW EMPTY 7-a-side ghost match.
 *
 * Bug #2 (THIS fix, 2026-06-29): the first fix keyed the slot on EXACT
 * `time` string equality — (orgId, venue, dayOfWeek, time). But the two
 * formats of the SAME recurring Tuesday fixture have DIFFERENT kickoff
 * times in prod: `tuesday-7aside` is "21:30", `tuesday-5aside` is "21:15".
 * `switchMatchFormat` keeps the original Match.date (the 21:30 instant), so
 * exact-time equality saw two different slots and STILL created the ghost.
 *
 * Fix: a "slot" is (orgId, venue, dayOfWeek) PLUS the match INSTANT, and two
 * slots match when org/venue/day are equal AND the instants are within a
 * ±90-minute tolerance. We compare the real Match.date instant against the
 * computed matchDate — the instant is the source of truth and is immune to
 * activity-`time` config drift (exactly the drift that broke fix #1). A 15-
 * minute format shift = same slot; a genuinely different session ≥ ~2h away
 * = different slot and still generates.
 *
 * Pure logic — no DB. The route loads candidate matches in the window and
 * delegates the decision here so the same predicate is unit-testable.
 */
import { describe, it, expect } from "vitest";
import {
  hasMatchForSlot,
  isSameSlot,
  SLOT_TIME_TOLERANCE_MS,
  type MatchSlot,
} from "@/lib/match-slot";

// Real prod instant: 2026-06-30 (Tuesday) 21:30 BST = 20:30 UTC.
const TUESDAY_2130_BST = new Date("2026-06-30T20:30:00Z");

const slot = (over: Partial<MatchSlot> = {}): MatchSlot => ({
  orgId: "sutton-fc",
  venue: "Goals North Cheam",
  dayOfWeek: 2, // Tuesday
  instant: TUESDAY_2130_BST,
  ...over,
});

const minutes = (n: number) => n * 60 * 1000;

describe("isSameSlot", () => {
  it("is true when org/venue/day match and instants are identical", () => {
    expect(isSameSlot(slot(), slot())).toBe(true);
  });

  it("is true when instants differ by a small format shift (15 min)", () => {
    const shifted = slot({ instant: new Date(TUESDAY_2130_BST.getTime() + minutes(15)) });
    expect(isSameSlot(slot(), shifted)).toBe(true);
  });

  it("is false when instants are ~2h apart (a different session)", () => {
    const later = slot({ instant: new Date(TUESDAY_2130_BST.getTime() + minutes(120)) });
    expect(isSameSlot(slot(), later)).toBe(false);
  });

  it("is false just outside the tolerance boundary", () => {
    const justOver = slot({
      instant: new Date(TUESDAY_2130_BST.getTime() + SLOT_TIME_TOLERANCE_MS + minutes(1)),
    });
    expect(isSameSlot(slot(), justOver)).toBe(false);
  });

  it("is false when the dayOfWeek differs", () => {
    expect(isSameSlot(slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 4 }))).toBe(false);
  });

  it("is false when the venue differs", () => {
    expect(
      isSameSlot(slot(), slot({ venue: "PlayFootball Mitcham" })),
    ).toBe(false);
  });

  it("is false when the org differs", () => {
    expect(isSameSlot(slot(), slot({ orgId: "other-org" }))).toBe(false);
  });
});

describe("hasMatchForSlot", () => {
  it("THE REGRESSION: a format-switched match at the SAME instant suppresses regeneration even though activity times differ (21:30 vs 21:15)", () => {
    // Generating for the still-active 7-a-side activity: computed matchDate
    // is the 21:30 BST instant. The switched 5-a-side match kept the
    // original Match.date — the SAME 21:30 instant — even though the
    // 5-a-side Activity is configured at 21:15. org/venue/day match and the
    // instants are identical → same slot → MUST suppress (no ghost).
    const generatingFor = slot({ instant: TUESDAY_2130_BST });
    const existing = [slot({ instant: TUESDAY_2130_BST })];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a small (15 min) time shift between formats still dedupes", () => {
    const generatingFor = slot({ instant: TUESDAY_2130_BST });
    const existing = [
      slot({ instant: new Date(TUESDAY_2130_BST.getTime() - minutes(15)) }),
    ];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a genuinely different SESSION (~2h off) at the same venue/day still generates", () => {
    // 18:00 league game vs 20:00 game at the same venue on Tuesday.
    const generatingFor = slot({ instant: new Date("2026-06-30T19:00:00Z") }); // 20:00 BST
    const existing = [slot({ instant: new Date("2026-06-30T17:00:00Z") })]; // 18:00 BST
    expect(hasMatchForSlot(generatingFor, existing)).toBe(false);
  });

  it("the ordinary case: same-slot match in the window suppresses a re-run", () => {
    expect(hasMatchForSlot(slot(), [slot()])).toBe(true);
  });

  it("a different venue on the same day/instant still generates", () => {
    const existing = [slot({ venue: "PlayFootball Mitcham" })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("a different dayOfWeek still generates", () => {
    const existing = [slot({ dayOfWeek: 4 })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("a different org never suppresses", () => {
    const existing = [slot({ orgId: "other-org" })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("no existing matches → generate", () => {
    expect(hasMatchForSlot(slot(), [])).toBe(false);
  });
});

/**
 * THE 2026-09-08 KICKOFF FIX vs THE GHOST.
 *
 * `switchMatchFormat` now MOVES `Match.date` to the new Activity's
 * configured time (see src/lib/format-switch-time.ts). The generator's
 * dedupe keys on the match INSTANT, so moving the instant is precisely
 * the thing that could resurrect the ghost. These tests prove it does
 * not, using the real Sutton prod pair (21:30 ↔ 21:15).
 *
 * The invariant: a switch moves the match by exactly
 * |newActivity.time − oldActivity.time| — 15 minutes for Sutton. Both
 * Activities stay `isActive`, so on its next run the generator computes a
 * slot for EACH of them and dedupe must suppress BOTH. It does, because
 * that difference is also the pre-condition for the pair to dedupe at
 * all: it had to be inside ±90 min BEFORE this fix (match parked at the
 * old format's time, other activity generating at the new one) exactly as
 * much as after it. The fix swaps which side of the pair carries the
 * offset; it does not widen it.
 */
describe("dedupe after switchMatchFormat moves the kickoff (2026-09-08)", () => {
  const SEVEN_2130 = new Date("2026-09-08T20:30:00Z"); // 21:30 BST
  const FIVE_2115 = new Date("2026-09-08T20:15:00Z"); // 21:15 BST

  it("switched to 5-a-side and moved to 21:15: the still-active 7-a-side activity generates NOTHING", () => {
    const switched = [slot({ instant: FIVE_2115 })];
    expect(hasMatchForSlot(slot({ instant: SEVEN_2130 }), switched)).toBe(true);
  });

  it("…and the 5-a-side activity it now belongs to also generates nothing (exact instant)", () => {
    const switched = [slot({ instant: FIVE_2115 })];
    expect(hasMatchForSlot(slot({ instant: FIVE_2115 }), switched)).toBe(true);
  });

  it("the reverse switch (5→7, moved to 21:30) suppresses BOTH activities' slots too", () => {
    const switched = [slot({ instant: SEVEN_2130 })];
    expect(hasMatchForSlot(slot({ instant: FIVE_2115 }), switched)).toBe(true);
    expect(hasMatchForSlot(slot({ instant: SEVEN_2130 }), switched)).toBe(true);
  });

  it("the move itself (15 min) is an order of magnitude inside the ±90 min tolerance", () => {
    const moveMs = Math.abs(SEVEN_2130.getTime() - FIVE_2115.getTime());
    expect(moveMs).toBe(15 * 60 * 1000);
    expect(moveMs).toBeLessThan(SLOT_TIME_TOLERANCE_MS);
  });

  it("the fix does not change WHICH format pairs ghost: a >90 min pair ghosted before and ghosts after, symmetrically", () => {
    // A hypothetical org with formats 2.5h apart (19:00 and 21:30) was
    // ALREADY outside tolerance before this fix: the switched match sat
    // at 19:00 and the 21:30 activity generated a ghost. After the fix it
    // sits at 21:30 and the 19:00 activity generates one. Same defect,
    // same count, owned by the other activity. The tolerance is a
    // property of the two configured times, not of this change.
    const early = new Date("2026-09-08T18:00:00Z"); // 19:00 BST
    const late = new Date("2026-09-08T20:30:00Z"); // 21:30 BST
    // before the fix — match parked at the old (19:00) time
    expect(hasMatchForSlot(slot({ instant: late }), [slot({ instant: early })])).toBe(false);
    // after the fix — match moved to the new (21:30) time
    expect(hasMatchForSlot(slot({ instant: early }), [slot({ instant: late })])).toBe(false);
  });
});
