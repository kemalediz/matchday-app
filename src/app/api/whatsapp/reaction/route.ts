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
    // Promote this bencher into CONFIRMED.
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
    return NextResponse.json({ ok: true, outcome: "confirmed" });
  }

  // 👎 — they can't play. Mark dropped, chain to next bencher.
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
  await requestBenchConfirmationOnDrop(bc.matchId);
  return NextResponse.json({ ok: true, outcome: "declined" });
}
