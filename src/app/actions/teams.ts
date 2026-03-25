"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { balanceTeams } from "@/lib/team-balancer";
import { FORMAT_CONFIG, ADMIN_EMAIL } from "@/lib/constants";
import { PlayerWithRating } from "@/types";
import { revalidatePath } from "next/cache";

async function getPlayerRating(userId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId } });

  // Get recent peer ratings
  const recentRatings = await db.rating.findMany({
    where: { playerId: userId },
    orderBy: { createdAt: "desc" },
    take: 60, // ~20 matches * 3 ratings each
  });

  if (recentRatings.length >= 3) {
    return recentRatings.reduce((sum, r) => sum + r.score, 0) / recentRatings.length;
  }

  return user?.seedRating ?? 5.0;
}

export async function generateTeams(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { attendances: { where: { status: "CONFIRMED" }, include: { user: true } } },
  });
  if (!match) throw new Error("Match not found");

  const perTeam = FORMAT_CONFIG[match.format].perTeam;
  const confirmedPlayers = match.attendances;

  if (confirmedPlayers.length < perTeam * 2) {
    throw new Error(`Need ${perTeam * 2} players, only ${confirmedPlayers.length} confirmed`);
  }

  // Build player ratings
  const players: PlayerWithRating[] = await Promise.all(
    confirmedPlayers.map(async (a) => ({
      id: a.userId,
      name: a.user.name ?? "Unknown",
      positions: a.user.positions,
      rating: await getPlayerRating(a.userId),
      image: a.user.image,
    }))
  );

  const result = balanceTeams(players, perTeam);

  // Clear existing assignments and create new ones
  await db.teamAssignment.deleteMany({ where: { matchId } });

  const assignments = [
    ...result.red.map((p) => ({ matchId, userId: p.id, team: "RED" as const })),
    ...result.yellow.map((p) => ({ matchId, userId: p.id, team: "YELLOW" as const })),
  ];

  await db.teamAssignment.createMany({ data: assignments });

  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_GENERATED" },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function swapPlayers(matchId: string, playerId1: string, playerId2: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  const assignment1 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId1 } },
  });
  const assignment2 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId2 } },
  });

  if (!assignment1 || !assignment2) throw new Error("Players not assigned to teams");
  if (assignment1.team === assignment2.team) throw new Error("Players are on the same team");

  await db.teamAssignment.update({
    where: { id: assignment1.id },
    data: { team: assignment2.team },
  });
  await db.teamAssignment.update({
    where: { id: assignment2.id },
    data: { team: assignment1.team },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function publishTeams(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_PUBLISHED" },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
