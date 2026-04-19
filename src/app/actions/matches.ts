"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { sendRatingEmails } from "@/lib/email";
import { format } from "date-fns";

export async function updateMatchScore(matchId: string, formData: { redScore: number; yellowScore: number }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const parsed = matchScoreSchema.parse(formData);

  const updated = await db.match.update({
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

  const players = updated.attendances.map((a) => ({
    email: a.user.email,
    name: a.user.name,
  }));

  sendRatingEmails(
    matchId,
    updated.activity.name,
    format(updated.date, "EEEE, d MMMM yyyy"),
    players
  ).catch((err) => console.error("Failed to send rating emails:", err));

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
