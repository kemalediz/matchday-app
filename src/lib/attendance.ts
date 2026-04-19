import { db } from "./db";
import { requestBenchConfirmationOnDrop } from "./bot-scheduler";

export async function registerAttendance(userId: string, matchId: string) {
  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  if (new Date() > match.attendanceDeadline) {
    throw new Error("Attendance deadline has passed");
  }

  const maxPos = await db.attendance.aggregate({
    where: { matchId },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  const confirmedCount = await db.attendance.count({
    where: { matchId, status: "CONFIRMED" },
  });

  const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";

  const attendance = await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, status, position: nextPosition },
    update: { status, position: nextPosition, respondedAt: new Date() },
  });

  return {
    status: attendance.status,
    position: attendance.position,
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
  }

  return { status: "DROPPED" as const };
}
