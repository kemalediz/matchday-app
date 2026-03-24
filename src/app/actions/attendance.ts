"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export async function attendMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  if (new Date() > match.attendanceDeadline) {
    throw new Error("Attendance deadline has passed");
  }

  // Get next position number
  const maxPos = await db.attendance.aggregate({
    where: { matchId },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  // Determine status based on current confirmed count
  const confirmedCount = await db.attendance.count({
    where: { matchId, status: "CONFIRMED" },
  });

  const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";

  await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId: session.user.id } },
    create: {
      matchId,
      userId: session.user.id,
      status,
      position: nextPosition,
    },
    update: {
      status,
      position: nextPosition,
      respondedAt: new Date(),
    },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}

export async function dropFromMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  if (new Date() > match.attendanceDeadline) {
    throw new Error("Attendance deadline has passed");
  }

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });

  if (!attendance) throw new Error("Not attending this match");

  const wasConfirmed = attendance.status === "CONFIRMED";

  // Mark as dropped
  await db.attendance.update({
    where: { id: attendance.id },
    data: { status: "DROPPED" },
  });

  // If was confirmed, promote first bench player
  if (wasConfirmed) {
    const firstBench = await db.attendance.findFirst({
      where: { matchId, status: "BENCH" },
      orderBy: { position: "asc" },
    });

    if (firstBench) {
      await db.attendance.update({
        where: { id: firstBench.id },
        data: { status: "CONFIRMED" },
      });
    }
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}
