"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { FORMAT_CONFIG, ADMIN_EMAIL } from "@/lib/constants";
import { MatchFormat } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { sendRatingEmails } from "@/lib/email";
import { format } from "date-fns";

export async function updateMatchScore(matchId: string, formData: { redScore: number; yellowScore: number }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

  const parsed = matchScoreSchema.parse(formData);

  const match = await db.match.update({
    where: { id: matchId },
    data: {
      redScore: parsed.redScore,
      yellowScore: parsed.yellowScore,
      status: "COMPLETED",
    },
    include: {
      activity: true,
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { email: true, name: true } } },
      },
    },
  });

  // Send rating notification emails to all confirmed players
  const players = match.attendances.map((a) => ({
    email: a.user.email,
    name: a.user.name,
  }));

  sendRatingEmails(
    matchId,
    match.activity.name,
    format(match.date, "EEEE, d MMMM yyyy"),
    players
  ).catch((err) => console.error("Failed to send rating emails:", err));

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}

export async function switchMatchFormat(matchId: string, format: MatchFormat) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (session.user.email !== ADMIN_EMAIL) throw new Error("Admin only");

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
