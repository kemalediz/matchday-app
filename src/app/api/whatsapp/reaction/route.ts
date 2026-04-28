/**
 * Bot posts here when a reaction arrives on a tracked message (currently
 * just bench-prompt messages). We resolve the corresponding
 * PendingBenchConfirmation and update attendance accordingly.
 *
 * 👍 from the right user → promote to CONFIRMED
 * 👎 from the right user → mark DROPPED (their own "pass"), trigger next bench
 * Any reaction from a different user is ignored.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { requestBenchConfirmationOnDrop } from "@/lib/bot-scheduler";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { waMessageId, emoji, fromPhone } = body as {
    waMessageId: string;
    emoji: string;
    fromPhone: string;
  };
  if (!waMessageId || !emoji || !fromPhone) {
    return NextResponse.json({ error: "waMessageId, emoji, fromPhone required" }, { status: 400 });
  }

  const bc = await db.pendingBenchConfirmation.findFirst({
    where: { waMessageId, resolvedAt: null },
    include: { match: true },
  });
  if (!bc) return NextResponse.json({ ok: true, ignored: "no-pending-confirmation" });

  const normalised = normalisePhone(fromPhone);
  if (!normalised) return NextResponse.json({ ok: true, ignored: "bad-phone" });

  const user = await db.user.findUnique({ where: { phoneNumber: normalised } });
  if (!user || user.id !== bc.userId) {
    // Someone else reacted — ignore. Only the bench user's own reaction counts.
    return NextResponse.json({ ok: true, ignored: "wrong-user" });
  }

  const isYes = emoji === "👍" || emoji === "👍🏻" || emoji === "👍🏼" || emoji === "👍🏽" || emoji === "👍🏾" || emoji === "👍🏿";
  const isNo = emoji === "👎" || emoji === "👎🏻" || emoji === "👎🏼" || emoji === "👎🏽" || emoji === "👎🏾" || emoji === "👎🏿";

  if (!isYes && !isNo) {
    return NextResponse.json({ ok: true, ignored: "not-yes-no" });
  }

  if (isYes) {
    // Step 1 (always): mark PBC confirmed and promote attendance.
    await db.$transaction([
      db.pendingBenchConfirmation.update({
        where: { id: bc.id },
        data: { resolvedAt: new Date(), outcome: "confirmed" },
      }),
      db.attendance.update({
        where: { matchId_userId: { matchId: bc.matchId, userId: bc.userId } },
        data: { status: "CONFIRMED" },
      }),
    ]);

    // Step 2 (only when context is available): transfer the dropped
    // player's TeamAssignment to this bench user and announce the
    // swap to the group. Wrapped in its own try so any failure here
    // never reverts the attendance promotion above — bench user is
    // confirmed regardless. Silent skips on any of the inputs being
    // missing keep the bot from posting nonsense.
    if (bc.replacingUserId) {
      try {
        const droppedTA = await db.teamAssignment.findUnique({
          where: {
            matchId_userId: { matchId: bc.matchId, userId: bc.replacingUserId },
          },
        });
        if (droppedTA) {
          // Transfer atomically. Use upsert in case the bench user
          // somehow already has a TA (shouldn't but cheap to guard).
          await db.$transaction([
            db.teamAssignment.delete({
              where: {
                matchId_userId: {
                  matchId: bc.matchId,
                  userId: bc.replacingUserId,
                },
              },
            }),
            db.teamAssignment.upsert({
              where: {
                matchId_userId: { matchId: bc.matchId, userId: bc.userId },
              },
              create: {
                matchId: bc.matchId,
                userId: bc.userId,
                team: droppedTA.team,
              },
              update: { team: droppedTA.team },
            }),
          ]);

          // Look up names + sport labels + org for the announcement.
          const [benchUser, droppedUser, matchWithCtx] = await Promise.all([
            db.user.findUnique({
              where: { id: bc.userId },
              select: { name: true },
            }),
            db.user.findUnique({
              where: { id: bc.replacingUserId },
              select: { name: true },
            }),
            db.match.findUnique({
              where: { id: bc.matchId },
              include: {
                activity: { include: { sport: true, org: true } },
              },
            }),
          ]);
          if (matchWithCtx && benchUser?.name && droppedUser?.name) {
            const teamLabels = matchWithCtx.activity.sport.teamLabels as [
              string,
              string,
            ];
            const teamLabel =
              droppedTA.team === "RED" ? teamLabels[0] : teamLabels[1];
            await db.botJob.create({
              data: {
                orgId: matchWithCtx.activity.org.id,
                kind: "group",
                text:
                  `🎟 *Slot filled* — *${benchUser.name}* takes *${droppedUser.name}*'s place on *${teamLabel}* 🙌\n\n` +
                  `_If anyone wants to rebalance with the new line-up, just say "regenerate teams"._`,
              },
            });
          }
        }
        // If droppedTA is null (drop happened pre-team-generation, or
        // someone else already swapped), we silently skip the swap +
        // announcement. Bench user is still CONFIRMED from step 1.
      } catch (err) {
        // Don't let an announcement-side failure undo the confirm.
        console.error("[reaction] team-swap on confirm failed:", err);
      }
    }

    return NextResponse.json({ ok: true, outcome: "confirmed" });
  }

  // 👎 — they can't play. Mark dropped, chain to next bencher with
  // the SAME replacingUserId so the next prompt offers the same slot.
  await db.$transaction([
    db.pendingBenchConfirmation.update({
      where: { id: bc.id },
      data: { resolvedAt: new Date(), outcome: "declined" },
    }),
    db.attendance.update({
      where: { matchId_userId: { matchId: bc.matchId, userId: bc.userId } },
      data: { status: "DROPPED" },
    }),
  ]);
  await requestBenchConfirmationOnDrop(bc.matchId, bc.replacingUserId);
  return NextResponse.json({ ok: true, outcome: "declined" });
}
