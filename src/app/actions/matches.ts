"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { FORMAT_CONFIG } from "@/lib/constants";
import { MatchFormat } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";

export async function updateMatchScore(matchId: string, formData: { redScore: number; yellowScore: number }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.role !== "ADMIN") throw new Error("Admin only");

  const parsed = matchScoreSchema.parse(formData);

  await db.match.update({
    where: { id: matchId },
    data: {
      redScore: parsed.redScore,
      yellowScore: parsed.yellowScore,
      status: "COMPLETED",
    },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}

export async function switchMatchFormat(matchId: string, format: MatchFormat) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (user?.role !== "ADMIN") throw new Error("Admin only");

  const config = FORMAT_CONFIG[format];

  await db.match.update({
    where: { id: matchId },
    data: { format, maxPlayers: config.maxPlayers },
  });

  // Recompute attendance statuses
  const attendances = await db.attendance.findMany({
    where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
    orderBy: { position: "asc" },
  });

  for (let i = 0; i < attendances.length; i++) {
    const newStatus = i < config.maxPlayers ? "CONFIRMED" : "BENCH";
    if (attendances[i].status !== newStatus) {
      await db.attendance.update({
        where: { id: attendances[i].id },
        data: { status: newStatus as "CONFIRMED" | "BENCH" },
      });
    }
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
