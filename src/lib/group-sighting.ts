/**
 * SIGNAL 1: AN INBOUND GROUP MESSAGE PROVES ITS SENDER IS IN THE GROUP.
 *
 * ── The hole this fills ──────────────────────────────────────────────
 *
 * `Membership.lastSeenInGroupAt` used to have exactly one writer: the
 * bot's startup participant sweep (`whatsapp-bot/src/index.ts` →
 * `/api/whatsapp/sync-participants` → `importParticipants`). That sweep
 * has been failing since 2026-07-07, because whatsapp-web.js's injected
 * page code is out of step with the live WhatsApp Web build: the chat
 * resolves, `chat.participants` comes back empty, nothing throws. Sutton
 * FC has 74 memberships, 64 with a sighting, the newest 07/07 16:08.
 *
 * A periodic sweep would fix nothing — the READ is what is broken, so it
 * would fail on a timer instead of on a restart.
 *
 * This is a second writer that needs nothing from the injected layer.
 * The analyze route already resolves the sender of every inbound group
 * message; a resolved sender's message in the org's monitored group is
 * direct, first-hand proof that they were in that group at that moment.
 *
 * ── THE HARD CONSTRAINT ─────────────────────────────────────────────
 *
 * PRESENCE IS PROVABLE; ABSENCE IS NOT. A member who never posts is
 * indistinguishable from one who left. So this signal may only ever ADD
 * evidence or REFRESH it. It writes ONE column and no other:
 *
 *   - it never writes `leftAt`,
 *   - it never deletes a membership,
 *   - it never creates one (a resolved user with no Membership row in
 *     this org is left exactly as found — provisioning is
 *     `resolve-sender.ts`'s job and stays there),
 *   - a member who does not post is not in the WHERE clause at all, so
 *     nothing about them is read, aged or changed.
 *
 * Leaving stays knowable only from `group_leave` or a working sweep.
 *
 * ── WHAT IT DOES *NOT* SAY ──────────────────────────────────────────
 *
 * It does NOT say the sweep is healthy. That is a different fact with a
 * different home, `Organisation.lastParticipantSweepAt`, and mixing the
 * two is the trap this whole change was designed around — see the
 * header of `group-membership-gate.ts`.
 */
import { db } from "@/lib/db";

/**
 * How stale a member's sighting must be before another message from them
 * is allowed to refresh it.
 *
 * SIX HOURS. The reasoning:
 *
 *   - Every consumer of this column reasons in DAYS or in "null vs not
 *     null". The self-IN gate only asks `!== null`. The roster survey
 *     asks "within 7 days". Sub-day precision buys nobody anything.
 *   - The Pi flushes a batch every ~10 minutes and a lively group can
 *     put one player in a dozen consecutive batches. Six hours caps a
 *     chatty player at four writes a day instead of dozens, while a
 *     player who says one thing all week still gets stamped that day.
 *   - It is short enough that the timestamp an admin reads on the
 *     dashboard is never wrong by more than a quarter of a day, which is
 *     the only place sub-week precision is ever looked at.
 *
 * The throttle is expressed as a WHERE predicate rather than a
 * read-then-write, so the throttled case is one indexed UPDATE that
 * matches zero rows: no extra query, and no lost update if two batches
 * land at once.
 */
export const GROUP_SIGHTING_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** The only field of a resolved sender this module reads. Deliberately
 *  structural rather than importing `ResolvedSender`: a sighting must
 *  never come to depend on a name, a phone, or a message body. */
interface HasUserId {
  userId: string | null;
}

/**
 * The distinct users a batch proves were in the group, in first-seen
 * order.
 *
 * Drops unresolved senders. An unresolved sender proves SOMEBODY is in
 * the group but not WHO, and there is no row to refresh — the
 * unresolved-sender nudge and the `nameless-senders` health finding are
 * what handle that case, not this.
 *
 * Dedupes, so a player who sends nine messages in one batch contributes
 * one id rather than nine.
 */
export function sightedUserIds(senders: Iterable<HasUserId | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of senders) {
    const id = s?.userId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Stamp "seen in the group" on the memberships of everyone who posted.
 *
 * One `updateMany` for the whole batch, outside any per-message loop.
 * That is deliberate: `analyze/route.ts` is ~4,000 lines of fast paths
 * and a write buried inside that loop is exactly the shape of the
 * terminal-short-circuit bug class that has produced six incidents (see
 * `lib/pipeline/clause-peel.ts`) — a `continue` added above it would
 * delete it silently and nobody would notice for weeks.
 *
 * Returns the number of rows actually refreshed (0 when everyone was
 * inside the throttle window). NEVER throws: gathering evidence about
 * who is in a group must not be able to take down attendance
 * processing for a live fixture. A failure is logged loudly instead,
 * saying what it costs.
 */
export async function recordGroupSightings(
  orgId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<number> {
  if (userIds.length === 0) return 0;
  const cutoff = new Date(now.getTime() - GROUP_SIGHTING_THROTTLE_MS);
  try {
    const res = await db.membership.updateMany({
      where: {
        orgId,
        userId: { in: userIds },
        // `leftAt` is the authoritative record of a departure, written by
        // `group_leave` and by admins. A replayed message must not quietly
        // refresh a row we have positively recorded as departed; the gate
        // denies on `leftAt` first anyway, so there is nothing to gain and
        // a contradiction to lose.
        leftAt: null,
        // The throttle. The `null` branch is what makes a never-seen
        // member (Raihan) get a sighting from their VERY FIRST message
        // rather than waiting out a window.
        OR: [{ lastSeenInGroupAt: null }, { lastSeenInGroupAt: { lt: cutoff } }],
      },
      data: { lastSeenInGroupAt: now },
    });
    return res.count;
  } catch (err) {
    console.error(
      `[group-sighting] failed to record sightings for org ${orgId} ` +
        `(${userIds.length} sender(s)). Nothing else is affected by this — the batch's ` +
        "attendance writes and replies are unchanged — but these players' " +
        "Membership.lastSeenInGroupAt was not refreshed, so if the participant sweep is " +
        "also down they may be told the app cannot confirm their place in the group. " +
        "Cause:",
      err,
    );
    return 0;
  }
}
