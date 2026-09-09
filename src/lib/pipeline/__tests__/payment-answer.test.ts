/**
 * WHO HAS NOT PAID — the decision, without a database.
 *
 * `buildUnpaidTail` (`bot-scheduler.ts:242-300`) is the shipped
 * definition of this truth and every rule below is taken from it. The
 * cases are not invented: each `it` names the live Sutton FC row it was
 * measured against on 2026-09-09.
 */
import { describe, it, expect } from "vitest";
import { decidePaymentSnapshot } from "../payment-answer";

const HOLDER = "u-elvin";

type Input = Parameters<typeof decidePaymentSnapshot>[0];

function input(over: Partial<Input> = {}): Input {
  return {
    paymentTracking: false,
    paymentCollection: true,
    paymentHolderId: HOLDER,
    match: {
      kickoffLabel: "Tue 21:15",
      status: "COMPLETED" as const,
      isHistorical: false,
      paymentLinksReleasedAt: new Date("2026-09-08T21:51:18.823Z"),
      confirmed: [
        { userId: HOLDER, paid: false },
        { userId: "u-a", paid: true },
        { userId: "u-b", paid: true },
        { userId: "u-c", paid: true },
        { userId: "u-d", paid: true },
        { userId: "u-e", paid: false },
        { userId: "u-f", paid: false },
        { userId: "u-g", paid: false },
        { userId: "u-h", paid: false },
        { userId: "u-i", paid: false },
      ],
      creditCount: 0,
    },
    ...over,
  };
}

describe("the org gate is the SOURCE OF TRUTH, not the flag with the matching name", () => {
  it("counts for Sutton FC, whose paymentTracking is OFF (the live 2026-09-08 row)", () => {
    // THE DECISION THIS FILE EXISTS FOR. Sutton has
    // `paymentTrackingEnabled = false` — they opted out on 2026-04-29
    // because Elvin tracks the money offline — and yet
    // `Attendance.paidAt` is accurate for every match: 4 of 10 on
    // 2026-09-08, 7 of 10 on 07-14, 13 of 14 on 06-30. It is written by
    // the Stripe webhook (`payment-flow.ts:157`) and by the collector
    // confirming a direct payment (`actions/payments.ts:327`), both of
    // which belong to paymentCOLLECTION.
    //
    // Gating on `paymentTracking` would tell a club MatchTime does not
    // know, on a night MatchTime knows exactly.
    const r = decidePaymentSnapshot(input());
    expect(r.kind).toBe("counted");
    if (r.kind !== "counted") return;
    // Nine chargeable (the collector is excluded), four paid.
    expect(r.chargeable).toBe(9);
    expect(r.unpaid).toBe(5);
    expect(r.kickoffLabel).toBe("Tue 21:15");
  });

  it("says NOT TRACKED — never an empty list — when the org does neither", () => {
    // "MatchTime does not know" and "everybody has paid" are different
    // answers and only one of them is true here.
    const r = decidePaymentSnapshot(
      input({ paymentTracking: false, paymentCollection: false }),
    );
    expect(r.kind).toBe("not_tracked");
  });

  it("counts on the poll path too, with collection off and tracking on", () => {
    const r = decidePaymentSnapshot(
      input({
        paymentTracking: true,
        paymentCollection: false,
        match: { ...input().match!, paymentLinksReleasedAt: null },
      }),
    );
    expect(r.kind).toBe("counted");
  });
});

describe("the match this is about", () => {
  it("refuses a match that is not COMPLETED", () => {
    // The same narrowing `admin-ops-engine-batch.ts` applies to a
    // payment credit and `buildUnpaidTail` applies to the chase. A
    // TEAMS_PUBLISHED match has ended but nothing about it is settled.
    const r = decidePaymentSnapshot(
      input({ match: { ...input().match!, status: "TEAMS_PUBLISHED" } }),
    );
    expect(r.kind).toBe("no_settled_match");
  });

  it("refuses a seeded historical match", () => {
    const r = decidePaymentSnapshot(
      input({ match: { ...input().match!, isHistorical: true } }),
    );
    expect(r.kind).toBe("no_settled_match");
  });

  it("refuses when there is no ended match at all", () => {
    expect(decidePaymentSnapshot(input({ match: null })).kind).toBe("no_settled_match");
  });
});

describe("no signal is not the same as nobody paid", () => {
  it("refuses to put a number on it when nothing has come through (the live 2026-09-01 row)", () => {
    // COMPLETED, nine confirmed, no fee, no links released, zero paid.
    // `buildUnpaidTail` returns null here in as many words: "could mean
    // nobody paid, but more likely means the poll fired before our
    // paid-tracking was live … 'N unpaid' is false precision".
    // Answering "9 haven't paid" would accuse nine people on no
    // evidence.
    const r = decidePaymentSnapshot(
      input({
        match: {
          ...input().match!,
          kickoffLabel: "Tue 21:30",
          paymentLinksReleasedAt: null,
          confirmed: input().match!.confirmed.map((c) => ({ ...c, paid: false })),
        },
      }),
    );
    expect(r.kind).toBe("no_signal");
  });

  it("a bulk credit alone is signal enough", () => {
    // The named-player path stamps `paidAt` and creates NO credit row;
    // the count-only path creates a credit and stamps nothing. So a
    // match with credits and no stamps is tracked, not silent.
    const r = decidePaymentSnapshot(
      input({
        match: {
          ...input().match!,
          creditCount: 4,
          confirmed: input().match!.confirmed.map((c) => ({ ...c, paid: false })),
        },
      }),
    );
    expect(r.kind).toBe("counted");
    if (r.kind !== "counted") return;
    expect(r.unpaid).toBe(5); // nine chargeable, four covered by the credit
  });
});

describe("the arithmetic", () => {
  it("excludes the money collector, who is owed rather than owing", () => {
    const r = decidePaymentSnapshot(input());
    if (r.kind !== "counted") throw new Error("expected counted");
    expect(r.chargeable).toBe(9);
  });

  it("does not exclude anyone when the org has set no collector", () => {
    const r = decidePaymentSnapshot(input({ paymentHolderId: null }));
    if (r.kind !== "counted") throw new Error("expected counted");
    expect(r.chargeable).toBe(10);
    expect(r.unpaid).toBe(6);
  });

  it("never goes negative when the credits exceed the outstanding rows", () => {
    const r = decidePaymentSnapshot(input({ match: { ...input().match!, creditCount: 99 } }));
    if (r.kind !== "counted") throw new Error("expected counted");
    expect(r.unpaid).toBe(0);
  });

  it("reports nobody outstanding when everyone has paid", () => {
    const r = decidePaymentSnapshot(
      input({
        match: {
          ...input().match!,
          confirmed: input().match!.confirmed.map((c) => ({ ...c, paid: true })),
        },
      }),
    );
    if (r.kind !== "counted") throw new Error("expected counted");
    expect(r.unpaid).toBe(0);
  });
});
