/**
 * Shared team-generation helper. Called from both the legacy
 * `/api/cron/generate-teams` (which still runs for maintenance — auto-
 * publish + auto-complete) and the LLM analyse route when a player
 * asks the bot to generate teams.
 *
 * Balances the confirmed squad via the Activity's configured strategy
 * (snake-draft + hill-climb, rating-only, etc.), writes TeamAssignment
 * rows, flips the Match into TEAMS_GENERATED, and returns a
 * ready-to-post group message with the Red/Yellow lineup.
 */
import { db } from "./db";
import { balanceTeams, type BalancingStrategy } from "./team-balancer";
import type { PlayerWithRating } from "@/types";
import { formatLondon } from "./london-time";

export type GenerateTeamsResult =
  | { ok: true; groupPost: string; matchId: string }
  | { ok: false; reason: string };

export async function generateTeamsForMatch(matchId: string): Promise<GenerateTeamsResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { include: { activityPositions: true } } },
      },
    },
  });
  if (!match) return { ok: false, reason: "match not found" };
  if (match.status === "COMPLETED" || match.status === "CANCELLED") {
    return { ok: false, reason: `match is ${match.status.toLowerCase()}` };
  }

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  if (match.attendances.length < perTeam * 2) {
    return {
      ok: false,
      reason: `not enough confirmed players — ${match.attendances.length}/${perTeam * 2}`,
    };
  }

  const players: PlayerWithRating[] = await Promise.all(
    match.attendances.map(async (a) => {
      const ratings = await db.rating.findMany({
        where: { playerId: a.userId },
        orderBy: { createdAt: "desc" },
        take: 60,
      });
      const avgRating =
        ratings.length >= 3
          ? ratings.reduce((s, r) => s + r.score, 0) / ratings.length
          : a.user.seedRating ?? 5.0;
      const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        rating: avgRating,
        image: a.user.image,
      };
    }),
  );

  const composition = sport.positionComposition as Record<string, number> | null;
  const result = balanceTeams({
    players,
    perTeam,
    strategy: sport.balancingStrategy as BalancingStrategy,
    composition: composition ?? undefined,
  });

  await db.teamAssignment.deleteMany({ where: { matchId } });
  await db.teamAssignment.createMany({
    data: [
      ...result.red.map((p) => ({ matchId, userId: p.id, team: "RED" as const })),
      ...result.yellow.map((p) => ({ matchId, userId: p.id, team: "YELLOW" as const })),
    ],
  });
  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_GENERATED" },
  });

  const [redLabel, yellowLabel] = sport.teamLabels as [string, string];
  const kickoff = formatLondon(match.date, "HH:mm");
  const listFor = (arr: typeof result.red) =>
    arr.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const groupPost =
    `⚽ *Teams for tonight* — ${kickoff} at ${match.activity.venue}\n\n` +
    `*${redLabel}*:\n${listFor(result.red)}\n\n` +
    `*${yellowLabel}*:\n${listFor(result.yellow)}\n\n` +
    `Objections? Reply \`swap X Y\` — admin will confirm.`;

  return { ok: true, groupPost, matchId };
}
