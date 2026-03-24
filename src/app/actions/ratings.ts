"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ratingSchema, momVoteSchema } from "@/lib/validations";
import { revalidatePath } from "next/cache";

export async function submitRatings(matchId: string, formData: { ratings: { playerId: string; score: number }[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = ratingSchema.parse(formData);

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "COMPLETED") throw new Error("Match not completed yet");

  // Check rating window
  const windowEnd = new Date(match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000);
  if (new Date() > windowEnd) throw new Error("Rating window has closed");

  // Check voter attended
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });
  if (!attendance || attendance.status === "DROPPED") {
    throw new Error("Only match participants can rate");
  }

  // Upsert all ratings
  for (const { playerId, score } of parsed.ratings) {
    if (playerId === session.user.id) continue; // Can't rate yourself
    await db.rating.upsert({
      where: {
        matchId_raterId_playerId: { matchId, raterId: session.user.id, playerId },
      },
      create: { matchId, raterId: session.user.id, playerId, score },
      update: { score },
    });
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/matches/${matchId}/rate`);
}

export async function submitMoMVote(matchId: string, formData: { playerId: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = momVoteSchema.parse(formData);

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "COMPLETED") throw new Error("Match not completed yet");

  const windowEnd = new Date(match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000);
  if (new Date() > windowEnd) throw new Error("Rating window has closed");

  // Check voter attended
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });
  if (!attendance || attendance.status === "DROPPED") {
    throw new Error("Only match participants can vote");
  }

  await db.moMVote.upsert({
    where: { matchId_voterId: { matchId, voterId: session.user.id } },
    create: { matchId, voterId: session.user.id, playerId: parsed.playerId },
    update: { playerId: parsed.playerId },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/matches/${matchId}/rate`);
}
