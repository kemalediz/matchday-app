import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ playerId: string }> }
) {
  const { playerId } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const player = await db.user.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      phoneNumber: true,
      activityPositions: {
        select: {
          positions: true,
          activity: {
            select: { id: true, name: true, sportId: true, isActive: true },
          },
        },
      },
    },
  });
  if (!player) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Flatten a `primary activity` view for backward-compat UI that expects `positions: string[]`.
  // Picks the first active activity of the viewer's org.
  const viewerOrg = await getUserOrg(session.user.id);
  let primaryPositions: string[] = [];
  if (viewerOrg) {
    const match = player.activityPositions.find((p) => p.activity.isActive);
    primaryPositions = match?.positions ?? [];
  }

  const matchesPlayed = await db.attendance.count({
    where: { userId: playerId, status: "CONFIRMED", match: { status: "COMPLETED" } },
  });
  const totalMatches = await db.match.count({ where: { status: "COMPLETED" } });

  const ratings = await db.rating.findMany({
    where: { playerId },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const avgRating = ratings.length > 0
    ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length
    : null;

  const momResults = await db.moMVote.groupBy({
    by: ["matchId"],
    where: { playerId },
    _count: true,
  });
  let momWins = 0;
  for (const group of momResults) {
    const topVote = await db.moMVote.groupBy({
      by: ["playerId"],
      where: { matchId: group.matchId },
      _count: { playerId: true },
      orderBy: { _count: { playerId: "desc" } },
      take: 1,
    });
    if (topVote.length > 0 && topVote[0].playerId === playerId) momWins++;
  }

  return NextResponse.json({
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      image: player.image,
      phoneNumber: player.phoneNumber,
      positions: primaryPositions, // back-compat — primary active activity
      activityPositions: player.activityPositions,
    },
    stats: {
      matchesPlayed,
      avgRating,
      momCount: momWins,
      attendanceRate: totalMatches > 0 ? Math.round((matchesPlayed / totalMatches) * 100) : 0,
    },
  });
}
