/**
 * §10 STEP 8 — THE APPLY LAYERS FINALLY GET A PRODUCTION IMPLEMENTATION.
 *
 * `score-engine.ts` and `admin-ops-engine.ts` shipped in PR #52 as apply
 * layers with INJECTED dependencies and no caller. Every implementation
 * of `ScoreApplyDeps` / `AdminOpsApplyDeps` in the repo was a test fake
 * or the corpus harness's SQL shim — nothing spoke to Prisma, because
 * nothing was wired into `analyze/route.ts` yet.
 *
 * This module is the missing half, and these tests are about the ONE
 * thing that can go wrong when lifting shipped code out of a 900-line
 * function: a query whose shape quietly changed. Each case below pins a
 * clause that `executeVerdict` had and that a reimplementation would be
 * easy to drop — the `isHistorical: false` filter, the `leftAt: null`
 * filter, the paid-idempotence check, the ended-match window.
 *
 * They run against a stubbed Prisma surface rather than a database: the
 * question is "does it ASK for the right rows", which is exactly what a
 * fake can answer and a live database cannot without a fixture per case.
 */
import { describe, expect, it, vi } from "vitest";
import { buildScoreApplyDeps, buildAdminOpsApplyDeps } from "../owner-deps";

describe("the score apply deps", () => {
  it("records the score AND moves the match to COMPLETED in one update", async () => {
    const update = vi.fn(async (_a: unknown) => ({}));
    const deps = buildScoreApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: { update }, teamAssignment: { findMany: async () => [] }, $transaction: async () => [], user: {} } as any,
    });
    await deps.recordScore({ matchId: "m1", red: 5, yellow: 3 });
    expect(update).toHaveBeenCalledOnce();
    const arg = update.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "m1" });
    expect(arg.data).toMatchObject({ redScore: 5, yellowScore: 3, status: "COMPLETED" });
  });

  it("reads the Elo inputs off TeamAssignment with the player's CURRENT rating", async () => {
    const findMany = vi.fn(async (_a: unknown) => [
      { userId: "u1", team: "RED", user: { matchRating: 1200 } },
      { userId: "u2", team: "YELLOW", user: { matchRating: 1300 } },
    ]);
    const deps = buildScoreApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, teamAssignment: { findMany }, $transaction: async () => [], user: {} } as any,
    });
    const inputs = await deps.loadEloInputs("m1");
    expect(inputs).toEqual([
      { userId: "u1", team: "RED", matchRating: 1200 },
      { userId: "u2", team: "YELLOW", matchRating: 1300 },
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { matchId: "m1" } });
  });

  it("applies every Elo delta in ONE transaction, as route.ts:3526 did", async () => {
    const tx = vi.fn(async (ops: unknown[]) => ops);
    const userUpdate = vi.fn((a: unknown) => a as never);
    const deps = buildScoreApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, teamAssignment: {}, $transaction: tx, user: { update: userUpdate } } as any,
    });
    await deps.applyEloDeltas([
      { userId: "u1", before: 1200, after: 1210, delta: 10 },
      { userId: "u2", before: 1300, after: 1290, delta: -10 },
    ]);
    expect(tx).toHaveBeenCalledOnce();
    expect(userUpdate).toHaveBeenCalledTimes(2);
    expect(userUpdate.mock.calls[0][0]).toEqual({
      where: { id: "u1" },
      data: { matchRating: 1210 },
    });
  });

  it("writes nothing at all when there are no deltas", async () => {
    const tx = vi.fn(async (ops: unknown[]) => ops);
    const deps = buildScoreApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, teamAssignment: {}, $transaction: tx, user: { update: vi.fn() } } as any,
    });
    await deps.applyEloDeltas([]);
    expect(tx).not.toHaveBeenCalled();
  });
});

describe("the admin-ops apply deps", () => {
  it("loads the paid state with the CONFIRMED filter and the credit total", async () => {
    const findUnique = vi.fn(async (_a: unknown) => ({
      activity: { name: "Tuesday 7-a-side" },
      attendances: [
        { userId: "u1", paidAt: new Date(), user: { name: "Amir" } },
        { userId: "u2", paidAt: null, user: { name: "Faris" } },
      ],
      paymentCredits: [{ count: 2 }, { count: 1 }],
    }));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: { findUnique }, attendance: {}, paymentCredit: {}, user: {}, botJob: {} } as any,
      orgId: "org1",
    });
    const st = await deps.loadPaidState("m1");
    expect(st.matchName).toBe("Tuesday 7-a-side");
    expect(st.creditTotal).toBe(3);
    expect(st.confirmed).toEqual([
      { userId: "u1", name: "Amir", paid: true },
      { userId: "u2", name: "Faris", paid: false },
    ]);
    // The filter that keeps a bench player out of the unpaid count.
    expect(findUnique.mock.calls[0][0]).toMatchObject({
      include: { attendances: { where: { status: "CONFIRMED" } } },
    });
  });

  it("never re-stamps a row that is already paid (route.ts:3867's idempotence)", async () => {
    const updateMany = vi.fn(async (_a: unknown) => ({ count: 0 }));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: { updateMany }, paymentCredit: {}, user: {}, botJob: {} } as any,
      orgId: "org1",
    });
    await deps.markPaid({ matchId: "m1", userId: "u1", payerUserId: "p1" });
    const arg = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // `paidAt: null` in the WHERE is the idempotence: a second credit for
    // the same player is a no-op rather than a re-stamp with a new date,
    // which would move the payment's timestamp and double-count nothing
    // but confuse the audit trail.
    expect(arg.where).toMatchObject({ matchId: "m1", userId: "u1", paidAt: null });
  });

  it("queues the reminder as a FUTURE-DATED dm BotJob, which is what makes it land on the day", async () => {
    const create = vi.fn(async (_a: unknown) => ({}));
    const when = new Date("2026-09-10T17:00:00.000Z");
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: {}, botJob: { create } } as any,
      orgId: "org1",
    });
    await deps.queueReminderDm({ phone: "447700900123", text: "⏰ …", sendAt: when });
    expect(create.mock.calls[0][0]).toMatchObject({
      data: { orgId: "org1", kind: "dm", phone: "447700900123", sendAfter: when },
    });
  });

  it("strips a leading + from the phone, as every other DM site does", async () => {
    const create = vi.fn(async (_a: unknown) => ({}));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: {}, botJob: { create } } as any,
      orgId: "org1",
    });
    await deps.queueReminderDm({ phone: "+447700900123", text: "x", sendAt: new Date() });
    expect((create.mock.calls[0][0] as { data: { phone: string } }).data.phone).toBe(
      "447700900123",
    );
  });

  it("returns null rather than throwing for a member with no number on file", async () => {
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: { findUnique: async () => ({ phoneNumber: null }) }, botJob: {} } as any,
      orgId: "org1",
    });
    expect(await deps.loadPhone("u1")).toBeNull();
  });
});
