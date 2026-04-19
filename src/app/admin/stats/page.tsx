import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import { Trophy, Star } from "lucide-react";

export default async function StatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const players = await db.user.findMany({
    where: { memberships: { some: { orgId } } },
    include: {
      ratingsReceived: {
        where: { match: { activity: { orgId } } },
        orderBy: { createdAt: "desc" },
        take: 60,
      },
      momVotesReceived: { where: { match: { activity: { orgId } } } },
      attendances: {
        where: { status: "CONFIRMED", match: { status: "COMPLETED", activity: { orgId } } },
      },
    },
  });

  const playerStats = players
    .map((p) => ({
      ...p,
      avgRating:
        p.ratingsReceived.length > 0
          ? p.ratingsReceived.reduce((sum, r) => sum + r.score, 0) / p.ratingsReceived.length
          : null,
      matchesPlayed: p.attendances.length,
      momVotes: p.momVotesReceived.length,
    }))
    .filter((p) => p.matchesPlayed > 0)
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-800">Player leaderboard</h2>

      {playerStats.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
          No stats yet — come back after your first completed match.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
          {playerStats.map((player, i) => (
            <div key={player.id} className="flex items-center gap-4 px-6 py-4">
              <span className={`w-10 text-center font-bold ${i === 0 ? "text-amber-500" : "text-slate-400"}`}>
                {i === 0 ? <Trophy className="w-6 h-6 mx-auto" /> : i + 1}
              </span>
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
                {(player.name ?? "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-800 truncate">{player.name}</p>
                <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500">
                  <span>{player.matchesPlayed} matches</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-slate-800">
                  {player.avgRating != null ? player.avgRating.toFixed(1) : "—"}
                </p>
                <p className="text-xs text-slate-500 flex items-center justify-end gap-1 mt-0.5">
                  <Star className="w-3 h-3" /> {player.momVotes} MoM
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
