/**
 * SIGNAL 1: AN INBOUND GROUP MESSAGE PROVES ITS SENDER IS IN THE GROUP.
 *
 * `Membership.lastSeenInGroupAt` used to have exactly one writer, the
 * bot's startup participant sweep, and that sweep has been failing since
 * 2026-07-07 (the injected page code is out of step with the live
 * WhatsApp Web build). While it is down nobody's sighting is refreshed,
 * a real player who joined on Monday has no sighting at all, and the web
 * app tells him to his face that he is not in a group he is sitting in.
 *
 * This module adds the second writer. It needs nothing from the broken
 * injected layer: the analyze route already resolves the sender of every
 * inbound group message, and a resolved sender's message IS the proof.
 *
 * ── THE HARD CONSTRAINT THESE TESTS EXIST TO PIN ────────────────────
 *
 * PRESENCE IS PROVABLE; ABSENCE IS NOT. A member who never posts is
 * indistinguishable from one who left. So this signal may only ever ADD
 * evidence or REFRESH it:
 *
 *   - it never writes `leftAt`,
 *   - it never deletes a membership,
 *   - it never creates one either (a resolved user with no Membership
 *     row for this org is left exactly as it was found),
 *   - and a member who does not post is simply not in the update's
 *     WHERE clause, so nothing about them changes.
 *
 * Leaving stays knowable only from `group_leave` or a working sweep.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const updateMany = vi.fn();
const membershipUpdate = vi.fn();
const membershipCreate = vi.fn();
const membershipDelete = vi.fn();
const membershipDeleteMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      updateMany: (...a: unknown[]) => updateMany(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
      create: (...a: unknown[]) => membershipCreate(...a),
      delete: (...a: unknown[]) => membershipDelete(...a),
      deleteMany: (...a: unknown[]) => membershipDeleteMany(...a),
    },
  },
}));

import {
  GROUP_SIGHTING_THROTTLE_MS,
  sightedUserIds,
  recordGroupSightings,
} from "@/lib/group-sighting";

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

/** Shorthand: the single `updateMany` argument the module built. */
function call(): { where: Record<string, unknown>; data: Record<string, unknown> } {
  expect(updateMany).toHaveBeenCalledTimes(1);
  return updateMany.mock.calls[0][0];
}

describe("sightedUserIds — which senders count", () => {
  it("keeps a resolved sender", () => {
    expect(sightedUserIds([{ userId: "u1" }])).toEqual(["u1"]);
  });

  it("drops an UNRESOLVED sender", () => {
    // An unresolved sender proves SOMEBODY is in the group, but not WHO.
    // There is no row to refresh, so there is nothing to write.
    expect(sightedUserIds([{ userId: null }])).toEqual([]);
  });

  it("drops a missing entry without throwing", () => {
    expect(sightedUserIds([undefined, { userId: null }, { userId: "u1" }])).toEqual(["u1"]);
  });

  it("DEDUPES a chatty player: nine messages, one id", () => {
    const senders = Array.from({ length: 9 }, () => ({ userId: "chatty" }));
    expect(sightedUserIds(senders)).toEqual(["chatty"]);
  });

  it("keeps distinct senders in first-seen order", () => {
    expect(
      sightedUserIds([{ userId: "a" }, { userId: "b" }, { userId: "a" }, { userId: "c" }]),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("recordGroupSightings — the write", () => {
  const NOW = new Date("2026-09-09T19:00:00.000Z");

  it("refreshes the sighting of a resolved member who posted", async () => {
    const written = await recordGroupSightings("org-1", ["u1"], NOW);

    const { where, data } = call();
    expect(where.orgId).toBe("org-1");
    expect(where.userId).toEqual({ in: ["u1"] });
    expect(data).toEqual({ lastSeenInGroupAt: NOW });
    expect(written).toBe(1);
  });

  it("writes NOTHING when no sender resolved, and does not throw", async () => {
    await expect(recordGroupSightings("org-1", [], NOW)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never touches a member who did not post", async () => {
    await recordGroupSightings("org-1", ["poster"], NOW);
    const { where } = call();
    // The WHERE names the posters and nobody else, so a silent member is
    // untouched by construction — not marked absent, not aged, not read.
    expect(where.userId).toEqual({ in: ["poster"] });
  });

  it("NEVER marks anyone absent and NEVER removes a membership", async () => {
    await recordGroupSightings("org-1", ["u1", "u2"], NOW);
    const { data } = call();
    // The whole payload, asserted as a whole: one field. If anyone ever
    // adds `leftAt` here this test is the thing that stops them.
    expect(Object.keys(data)).toEqual(["lastSeenInGroupAt"]);
    expect(membershipDelete).not.toHaveBeenCalled();
    expect(membershipDeleteMany).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it("only ever refreshes an ACTIVE membership (leftAt stays authoritative)", async () => {
    await recordGroupSightings("org-1", ["u1"], NOW);
    expect(call().where.leftAt).toBeNull();
  });

  it("THROTTLES: the WHERE excludes anyone sighted inside the window", async () => {
    await recordGroupSightings("org-1", ["chatty"], NOW);
    const { where } = call();
    const cutoff = new Date(NOW.getTime() - GROUP_SIGHTING_THROTTLE_MS);
    // The throttle is a predicate, not a read-then-write: a chatty
    // player's second message in the same window matches zero rows, so
    // the cost of the throttled case is one indexed UPDATE of nothing.
    expect(where.OR).toEqual([
      { lastSeenInGroupAt: null },
      { lastSeenInGroupAt: { lt: cutoff } },
    ]);
  });

  it("a never-seen member is NOT throttled — the null branch always matches", async () => {
    // Raihan's half of the throttle: `lastSeenInGroupAt: null` is in the
    // OR, so the very first message from a member with no sighting writes
    // one immediately rather than waiting out a window.
    await recordGroupSightings("org-1", ["raihan"], NOW);
    expect(call().where.OR).toContainEqual({ lastSeenInGroupAt: null });
  });

  it("throttle granularity is 6 hours", () => {
    expect(GROUP_SIGHTING_THROTTLE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("a failed write is logged, not thrown — it must never break the batch", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(recordGroupSightings("org-1", ["u1"], NOW)).resolves.toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
