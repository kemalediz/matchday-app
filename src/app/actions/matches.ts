"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { sendRatingEmails } from "@/lib/email";
import { format } from "date-fns";
import { computeEloDeltas } from "@/lib/elo";

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

  // Pull team assignments + current matchRatings so we can compute Elo
  // deltas in the same transaction that persists the score.
  const before = await db.match.findUnique({
    where: { id: matchId },
    include: {
      teamAssignments: {
        include: { user: { select: { id: true, matchRating: true } } },
      },
    },
  });

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

  // Apply Elo updates — only to players who were in teamAssignments, not
  // generic attendees (in case teams were generated but some players never
  // assigned). Fails open: log and continue if something's off.
  try {
    if (before?.teamAssignments?.length) {
      const eloInputs = before.teamAssignments.map((t) => ({
        userId: t.userId,
        team: t.team,
        matchRating: t.user.matchRating,
      }));
      const deltas = computeEloDeltas(eloInputs, parsed.redScore, parsed.yellowScore);
      await db.$transaction(
        deltas.map((d) =>
          db.user.update({
            where: { id: d.userId },
            data: { matchRating: d.after },
          }),
        ),
      );
    }
  } catch (err) {
    console.error("Elo update failed (match will still be COMPLETED):", err);
  }

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
