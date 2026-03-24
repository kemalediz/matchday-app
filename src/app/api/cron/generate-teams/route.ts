import { db } from "@/lib/db";
import { balanceTeams } from "@/lib/team-balancer";
import { FORMAT_CONFIG } from "@/lib/constants";
import { PlayerWithRating } from "@/types";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find matches past deadline that need team generation
  const matches = await db.match.findMany({
    where: {
      status: "UPCOMING",
      attendanceDeadline: { lte: now },
    },
    include: {
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: true },
      },
    },
  });

  let generated = 0;

  for (const match of matches) {
    const perTeam = FORMAT_CONFIG[match.format].perTeam;
    if (match.attendances.length < perTeam * 2) continue;

    // Build player ratings
    const players: PlayerWithRating[] = await Promise.all(
      match.attendances.map(async (a) => {
        const ratings = await db.rating.findMany({
          where: { playerId: a.userId },
          orderBy: { createdAt: "desc" },
          take: 60,
        });
        const avgRating = ratings.length >= 3
          ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length
          : a.user.seedRating ?? 5.0;

        return {
          id: a.userId,
          name: a.user.name ?? "Unknown",
          positions: a.user.positions,
          rating: avgRating,
          image: a.user.image,
        };
      })
    );

    const result = balanceTeams(players, perTeam);

    await db.teamAssignment.deleteMany({ where: { matchId: match.id } });
    await db.teamAssignment.createMany({
      data: [
        ...result.red.map((p) => ({ matchId: match.id, userId: p.id, team: "RED" as const })),
        ...result.yellow.map((p) => ({ matchId: match.id, userId: p.id, team: "YELLOW" as const })),
      ],
    });

    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_GENERATED" },
    });

    generated++;
  }

  // Auto-publish teams generated more than 1 hour ago
  const autoPublishCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const toPublish = await db.match.findMany({
    where: {
      status: "TEAMS_GENERATED",
      updatedAt: { lte: autoPublishCutoff },
    },
  });

  let published = 0;
  for (const match of toPublish) {
    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_PUBLISHED" },
    });
    published++;
  }

  return NextResponse.json({ generated, published });
}
