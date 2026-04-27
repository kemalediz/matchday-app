import { db } from "./db";
import { requestBenchConfirmationOnDrop, queueSlotEmojiRefresh } from "./bot-scheduler";

export async function registerAttendance(userId: string, matchId: string) {
  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  if (new Date() > match.attendanceDeadline) {
    throw new Error("Attendance deadline has passed");
  }

  // Idempotency: if the user is already CONFIRMED or BENCH for this
  // match, don't touch position/status. Without this guard, calling
  // registerAttendance twice (e.g. manual add followed by a matching
  // WhatsApp message) would bump the user's position to maxPos+1,
  // leaving a gap in the slot numbering.
  const existing = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    const all = await db.attendance.findMany({
      where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
      orderBy: { position: "asc" },
    });
    const confirmed = all.filter((a) => a.status === "CONFIRMED");
    const bench = all.filter((a) => a.status === "BENCH");
    const slot =
      existing.status === "CONFIRMED"
        ? confirmed.findIndex((a) => a.userId === userId) + 1
        : bench.findIndex((a) => a.userId === userId) + 1;
    return {
      status: existing.status,
      position: existing.position,
      slot,
      confirmedCount: confirmed.length,
      maxPlayers: match.maxPlayers,
    };
  }

  const maxPos = await db.attendance.aggregate({
    where: { matchId },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  const confirmedCount = await db.attendance.count({
    where: { matchId, status: "CONFIRMED" },
  });
  const benchCount = await db.attendance.count({
    where: { matchId, status: "BENCH" },
  });

  const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";

  const attendance = await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, status, position: nextPosition },
    update: { status, position: nextPosition, respondedAt: new Date() },
  });

  // Friendly "slot" the bot uses for its reaction emoji. If the player
  // made the squad, their slot is their 1-indexed place in the squad
  // (equals the new confirmed count). If they landed on the bench, it's
  // their 1-indexed bench slot.
  const slot =
    status === "CONFIRMED" ? confirmedCount + 1 : benchCount + 1;

  return {
    status: attendance.status,
    position: attendance.position,
    slot,
    confirmedCount: confirmedCount + (status === "CONFIRMED" ? 1 : 0),
    maxPlayers: match.maxPlayers,
  };
}

export async function cancelAttendance(userId: string, matchId: string) {
  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  if (new Date() > match.attendanceDeadline) {
    throw new Error("Attendance deadline has passed");
  }

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });

  if (!attendance) throw new Error("Not attending this match");

  const wasConfirmed = attendance.status === "CONFIRMED";

  await db.attendance.update({
    where: { id: attendance.id },
    data: { status: "DROPPED" },
  });

  // If someone in the confirmed 14 dropped, we DON'T auto-promote any more.
  // Instead we ask the first bench player via WhatsApp 👍/👎 first (they
  // may have mentally checked out). The bot-scheduler creates a
  // PendingBenchConfirmation; subsequent /due-posts cycles post the prompt
  // and handle confirmation/timeout.
  if (wasConfirmed) {
    await requestBenchConfirmationOnDrop(matchId);
    // Slots have shifted up — queue retroactive react updates so
    // every confirmed player's IN message shows their NEW slot emoji.
    // Idempotent and bounded; bot picks them up on its next 5-min tick.
    await queueSlotEmojiRefresh(matchId);
  }

  return { status: "DROPPED" as const };
}
