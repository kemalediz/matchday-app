import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> }
) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: true,
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { id: true, name: true, image: true, positions: true } } },
        orderBy: { position: "asc" },
      },
      teamAssignments: {
        include: { user: { select: { id: true, name: true, image: true, positions: true } } },
      },
    },
  });

  if (!match) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get existing ratings by this user
  const existingRatings = await db.rating.findMany({
    where: { matchId, raterId: session.user.id },
  });

  const existingMoMVote = await db.moMVote.findUnique({
    where: { matchId_voterId: { matchId, voterId: session.user.id } },
  });

  return NextResponse.json({ ...match, existingRatings, existingMoMVote });
}
