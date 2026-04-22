/**
 * Bot hits this endpoint when someone casts a vote in a WhatsApp poll
 * that the bot posted.
 *
 * For MoM polls we match the picked option (a player name) against the
 * confirmed-attendance list for that match, then upsert a MoMVote for the
 * (matchId, voterId) pair. The MoMVote table already has a unique
 * constraint on (matchId, voterId), so a voter who votes in both the
 * WhatsApp poll AND via the app magic link will have a single deduped
 * entry — the most recent vote wins.
 *
 * For other polls (payment) we just ACK without acting — vote tracking
 * for payments isn't wired up yet.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { waMessageId, voterPhone, optionName } = body as {
    waMessageId: string;
    voterPhone: string;
    optionName: string | null;
  };

  if (!waMessageId || !voterPhone) {
    return NextResponse.json({ error: "waMessageId and voterPhone required" }, { status: 400 });
  }

  // Which poll did this vote land on?
  const sent = await db.sentNotification.findFirst({
    where: { waMessageId },
  });
  if (!sent) return NextResponse.json({ ok: true, ignored: "unknown-poll" });

  const isMomPoll = sent.kind.includes("mom-poll") || sent.key.includes(":mom-poll");
  const isPaymentPoll = sent.key.endsWith(":payment-poll");
  if (!isMomPoll && !isPaymentPoll) {
    return NextResponse.json({ ok: true, ignored: `unsupported-poll (${sent.kind})` });
  }
  if (!sent.matchId) return NextResponse.json({ ok: true, ignored: "no-matchId" });

  const matchId = sent.matchId;

  const normalised = normalisePhone(voterPhone);
  if (!normalised) return NextResponse.json({ ok: true, ignored: "bad-phone" });

  const voter = await db.user.findUnique({ where: { phoneNumber: normalised } });
  if (!voter) return NextResponse.json({ ok: true, ignored: "unknown-voter" });

  // Payment poll — any non-null option (either team) means "paid".
  // Un-vote clears the flag.
  if (isPaymentPoll) {
    const existing = await db.attendance.findUnique({
      where: { matchId_userId: { matchId, userId: voter.id } },
    });
    if (!existing) return NextResponse.json({ ok: true, ignored: "not-attending" });
    await db.attendance.update({
      where: { id: existing.id },
      data: { paidAt: optionName ? new Date() : null },
    });
    return NextResponse.json({ ok: true, action: optionName ? "paid" : "unpaid" });
  }

  // No option means the user un-voted — delete the MoMVote.
  if (!optionName) {
    await db.moMVote.deleteMany({
      where: { matchId, voterId: voter.id },
    });
    return NextResponse.json({ ok: true, action: "cleared" });
  }

  // Resolve option name → player via confirmed attendances for this match.
  const confirmed = await db.attendance.findMany({
    where: { matchId, status: "CONFIRMED" },
    include: { user: { select: { id: true, name: true } } },
  });
  const normaliseName = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const target = confirmed.find(
    (a) => normaliseName(a.user.name ?? "") === normaliseName(optionName),
  );
  if (!target) {
    return NextResponse.json({ ok: true, ignored: "option-no-match" });
  }
  if (target.userId === voter.id) {
    // Can't vote for yourself via the poll either.
    return NextResponse.json({ ok: true, ignored: "self-vote" });
  }

  await db.moMVote.upsert({
    where: { matchId_voterId: { matchId, voterId: voter.id } },
    create: { matchId, voterId: voter.id, playerId: target.userId },
    update: { playerId: target.userId },
  });

  return NextResponse.json({ ok: true, action: "recorded", playerId: target.userId });
}
