/**
 * §3.2 S22 — the calendar arithmetic, taken off the model.
 *
 * The row's own "where it goes" column reads: *"extractor returns the
 * phrase; `date-fns-tz` resolves it"*. Everything below is the second
 * half of that sentence, and every case is pinned against a FIXED `now`
 * so a test cannot pass because of what day it is run on.
 *
 * `NOW` is Saturday 5 September 2026, 18:00 London (BST, UTC+1). The
 * British Summer Time offset is deliberate: a resolver that built its
 * dates in UTC would be an hour out for eight months of the year and the
 * error would be invisible in a winter test run.
 */
import { describe, it, expect } from "vitest";
import { resolveReminderPhrase } from "../reminder-time";

/** Sat 5 Sep 2026, 18:00 London = 17:00 UTC (BST). */
const NOW = new Date("2026-09-05T17:00:00.000Z");
/** Sat 5 Dec 2026, 18:00 London = 18:00 UTC (GMT). */
const NOW_WINTER = new Date("2026-12-05T18:00:00.000Z");

function at(phrase: string, now: Date = NOW) {
  const r = resolveReminderPhrase(phrase, now);
  if (!r.ok) throw new Error(`expected "${phrase}" to resolve, got: ${r.reason}`);
  return r;
}

describe("relative days", () => {
  it('"tomorrow" lands on the next day at the 09:00 default', () => {
    const r = at("tomorrow");
    expect(r.at.toISOString()).toBe("2026-09-06T08:00:00.000Z"); // 09:00 BST
    expect(r.statedTime).toBe(false);
    expect(r.whenLabel).toBe("Sun 6 Sep");
  });

  it('"tomorrow at 6" reads 6 as the EVENING, the way a person means it', () => {
    // 6am reminders are not a thing anybody asks for in a football
    // group, and the shipped prompt's own worked example is "tomorrow at
    // 6" → 18:00. A bare 1-7 is pm.
    const r = at("tomorrow at 6");
    expect(r.at.toISOString()).toBe("2026-09-06T17:00:00.000Z");
    expect(r.statedTime).toBe(true);
    expect(r.whenLabel).toBe("Sun 6 Sep at 18:00");
  });

  it('"tomorrow at 6am" is respected when the am is explicit', () => {
    expect(at("tomorrow at 6am").at.toISOString()).toBe("2026-09-06T05:00:00.000Z");
  });

  it('"tomorrow morning" resolves the part of the day', () => {
    const r = at("tomorrow morning");
    expect(r.at.toISOString()).toBe("2026-09-06T08:00:00.000Z");
    expect(r.statedTime).toBe(true);
  });

  it('"tonight" is today, in the evening', () => {
    expect(at("tonight").at.toISOString()).toBe("2026-09-05T19:00:00.000Z"); // 20:00 BST
  });

  it('"the day after tomorrow" is two days out', () => {
    expect(at("the day after tomorrow").whenLabel).toBe("Mon 7 Sep");
  });
});

describe("weekdays", () => {
  it('"on Monday" from a Saturday is the next Monday', () => {
    expect(at("on Monday").whenLabel).toBe("Mon 7 Sep");
  });

  it('"next Tuesday" is the next Tuesday, not the one after', () => {
    expect(at("next Tuesday").whenLabel).toBe("Tue 8 Sep");
  });

  it("a weekday that is TODAY means the one a week out, never zero days", () => {
    // "remind me on Saturday", said on a Saturday, is about next
    // Saturday. Resolving it to today would queue a reminder for a time
    // that has already passed, which the engine would then refuse — so
    // the request would be silently lost rather than honoured.
    expect(at("on Saturday").whenLabel).toBe("Sat 12 Sep");
  });

  it("a weekday carries a stated time", () => {
    const r = at("friday at 7pm");
    expect(r.at.toISOString()).toBe("2026-09-11T18:00:00.000Z");
    expect(r.whenLabel).toBe("Fri 11 Sep at 19:00");
  });
});

describe("durations", () => {
  it('"in 2 hours" is two hours from now, to the minute', () => {
    expect(at("in 2 hours").at.toISOString()).toBe("2026-09-05T19:00:00.000Z");
  });

  it('"in 30 minutes"', () => {
    expect(at("in 30 minutes").at.toISOString()).toBe("2026-09-05T17:30:00.000Z");
  });

  it('"in 3 days" keeps the time of day', () => {
    expect(at("in 3 days").at.toISOString()).toBe("2026-09-08T17:00:00.000Z");
  });

  it('"in a week"', () => {
    expect(at("in a week").at.toISOString()).toBe("2026-09-12T17:00:00.000Z");
  });

  it("a duration always states a time, because it names an instant", () => {
    expect(at("in 2 hours").statedTime).toBe(true);
  });
});

describe("a bare time of day", () => {
  it("lands today when it is still to come", () => {
    expect(at("at 8pm").at.toISOString()).toBe("2026-09-05T19:00:00.000Z");
  });

  it("rolls to tomorrow when it has already passed today", () => {
    // 18:00 now; "at 9am" today is gone. Queuing it for a time in the
    // past would be dropped by the engine's window check, so the request
    // would vanish.
    expect(at("at 9am").whenLabel).toBe("Sun 6 Sep at 09:00");
  });
});

describe("British Summer Time is not optional", () => {
  it("a December 09:00 is 09:00 UTC, not 08:00", () => {
    const r = resolveReminderPhrase("tomorrow", NOW_WINTER);
    expect(r.ok && r.at.toISOString()).toBe("2026-12-06T09:00:00.000Z");
  });
});

describe("what it refuses, loudly", () => {
  // The whole safety argument. Every one of these hands the message back
  // to the analyzer, which still resolves times with the mega-prompt —
  // so a refusal costs an analyzer call, never a wrong-day DM.
  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["before the match", "no date in it at all"],
    ["when the teams are out", "an event, not a time"],
    ["on the 12th", "a bare ordinal — the month is a guess"],
    ["next month", "too coarse to queue"],
    ["in a bit", "not a duration"],
    ["laterrr", "not a time"],
    ["in 400 days", "beyond anything a group reminder means"],
  ])('refuses %j (%s)', (phrase) => {
    const r = resolveReminderPhrase(phrase, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  });

  it("never returns an instant in the past", () => {
    for (const p of ["tomorrow", "on Monday", "in 2 hours", "at 9am", "tonight"]) {
      const r = resolveReminderPhrase(p, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.at.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("is a pure function — no clock of its own", () => {
    const a = resolveReminderPhrase("tomorrow at 6", NOW);
    const b = resolveReminderPhrase("tomorrow at 6", NOW);
    expect(a).toEqual(b);
  });
});
